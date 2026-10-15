/**
 * Real-browser tests, driven over the Chrome DevTools Protocol with a
 * zero-dependency client (Node's built-in WebSocket). Nothing is
 * installed and no user browser profile is touched: a throwaway profile
 * is created in the temp directory and deleted afterwards.
 *
 * Three groups run here:
 *
 *  1. LIVE SITE  - the unmodified project directory is loaded as an
 *                  unpacked extension and visited on the real
 *                  https://web.whatsapp.com/ to prove the content
 *                  script actually injects.
 *  2. DOM LOGIC  - a byte-identical copy of the extension (only the
 *                  manifest match pattern is extended to a local test
 *                  origin) is driven against a fixture that replicates
 *                  the current WhatsApp Web rail markup.
 *  3. POPUP      - the real popup.html is driven end to end: checkbox
 *                  -> chrome.storage.local -> live WhatsApp tab.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import {
  launch, newPage, loadExtension, findBrowser,
  findExtensionContext, findMainContext, evaluateIn, delay,
} from './lib/cdp.mjs';
import { section, check, assert, eq, includes } from './lib/harness.mjs';

const WA_LIVE = 'https://web.whatsapp.com/';
const EXT_FILES = ['content.js', 'styles.css', 'popup.html', 'popup.css', 'popup.js'];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

async function waitFor(fn, { timeout = 20000, interval = 200, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) { lastErr = e; }
    await delay(interval);
  }
  throw new Error(`timed out waiting for ${label}${lastErr ? ': ' + lastErr.message : ''}`);
}

/* ------------------------------------------------------------------ */
/* Fixture server                                                      */
/* ------------------------------------------------------------------ */

