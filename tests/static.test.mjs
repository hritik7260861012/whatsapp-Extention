/**
 * Static checks: manifest validity, file integrity, permissions,
 * cross-file consistency and source-level safety review.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { section, check, assert, eq, deepEq, includes, notIncludes } from './lib/harness.mjs';

export function runStaticTests(projectDir) {
  const read = f => readFileSync(join(projectDir, f), 'utf8');

  const manifestRaw = read('manifest.json');
  const manifest = JSON.parse(manifestRaw);
  const contentJs = read('content.js');
  const popupJs = read('popup.js');
  const popupHtml = read('popup.html');
  const stylesCss = read('styles.css');
  const popupCss = read('popup.css');

  section('A1. Manifest structure');
  check('manifest.json parses as valid JSON', () => {
    assert(typeof manifest === 'object' && manifest !== null, 'not an object');
    return true;
  });
  check('manifest_version is 3', () => eq(manifest.manifest_version, 3));
  check('name is "WhatsApp Clean UI"', () => eq(manifest.name, 'WhatsApp Clean UI'));
  check('version is a semver-like string', () => assert(/^\d+(\.\d+){0,3}$/.test(manifest.version), 'bad version'));
  check('action.default_popup is popup.html', () => eq(manifest.action && manifest.action.default_popup, 'popup.html'));
  check('popup.html exists on disk', () => assert(existsSync(join(projectDir, 'popup.html')), 'missing'));

  section('A2. Content script registration');
  const cs = (manifest.content_scripts || [])[0];
  check('exactly one content script is registered', () => eq((manifest.content_scripts || []).length, 1));
  check('matches exactly ["https://web.whatsapp.com/*"]', () => eq(JSON.stringify(cs.matches), JSON.stringify(['https://web.whatsapp.com/*'])));
  check('js references content.js', () => eq(JSON.stringify(cs.js), JSON.stringify(['content.js'])));
  check('css references styles.css', () => eq(JSON.stringify(cs.css), JSON.stringify(['styles.css'])));
  check('content.js exists on disk', () => assert(existsSync(join(projectDir, 'content.js')), 'missing'));
  check('styles.css exists on disk', () => assert(existsSync(join(projectDir, 'styles.css')), 'missing'));
  check('run_at is document_idle', () => eq(cs.run_at, 'document_idle'));
  check('all_frames is false (top frame only)', () => eq(cs.all_frames, false));
  check('no background/service worker is declared', () => assert(!manifest.background, 'unexpected background key'));

  section('A2b. Icons');
  const iconMap = manifest.icons || {};
  check('manifest declares the four standard icon sizes', () => {
    for (const size of ['16', '32', '48', '128']) {
      assert(iconMap[size], 'icons.' + size + ' missing');
    }
    return true;
  });
  for (const size of ['16', '32', '48', '128']) {
    check(`icons/icon${size}.png exists on disk`, () => {
      const rel = iconMap[size];
      assert(typeof rel === 'string', `icons.${size} is not a string`);
      assert(/^icons\/[\w.-]+\.png$/.test(rel), `icons.${size} must stay inside icons/ and be a .png, got ${rel}`);
      assert(existsSync(join(projectDir, rel)), rel + ' is referenced but missing on disk');
      return true;
    });
  }
  check('action.default_icon mirrors the top-level icons map', () => {
    const def = (manifest.action && manifest.action.default_icon) || {};
    deepEq(def, iconMap, 'default_icon differs from icons');
    return true;
  });
  check('every icon file is a real, non-empty PNG', () => {
    for (const size of ['16', '32', '48', '128']) {
      const file = join(projectDir, iconMap[size]);
      const buf = readFileSync(file);
      const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      assert(buf.subarray(0, 8).equals(sig), `icon${size} is not a PNG`);
      assert(buf.length > 100, `icon${size} is suspiciously small (${buf.length} bytes)`);
      assert(buf.readUInt32BE(16) === Number(size), `icon${size} reports width ${buf.readUInt32BE(16)}`);
      assert(buf.readUInt32BE(20) === Number(size), `icon${size} reports height ${buf.readUInt32BE(20)}`);
    }
    return true;
  });
  check('icons do not bloat the packaged extension', () => {
    const total = ['16', '32', '48', '128'].reduce((n, s) => n + readFileSync(join(projectDir, iconMap[s])).length, 0);
    assert(total < 500 * 1024, `icons total ${(total / 1024).toFixed(0)} KB; expected < 500 KB`);
    return true;
  });

  section('A3. Permissions and privacy surface');
  check('permissions are exactly ["storage"]', () => eq(JSON.stringify(manifest.permissions), JSON.stringify(['storage'])));
  check('no "tabs" permission', () => notIncludes(JSON.stringify(manifest.permissions), 'tabs'));
  check('no host_permissions key', () => assert(manifest.host_permissions === undefined, 'host_permissions present'));
  check('no optional_permissions key', () => assert(manifest.optional_permissions === undefined, 'optional_permissions present'));
  check('no <all_urls> anywhere in manifest', () => notIncludes(manifestRaw, '<all_urls>'));
  check('no remote code / CSP override', () => assert(manifest.content_security_policy === undefined, 'CSP key present'));
  check('no web_accessible_resources', () => assert(manifest.web_accessible_resources === undefined, 'WAR present'));
  check('no externally_connectable', () => assert(manifest.externally_connectable === undefined, 'externally_connectable present'));
  check('no other http(s) origin is referenced in the manifest', () => {
    const hosts = manifestRaw.match(/https?:\/\/[^\s"']+/g) || [];
    for (const h of hosts) includes(h, 'web.whatsapp.com', 'unexpected origin: ' + h);
    return true;
  });

  section('B1. JavaScript syntax');
  check('content.js passes node --check', () => {
    execFileSync(process.execPath, ['--check', join(projectDir, 'content.js')], { stdio: 'pipe' });
    return true;
  });
  check('popup.js passes node --check', () => {
    execFileSync(process.execPath, ['--check', join(projectDir, 'popup.js')], { stdio: 'pipe' });
    return true;
  });

  section('B2. Cross-file consistency');
  check('hiding class matches between content.js and styles.css', () => {
    const m = contentJs.match(/HIDE_CLASS\s*=\s*'([^']+)'/);
    assert(m, 'HIDE_CLASS not found in content.js');
    includes(stylesCss, '.' + m[1], 'styles.css is missing the class');
    return true;
  });
  check('styles.css actually hides with display:none !important', () => {
    const m = contentJs.match(/HIDE_CLASS\s*=\s*'([^']+)'/);
    const rule = new RegExp('\\.' + m[1] + '\\s*\\{[^}]*display:\\s*none\\s*!important');
    assert(rule.test(stylesCss), 'no display:none !important rule');
    return true;
  });
  check('message type identical in content.js and popup.js', () => {
    const a = contentJs.match(/WACU_SETTINGS_UPDATED/g) || [];
    const b = popupJs.match(/WACU_SETTINGS_UPDATED/g) || [];
    assert(a.length > 0 && b.length > 0, 'message name missing');
    includes(contentJs, "'WACU_SETTINGS_UPDATED'");
    includes(popupJs, "'WACU_SETTINGS_UPDATED'");
    return true;
  });
  check('storage keys identical in content.js and popup.js', () => {
    for (const key of ['hideUpdates', 'hideCommunities', 'debug']) {
      includes(contentJs, key, 'content.js missing ' + key);
      includes(popupJs, key, 'popup.js missing ' + key);
    }
    return true;
  });
  check('popup.html declares an element for every storage key', () => {
    const keys = (popupJs.match(/DEFAULTS\s*=\s*\{([^}]+)\}/) || ['', ''])[1]
      .split(',').map(s => s.split(':')[0].trim()).filter(Boolean);
    assert(keys.length >= 3, 'could not parse popup.js DEFAULTS');
    for (const k of keys) {
      assert(new RegExp('id="' + k + '"').test(popupHtml), 'popup.html missing #' + k);
      assert(new RegExp('for="' + k + '"').test(popupHtml), 'popup.html missing <label for="' + k + '">');
      assert(new RegExp('id="' + k + '-state"').test(popupHtml), 'popup.html missing #' + k + '-state');
    }
    return true;
  });
  check('popup.html references only local assets', () => {
    const urls = popupHtml.match(/(?:src|href)="([^"]+)"/g) || [];
    for (const u of urls) notIncludes(u, 'http://');
    for (const u of urls) notIncludes(u, 'https://');
    return true;
  });

  section('B3. content.js source review');
  check('reads chrome.storage.local', () => includes(contentJs, 'chrome.storage.local'));
  check('registers a runtime.onMessage listener', () => includes(contentJs, 'chrome.runtime.onMessage.addListener'));
  check('registers a storage.onChanged watcher', () => includes(contentJs, 'chrome.storage.onChanged.addListener'));
  check('detects WhatsApp nav items via the data-navbar-item contract', () => includes(contentJs, 'data-navbar-item'));
  check('detects nav items via the navbar-item-* test id', () => includes(contentJs, 'navbar-item-status'));
  check('targets the Communities test id', () => includes(contentJs, 'navbar-item-communities'));
  check('applies the hide class only via classList (no removal)', () => {
    includes(contentJs, 'classList.add(HIDE_CLASS)');
    includes(contentJs, 'classList.remove(HIDE_CLASS)');
    notIncludes(contentJs, '.remove()');
    notIncludes(contentJs, 'removeChild');
    notIncludes(contentJs, '.replaceWith');
    notIncludes(contentJs, 'outerHTML =');
    notIncludes(contentJs, 'innerHTML =');
    return true;
  });
  check('never removes elements or re-orders children', () => {
    notIncludes(contentJs, 'parentNode.');
    notIncludes(contentJs, 'insertBefore');
    notIncludes(contentJs, 'appendChild');
    return true;
  });
  check('MutationObserver is guarded, debounced and disconnectable', () => {
    includes(contentJs, 'new MutationObserver');
    includes(contentJs, 'observer.disconnect()');
    includes(contentJs, 'SCAN_DEBOUNCE_MS');
    includes(contentJs, 'childList: true');
    notIncludes(contentJs, 'attributes: true');
    return true;
  });
  check('has a bounded scan budget (burst protection)', () => includes(contentJs, 'BURST_MAX_SCANS'));
  check('guards chrome API availability', () => {
    includes(contentJs, "typeof chrome === 'undefined'");
    includes(contentJs, 'chrome.storage.onChanged');
    return true;
  });
  check('exposes a diagnostics API', () => includes(contentJs, 'diagnose'));
  check('debug logging is gated and prefixed', () => {
    includes(contentJs, "const LOG_PREFIX = '[WhatsApp Clean UI]'");
    includes(contentJs, 'if (!debugEnabled) return;');
    return true;
  });

  section('B4. popup.js source review');
  check('reads and writes chrome.storage.local', () => {
    includes(popupJs, 'chrome.storage.local.get');
    includes(popupJs, 'chrome.storage.local.set');
    return true;
  });
  check('checks chrome.runtime.lastError', () => {
    includes(popupJs, 'chrome.runtime.lastError');
    return true;
  });
  check('bounds message delivery with a timeout', () => {
    includes(popupJs, 'MESSAGE_TIMEOUT_MS');
    includes(popupJs, 'clearTimeout(timer)');
    return true;
  });
  check('serializes updates through a queue', () => includes(popupJs, 'applyQueue'));
  check('handles unexpected errors without breaking the queue', () => {
    includes(popupJs, '.catch(function ()');
    return true;
  });

  section('D1. Safety / privacy source review');
  const forbidden = [
    ['eval(', 'eval'], ['new Function(', 'new Function'],
    ['fetch(', 'fetch'], ['XMLHttpRequest', 'XMLHttpRequest'],
    ['WebSocket', 'WebSocket'], ['sendBeacon', 'sendBeacon'],
    ['chrome.tabs', 'chrome.tabs'], ['chrome.cookies', 'chrome.cookies'],
    ['chrome.history', 'chrome.history'], ['chrome.webRequest', 'chrome.webRequest'],
    ['chrome.downloads', 'chrome.downloads'], ['chrome.bookmarks', 'chrome.bookmarks'],
    ['navigator.clipboard', 'clipboard'], ['document.cookie', 'cookie'],
    ['localStorage', 'localStorage'], ['sessionStorage', 'sessionStorage'],
    ['indexedDB', 'indexedDB'], ['Notification', 'Notification'],
  ];
  for (const [needle, label] of forbidden) {
    check(`content.js does not use ${label}`, () => notIncludes(contentJs, needle, label));
    check(`popup.js does not use ${label}`, () => notIncludes(popupJs, needle, label));
  }
  check('content.js only reads textContent inside the accessible-name helper', () => {
    const occurrences = contentJs.split('textContent').length - 1;
    assert(occurrences <= 2, `textContent used ${occurrences} times; expected <= 2 (accessible name only)`);
    return true;
  });
  check('no inline event handlers in popup.html', () => {
    notIncludes(popupHtml, 'onclick=');
    notIncludes(popupHtml, 'onchange=');
    return true;
  });
  check('popup.css contains no remote URLs', () => {
    notIncludes(popupCss, 'http://');
    notIncludes(popupCss, 'https://');
    notIncludes(popupCss, '@import');
    return true;
  });
  check('styles.css overrides nothing except the extension class', () => {
    const selectors = stylesCss.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('}').map(s => s.split('{')[0].trim()).filter(Boolean);
    assert(selectors.length === 1, 'unexpected number of rules: ' + selectors.length);
    includes(selectors[0], 'wacu-nav-item-hidden');
    return true;
  });
}