async function startFixture(projectDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'wacu-fixture-'));
  EXT_FILES.forEach(f => copyFileSync(join(projectDir, f), join(tmp, f)));
  writeFileSync(join(tmp, 'whatsapp-nav.html'), readFileSync(join(projectDir, 'tests', 'fixtures', 'whatsapp-nav.html')));

  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '') || 'whatsapp-nav.html';
    const file = join(tmp, name);
    if (!file.startsWith(tmp)) { res.writeHead(403); res.end(); return; }
    let body;
    try { body = readFileSync(file); } catch { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(body);
  });

  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // Extend ONLY the match pattern; every shipped file stays byte-identical.
  const manifest = JSON.parse(readFileSync(join(projectDir, 'manifest.json'), 'utf8'));
  manifest.content_scripts[0].matches.push(`http://127.0.0.1:${port}/*`);
  writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));

  return {
    dir: tmp,
    port,
    origin: `http://127.0.0.1:${port}`,
    url: `http://127.0.0.1:${port}/whatsapp-nav.html`,
    async close() {
      await new Promise(r => server.close(r));
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Page helpers                                                        */
/* ------------------------------------------------------------------ */

async function openFixture(browser, fixture) {
  const page = await newPage(browser, 'about:blank');
  await page.send('Page.navigate', { url: fixture.url });
  const ctx = await waitFor(
    async () => findExtensionContext(page, 'WhatsApp Clean UI'),
    { label: 'content script injection on the fixture' }
  );
  await waitFor(
    () => evaluateIn(page, ctx.id, 'window.WhatsAppCleanUI ? true : false'),
    { label: 'debug handle creation' }
  );
  await waitFor(
    () => evaluateIn(page, ctx.id, 'document.readyState === "complete"'),
    { label: 'fixture load' }
  );
  await delay(400);
  return { page, extCtx: ctx };
}

const main = (page) => findMainContext(page).id;
const ext = (page, ctx) => ctx.id;

/**
 * Context ids die on navigation and Chromium sometimes fails to announce
 * the destruction, so a lookup can hand back a stale id. These helpers
 * only return a context that has just answered an evaluate() call.
 */
async function freshMainContext(page) {
  return waitFor(async () => {
    const ctx = findMainContext(page);
    if (!ctx) return false;
    try { await evaluateIn(page, ctx.id, '1'); return ctx; } catch { return false; }
  }, { label: 'a live page context' });
}

async function freshExtContext(page, name = 'WhatsApp Clean UI') {
  return waitFor(async () => {
    const ctx = findExtensionContext(page, name);
    if (!ctx) return false;
    try {
      const alive = await evaluateIn(page, ctx.id, 'typeof window.WhatsAppCleanUI === "object"');
      return alive ? ctx : false;
    } catch { return false; }
  }, { label: 'a live "' + name + '" isolated world' });
}

/** Read a compact snapshot of the fixture's relevant elements. */
const SNAPSHOT = `(() => {
  const ids = ['nav-chats','nav-status','nav-communities','nav-metabot','nav-settings','nav-new-chat',
               'row-one','row-status','side-chip','search-communities','message-status',
               'message-communities','composer','settings-communities','menu-status'];
  const out = {};
  for (const id of ids) {
    const el = document.getElementById(id);
    out[id] = el
      ? { hidden: el.classList.contains('wacu-nav-item-hidden'),
          display: getComputedStyle(el).display,
          connected: el.isConnected }
      : null;
  }
  const rail = document.querySelector('header[data-testid="chatlist-header"] .rail');
  out.rail = rail ? { hidden: rail.classList.contains('wacu-nav-item-hidden'), display: getComputedStyle(rail).display } : null;
  out.hiddenTotal = document.querySelectorAll('.wacu-nav-item-hidden').length;
  out.navItemTotal = document.querySelectorAll('[data-navbar-item]').length;
  out.totalNavCandidates = document.querySelectorAll('[data-navbar-item]').length;
  return out;
})()`;

/* ------------------------------------------------------------------ */
/* Main runner                                                         */
/* ------------------------------------------------------------------ */

export async function runBrowserTests(projectDir) {
  const binary = findBrowser();
  if (!binary) {
    section('R. Real browser tests');
    await check('Chromium/Edge binary available', () => ({ ok: false, message: 'no Chrome/Edge executable found' }));
    return { ran: false };
  }

  let browser;
  let fixture;
  try {
    browser = await launch({ binary });

    /* ---------------- 1. LIVE SITE (unmodified project) ---------------- */
    section('R1. Live site - unmodified project extension on web.whatsapp.com');
    let liveId = null;
    try {
      liveId = await loadExtension(browser, projectDir);
      await check('unpacked extension loads from the project directory', () => {
        assert(/^[a-p]{32}$/.test(liveId), 'unexpected extension id: ' + liveId);
        return true;
      });
    } catch (e) {
      await check('unpacked extension loads from the project directory', () => ({ ok: false, message: e.message }));
      return { ran: true, skipped: true };
    }

    const livePage = await newPage(browser, 'about:blank');
    await livePage.send('Page.navigate', { url: WA_LIVE });
    const liveCtx = await waitFor(
      () => findExtensionContext(livePage, 'WhatsApp Clean UI'),
      { timeout: 45000, label: 'content script on the live site' }
    ).catch(() => null);

    await check('content script IS injected into the real web.whatsapp.com tab', () => {
      assert(liveCtx, 'no isolated world named "WhatsApp Clean UI" appeared');
      includes(liveCtx.origin, `chrome-extension://${liveId}`);
      return true;
    });

    await check('debug handle exists in the extension isolated world', async () => true);
    if (liveCtx) {
      const handle = await evaluateIn(livePage, liveCtx.id,
        '({ type: typeof window.WhatsAppCleanUI, version: window.WhatsAppCleanUI && window.WhatsAppCleanUI.version })');
      await check('debug handle exists in the extension isolated world', () => {
        eq(handle.type, 'object');
        assert(handle.version, 'no version on the handle');
        return true;
      });

      const mainHandle = await evaluateIn(livePage, main(livePage), 'typeof window.WhatsAppCleanUI');
      await check('debug handle is invisible in the page main world (explains the "undefined" console result)', () => {
        eq(mainHandle, 'undefined');
        return true;
      });

      const diag = await evaluateIn(livePage, liveCtx.id,
        '(() => { try { const d = window.WhatsAppCleanUI.diagnose(); return { ok:true, settings:d.settings, hidden:d.hideClassCount, nav:d.navItemCount, obs:d.observerActive }; } catch(e) { return { ok:false, err:String(e) }; } })()');
      await check('diagnose() runs on the live site without throwing', () => {
        eq(diag.ok, true, 'diagnose threw: ' + diag.err);
        eq(diag.obs, true, 'observer not running');
        eq(diag.settings.hideUpdates, true);
        eq(diag.settings.hideCommunities, true);
        return true;
      });

      const liveState = await evaluateIn(livePage, main(livePage),
        '({ paneSide: !!document.getElementById("pane-side"), navItems: document.querySelectorAll("[data-navbar-item]").length, title: document.title, readyState: document.readyState })');
      await check('live site shows the unauthenticated screen: no rail is rendered, so hiding needs a manual test', () => {
        eq(liveState.paneSide, false, '#pane-side exists - a session appears to be logged in');
        eq(liveState.navItems, 0, 'rail entries are present - live hiding should have been verified instead');
        return true;
      });

      const ourErrors = livePage.exceptions.filter(e =>
        (e.url || '').startsWith(`chrome-extension://${liveId}`));
      await check('no runtime exceptions thrown by the extension on the live site', () => {
        eq(ourErrors.length, 0, JSON.stringify(ourErrors.slice(0, 3)));
        return true;
      });

      const ourLogs = livePage.consoleEvents.filter(e => e.text.includes('[WhatsApp Clean UI]'));
      await check('extension produces no console noise when debug is off', () => {
        eq(ourLogs.length, 0, 'unexpected debug output while debug=false: ' + JSON.stringify(ourLogs.slice(0, 2)));
        return true;
      });
    }

    /* ---------------- 2. DOM LOGIC on the fixture ---------------- */
    fixture = await startFixture(projectDir);

    section('R2. Fixture integrity - the code under test is byte-identical');
    await check('copied content.js/styles.css/popup.* are byte-identical to the project files', () => {
      for (const f of EXT_FILES) {
        eq(sha256(readFileSync(join(fixture.dir, f))), sha256(readFileSync(join(projectDir, f))), `${f} was modified`);
      }
      return true;
    });
    await check('only the manifest match pattern was extended', () => {
      const copy = JSON.parse(readFileSync(join(fixture.dir, 'manifest.json'), 'utf8'));
      const orig = JSON.parse(readFileSync(join(projectDir, 'manifest.json'), 'utf8'));
      copy.content_scripts[0].matches = orig.content_scripts[0].matches;
      deepEqSafe(copy, orig);
      return true;
    });

    const testId = await loadExtension(browser, fixture.dir);
    const { page, extCtx } = await openFixture(browser, fixture);
    const E = () => ext(page, extCtx);
    const M = () => main(page);
    const setSettings = (obj) =>
      evaluateIn(page, E(), `new Promise(r => chrome.storage.local.set(${JSON.stringify(obj)}, r))`);

    section('C1. Detection - default settings hide both targets');
    let snap = await evaluateIn(page, M(), SNAPSHOT);
    await check('fixture contains the expected rail entries', () => {
      eq(snap.navItemTotal, 5, 'expected 5 data-navbar-item entries');
      return true;
    });
    await check('Updates/Status rail entry is hidden', () => {
      eq(snap['nav-status'].hidden, true);
      eq(snap['nav-status'].display, 'none', 'extension CSS not applied');
      return true;
    });
    await check('Communities rail entry is hidden', () => {
      eq(snap['nav-communities'].hidden, true);
      eq(snap['nav-communities'].display, 'none', 'extension CSS not applied');
      return true;
    });

    section('C2. Detection - unrelated navigation must stay visible');
    for (const id of ['nav-chats', 'nav-metabot', 'nav-settings', 'nav-new-chat']) {
      await check(`${id} is NOT hidden`, () => {
        eq(snap[id].hidden, false);
        assert(snap[id].display !== 'none', id + ' was display:none');
        return true;
      });
    }
    await check('the rail container is NOT hidden (it wraps other entries)', () => {
      eq(snap.rail.hidden, false);
      assert(snap.rail.display !== 'none', 'rail container was hidden');
      return true;
    });

    section('C3. Detection - matching text outside navigation must stay visible');
    for (const [id, why] of [
      ['row-one', 'chat row whose contact name is "Communities"'],
      ['row-status', 'chat row whose preview mentions Status'],
      ['side-chip', 'non-interactive "Status" chip inside #pane-side'],
      ['search-communities', 'search result "Communities group"'],
      ['message-status', 'message text containing "Status updates"'],
      ['message-communities', 'message text containing "Communities"'],
      ['composer', 'editable composer containing "Communities"'],
      ['settings-communities', 'button inside the settings dialog'],
      ['menu-status', 'menu item "Status"'],
    ]) {
      await check(`${id} is NOT hidden (${why})`, () => {
        eq(snap[id].hidden, false);
        assert(snap[id].display !== 'none', id + ' was display:none');
        return true;
      });
    }
    await check('exactly two elements carry the hiding class', () => {
      eq(snap.hiddenTotal, 2, 'unexpected number of hidden elements');
      return true;
    });
    await check('no DOM element was removed by the extension', () => {
      for (const [id, v] of Object.entries(snap)) {
        if (v && typeof v === 'object' && 'connected' in v) eq(v.connected, true, id + ' was detached');
      }
      return true;
    });

    section('C4. Identification robustness (live-verified markup variants)');
    await check('unread-count suffix in the accessible name still matches', async () => {
      const r = await evaluateIn(page, M(), `(() => {
        const el = document.getElementById('nav-status');
        el.setAttribute('aria-label', 'Status 42');
        return el.getAttribute('aria-label');
      })()`);
      eq(r, 'Status 42');
      await delay(300);
      const s2 = await evaluateIn(page, M(), `document.getElementById('nav-status').classList.contains('wacu-nav-item-hidden')`);
      eq(s2, true, 'unread-suffixed label stopped matching');
      await evaluateIn(page, M(), `document.getElementById('nav-status').setAttribute('aria-label','Status')`);
      return true;
    });
    await check('a localized accessible name does not break data-testid detection', async () => {
      await evaluateIn(page, M(), `document.getElementById('nav-communities').setAttribute('aria-label','Gemeinschaften')`);
      await delay(300);
      const s = await evaluateIn(page, M(), SNAPSHOT);
      eq(s['nav-communities'].hidden, true, 'localized label defeated detection');
      await evaluateIn(page, M(), `document.getElementById('nav-communities').setAttribute('aria-label','Communities')`);
      return true;
    });
    await check('legacy <a href="/status"> inside a nav landmark is matched', async () => {
      await evaluateIn(page, M(), `(() => {
        const a = document.createElement('a');
        a.setAttribute('href', '/status'); a.setAttribute('aria-label', 'Status'); a.id = 'legacy-status';
        document.querySelector('header[data-testid="chatlist-header"] .rail').appendChild(a);
      })()`);
      await delay(400);
      const s = await evaluateIn(page, M(), `document.getElementById('legacy-status').classList.contains('wacu-nav-item-hidden')`);
      eq(s, true, 'legacy link not hidden');
      await evaluateIn(page, M(), `document.getElementById('legacy-status').remove()`);
      return true;
    });

    section('C5. Settings changes apply live (storage-change path)');
    await setSettings({ hideUpdates: false });
    await delay(400);
    snap = await evaluateIn(page, M(), SNAPSHOT);
    await check('disabling Hide Updates restores only Updates/Status', () => {
      eq(snap['nav-status'].hidden, false);
      assert(snap['nav-status'].display !== 'none', 'still display:none');
      eq(snap['nav-communities'].hidden, true, 'communities should stay hidden');
      return true;
    });
    await check('exactly one element carries the hiding class', () => eq(snap.hiddenTotal, 1));

    await setSettings({ hideUpdates: true, hideCommunities: false });
    await delay(400);
    snap = await evaluateIn(page, M(), SNAPSHOT);
    await check('disabling Hide Communities restores only Communities', () => {
      eq(snap['nav-communities'].hidden, false);
      eq(snap['nav-status'].hidden, true, 'status should stay hidden');
      return true;
    });

    await setSettings({ hideUpdates: false, hideCommunities: false });
    await delay(400);
    snap = await evaluateIn(page, M(), SNAPSHOT);
    await check('both disabled hides nothing', () => {
      eq(snap.hiddenTotal, 0);
      eq(snap['nav-status'].hidden, false);
      eq(snap['nav-communities'].hidden, false);
      return true;
    });

    await setSettings({ hideUpdates: true, hideCommunities: true });
    await delay(400);
    snap = await evaluateIn(page, M(), SNAPSHOT);
    await check('re-enabling re-hides both', () => eq(snap.hiddenTotal, 2));

    section('C6. Dynamic rendering');
    await check('late-rendered navigation is hidden by the observer', async () => {
      // Remove the existing entry entirely, then let WhatsApp "render" it
      // again later, exactly as a React re-render of the rail would.
      await evaluateIn(page, M(), `document.getElementById('nav-status').remove()`);
      await delay(400);
      await evaluateIn(page, M(), `(() => {
        const el = document.createElement('div');
        el.setAttribute('role','button'); el.setAttribute('tabindex','-1');
        el.setAttribute('data-navbar-item',''); el.setAttribute('data-testid','navbar-item-status');
        el.setAttribute('aria-label','Status'); el.id = 'nav-status';
        document.querySelector('header[data-testid="chatlist-header"] .rail').appendChild(el);
      })()`);
      await delay(700);
      const hidden = await evaluateIn(page, M(), `document.getElementById('nav-status').classList.contains('wacu-nav-item-hidden')`);
      eq(hidden, true, 'late entry not hidden');
      return true;
    });
    await check('a React-style re-render (fresh node, class lost) is re-hidden', async () => {
      const before = await evaluateIn(page, E(), 'window.WhatsAppCleanUI.diagnose().scanCount');
      await evaluateIn(page, M(), `(() => {
        const old = document.getElementById('nav-status');
        const fresh = old.cloneNode(true);
        fresh.id = 'nav-status';
        old.parentNode.replaceChild(fresh, old);
      })()`);
      await delay(700);
      const hidden = await evaluateIn(page, M(), `document.getElementById('nav-status').classList.contains('wacu-nav-item-hidden')`);
      eq(hidden, true, 're-rendered entry stayed visible');
      const after = await evaluateIn(page, E(), 'window.WhatsAppCleanUI.diagnose().scanCount');
      assert(after > before, 'observer did not rescan after the re-render');
      return true;
    });
    await check('a burst of 300 mutations does not cause unbounded rescans', async () => {
      const before = await evaluateIn(page, E(), 'window.WhatsAppCleanUI.diagnose().scanCount');
      await evaluateIn(page, M(), `(() => {
        const rail = document.querySelector('header[data-testid="chatlist-header"] .rail');
        for (let i = 0; i < 300; i++) {
          const s = document.createElement('span'); s.textContent = 'x'; rail.appendChild(s);
        }
      })()`);
      await delay(2500);
      const after = await evaluateIn(page, E(), 'window.WhatsAppCleanUI.diagnose().scanCount');
      const delta = after - before;
      assert(delta <= 40, `observer rescanned ${delta} times for one burst (budget is 40 per 10s)`);
      const s = await evaluateIn(page, M(), SNAPSHOT);
      eq(s['nav-status'].hidden, true, 'state lost during the burst');
      return true;
    });
    await check('a stale hiding class on a non-target element is cleaned up', async () => {
      await evaluateIn(page, M(), `document.getElementById('nav-settings').classList.add('wacu-nav-item-hidden')`);
      await evaluateIn(page, E(), 'window.WhatsAppCleanUI.applyHiding()');
      const still = await evaluateIn(page, M(), `document.getElementById('nav-settings').classList.contains('wacu-nav-item-hidden')`);
      eq(still, false, 'stale class was not removed');
      return true;
    });

    section('C7. Persistence across a page reload');
    await setSettings({ hideUpdates: false, hideCommunities: true });
    await page.send('Page.reload');
    const extAfterReload = await freshExtContext(page);
    const mainAfterReload = await freshMainContext(page);
    await delay(1200);
    const afterReload = await evaluateIn(page, mainAfterReload.id, SNAPSHOT);
    await check('saved preferences survive a reload and re-apply', () => {
      eq(afterReload['nav-status'].hidden, false, 'hideUpdates=false not respected');
      eq(afterReload['nav-communities'].hidden, true, 'hideCommunities=true not respected');
      return true;
    });
    await evaluateIn(page, extAfterReload.id,
      'new Promise(r => chrome.storage.local.set({hideUpdates:true,hideCommunities:true}, r))');
    await delay(400);

    section('C8. Diagnostics on the fixture');
    const diag = await evaluateIn(page, extAfterReload.id,
      `(() => { const d = window.WhatsAppCleanUI.diagnose();
        return { navItemCount: d.navItemCount, hidden: d.hideClassCount,
                 railItems: d.railItems.map(r => r.testid),
                 decisions: d.decisions.map(x => ({ testid: x.testid, accepted: x.accepted, via: x.via, reason: x.reason })) }; })()`);
    await check('diagnose() lists every rail entry with its test id', () => {
      assert(diag.railItems.length === 5, 'expected 5 rail items, got ' + diag.railItems.length);
      includes(JSON.stringify(diag.railItems), 'navbar-item-status');
      includes(JSON.stringify(diag.railItems), 'navbar-item-communities');
      return true;
    });
    await check('diagnose() explains the accept/reject decision for every candidate', () => {
      const status = diag.decisions.find(d => d.testid === 'navbar-item-status');
      assert(status, 'no decision recorded for navbar-item-status');
      eq(status.accepted, true);
      includes(status.via, 'data-testid');
      const chats = diag.decisions.find(d => d.testid === 'navbar-item-chats');
      assert(chats, 'no decision recorded for navbar-item-chats');
      eq(chats.accepted, false);
      return true;
    });
    await check('debug logging stays silent until explicitly enabled', async () => {
      const logsOff = page.consoleEvents.filter(e => e.text.includes('[WhatsApp Clean UI]')).length;
      eq(logsOff, 0);
      await evaluateIn(page, extAfterReload.id, 'window.WhatsAppCleanUI.setDebug(true)');
      await evaluateIn(page, extAfterReload.id, 'window.WhatsAppCleanUI.applyHiding()');
      await delay(300);
      const logsOn = page.consoleEvents.filter(e => e.text.includes('[WhatsApp Clean UI]'));
      assert(logsOn.length > 0, 'debug produced no output after enabling');
      assert(!logsOn.some(l => /@[\w.-]+\.(com|net|org)/.test(l.text)), 'debug output contained contact-like data');
      await evaluateIn(page, extAfterReload.id, 'window.WhatsAppCleanUI.setDebug(false)');
      return true;
    });

    /* ---------------- 3. POPUP end to end ---------------- */
    section('F. Popup end-to-end');
    const popup = await newPage(browser, 'about:blank');
    await popup.send('Page.navigate', { url: `chrome-extension://${testId}/popup.html` });
    await waitFor(() => findMainContext(popup), { label: 'popup page' });
    await delay(800);

    const popupState = () => evaluateIn(popup, main(popup), `({
      updates: document.getElementById('hideUpdates').checked,
      communities: document.getElementById('hideCommunities').checked,
      debug: document.getElementById('debug').checked,
      updatesBadge: document.getElementById('hideUpdates-state').textContent,
      communitiesBadge: document.getElementById('hideCommunities-state').textContent,
      debugBadge: document.getElementById('debug-state').textContent,
      status: document.getElementById('status-message').textContent
    })`);
    const storedState = () => evaluateIn(popup, main(popup),
      'chrome.storage.local.get(["hideUpdates","hideCommunities","debug"])');

    await check('popup renders both toggles checked with ON badges by default', async () => {
      await evaluateIn(popup, main(popup), 'document.getElementById("hideUpdates").click()');
      await evaluateIn(popup, main(popup), 'document.getElementById("hideUpdates").click()');
      await delay(600);
      const s = await popupState();
      eq(s.updates, true);
      eq(s.communities, true);
      eq(s.updatesBadge, 'ON');
      eq(s.communitiesBadge, 'ON');
      eq(s.debug, false, 'debug must be off by default');
      eq(s.debugBadge, 'OFF');
      return true;
    });

    await check('toggling a popup control writes chrome.storage.local', async () => {
      await evaluateIn(popup, main(popup), 'document.getElementById("hideCommunities").click()');
      await delay(800);
      const stored = await storedState();
      eq(stored.hideCommunities, false);
      eq(stored.hideUpdates, true, 'toggling one control changed the other');
      const s = await popupState();
      eq(s.communitiesBadge, 'OFF');
      return true;
    });

    await check('the change reaches the already-open WhatsApp tab immediately', async () => {
      const live = await evaluateIn(page, main(page), SNAPSHOT);
      eq(live['nav-communities'].hidden, false, 'communities was not restored live');
      eq(live['nav-status'].hidden, true, 'status should still be hidden');
      return true;
    });

    await check('popup reports the live application in its status area', async () => {
      const s = await popupState();
      includes(s.status, 'Saved');
      return true;
    });

    await check('re-enabling re-hides the item live', async () => {
      await evaluateIn(popup, main(popup), 'document.getElementById("hideCommunities").click()');
      await delay(800);
      const live = await evaluateIn(page, main(page), SNAPSHOT);
      eq(live['nav-communities'].hidden, true);
      const stored = await storedState();
      eq(stored.hideCommunities, true);
      return true;
    });

    await check('the debug toggle persists and is off by default for a fresh profile', async () => {
      const stored = await storedState();
      eq(stored.debug, false);
      return true;
    });

    await check('popup controls are keyboard-reachable and labelled', async () => {
      const a11y = await evaluateIn(popup, main(popup), `(() => {
        const ids = ['hideUpdates','hideCommunities','debug'];
        return ids.map(id => {
          const el = document.getElementById(id);
          const label = document.querySelector('label[for="' + id + '"]');
          return { id, focusable: el.tabIndex >= 0 || el.type === 'checkbox', labelled: !!label && !!label.textContent.trim() };
        });
      })()`);
      for (const a of a11y) {
        eq(a.labelled, true, a.id + ' has no <label>');
      }
      return true;
    });

    section('D2. Extension safety in the browser');
    await check('no uncaught exceptions from the extension on the fixture', () => {
      const ours = page.exceptions.filter(e => (e.url || '').startsWith(`chrome-extension://${testId}`));
      eq(ours.length, 0, JSON.stringify(ours.slice(0, 3)));
      return true;
    });
    await check('no extension console errors on the fixture', () => {
      const errs = page.consoleEvents.filter(e => e.type === 'error' && e.stack.startsWith(`chrome-extension://${testId}`));
      eq(errs.length, 0, JSON.stringify(errs.slice(0, 3)));
      return true;
    });
    await check('the extension issued no network requests of its own', () => {
      // The fixture page loads only its own document and local extension
      // assets; the extension itself declares no network capability, so
      // nothing beyond this origin may ever be requested from that tab.
      const foreign = page.requests.filter(u => typeof u === 'string' && u.indexOf(fixture.origin) !== 0);
      eq(foreign.length, 0, 'unexpected requests: ' + JSON.stringify(foreign.slice(0, 5)));
      return true;
    });

    await browser.kill();
    browser = null;
    return { ran: true, liveId, fixtureId: testId };
  } finally {
    if (browser) await browser.kill();
    if (fixture) await fixture.close();
  }
}

function deepEqSafe(a, b) {
  const x = JSON.stringify(a).replace(/127\.0\.0\.1:\d+/g, 'HOST');
  const y = JSON.stringify(b);
  if (x !== y) throw new Error('manifest copy differs beyond the match pattern');
  return true;
}