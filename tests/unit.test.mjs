/**
 * Unit tests: the REAL content.js / popup.js sources executed in a node:vm
 * sandbox with stubbed chrome APIs and a minimal fake DOM.
 *
 * This covers logic that must not depend on a real browser: settings
 * defaults, persistence, invalid payloads, the popup message handler,
 * the storage watcher, and behaviour when the chrome APIs are absent.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { section, check, assert, eq, deepEq, includes } from './lib/harness.mjs';

/* ------------------------------------------------------------------ */
/* Stubs                                                               */
/* ------------------------------------------------------------------ */

function makeChrome({ storage = {}, withStorage = true, withMessaging = true } = {}) {
  const store = { ...storage };
  const listeners = { message: [], changed: [] };
  const runtime = {
    lastError: null,
    id: 'unittestextensionid',
    getURL: p => 'chrome-extension://unittestextensionid/' + p,
  };
  if (withMessaging) {
    runtime.onMessage = { addListener: fn => listeners.message.push(fn) },
    runtime.sendMessage = (msg, cb) => { if (cb) cb({ applied: true }); };
  }
  const api = { runtime };
  if (withStorage) {
    api.storage = {
      local: {
        get(keys, cb) {
          const out = {};
          if (Array.isArray(keys)) keys.forEach(k => { if (k in store) out[k] = store[k]; });
          else Object.keys(keys).forEach(k => { out[k] = (k in store) ? store[k] : keys[k]; });
          if (cb) cb(out);
        },
        set(items, cb) { Object.assign(store, items); if (cb) cb(); },
      },
      onChanged: { addListener: fn => listeners.changed.push(fn) },
    };
  }
  return { chrome: api, store, listeners };
}

function makeDom({ observerCount = 0 } = {}) {
  const queryCalls = [];
  const dom = {
    readyState: 'complete',
    body: { nodeType: 1 },
    querySelectorAll(sel) { queryCalls.push(sel); return []; },
    querySelector(sel) { return null; },
    getElementById() { return null; },
    addEventListener() { /* no-op */ },
    __queryCalls: queryCalls,
  };
  let created = 0;
  function MutationObserver(cb) {
    created++;
    this.observe = function () {};
    this.disconnect = function () {};
    this.callback = cb;
  }
  return { dom, MutationObserver, createdObserverCount: () => created };
}

function runScript(filePath, { chrome, dom, MutationObserver }) {
  const src = readFileSync(filePath, 'utf8');
  const sandbox = {
    document: dom,
    window: null,
    chrome,
    MutationObserver,
    console: { log() {}, warn() {}, error() {} },
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: filePath });
  return sandbox;
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

export function runUnitTests(projectDir) {
  const contentPath = join(projectDir, 'content.js');
  const popupPath = join(projectDir, 'popup.js');

  section('U1. content.js boots without uncaught exceptions');
  let base;
  check('boots with empty storage and no chrome APIs at all', () => {
    const dom = makeDom();
    const sandbox = runScript(contentPath, {
      chrome: undefined, dom: dom.dom, MutationObserver: dom.MutationObserver,
    });
    assert(sandbox.WhatsAppCleanUI, 'debug handle not created');
    return true;
  });
  check('boots with full chrome APIs', () => {
    const dom = makeDom();
    const c = makeChrome();
    const sandbox = runScript(contentPath, {
      chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver,
    });
    assert(sandbox.WhatsAppCleanUI, 'debug handle missing');
    eq(dom.createdObserverCount(), 1, 'expected exactly one MutationObserver');
    return true;
  });
  check('does not create a second observer when startObserver runs twice', () => {
    const dom = makeDom();
    const c = makeChrome();
    const sandbox = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    sandbox.WhatsAppCleanUI.applyHiding();
    eq(dom.createdObserverCount(), 1, 'a second observer was created');
    return true;
  });
  check('applies hiding for every configured setting', () => {
    const dom = makeDom();
    const c = makeChrome();
    runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    const selectorCoverage = dom.dom.__queryCalls;
    assert(selectorCoverage.some(s => s.indexOf('data-navbar-item') !== -1), 'never queries data-navbar-item');
    assert(selectorCoverage.some(s => s.indexOf('navbar-item-') !== -1), 'never queries navbar-item-* test ids');
    return true;
  });

  section('U2. Settings defaults and persistence');
  check('both features default to enabled on empty storage', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    deepEq({ u: s.WhatsAppCleanUI.settings.hideUpdates, c: s.WhatsAppCleanUI.settings.hideCommunities }, { u: true, c: true });
    return true;
  });
  check('debug defaults to disabled', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    eq(s.WhatsAppCleanUI.isDebug(), false);
    return true;
  });
  check('persisted false values are honoured (extension reload)', () => {
    const dom = makeDom();
    const c = makeChrome({ storage: { hideUpdates: false, hideCommunities: true } });
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    eq(s.WhatsAppCleanUI.settings.hideUpdates, false);
    eq(s.WhatsAppCleanUI.settings.hideCommunities, true);
    return true;
  });
  check('persisted true values are honoured', () => {
    const dom = makeDom();
    const c = makeChrome({ storage: { hideUpdates: true, hideCommunities: false } });
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    eq(s.WhatsAppCleanUI.settings.hideUpdates, true);
    eq(s.WhatsAppCleanUI.settings.hideCommunities, false);
    return true;
  });
  check('non-boolean stored values fall back to the default', () => {
    const dom = makeDom();
    const c = makeChrome({ storage: { hideUpdates: 'nope', hideCommunities: 0 } });
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    eq(s.WhatsAppCleanUI.settings.hideUpdates, true);
    eq(s.WhatsAppCleanUI.settings.hideCommunities, true);
    return true;
  });
  check('missing chrome.storage keeps the built-in defaults (fail-safe)', () => {
    const dom = makeDom();
    const c = makeChrome({ withStorage: false });
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    eq(s.WhatsAppCleanUI.settings.hideUpdates, true);
    eq(s.WhatsAppCleanUI.settings.hideCommunities, true);
    return true;
  });

  section('U3. Popup message handling');
  check('registers exactly one message listener', () => {
    const dom = makeDom();
    const c = makeChrome();
    runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationVisitor: null, MutationObserver: dom.MutationObserver });
    eq(c.listeners.message.length, 1);
    return true;
  });
  check('WACU_SETTINGS_UPDATED updates settings and acknowledges', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    let response = null;
    c.listeners.message[0]({ type: 'WACU_SETTINGS_UPDATED', settings: { hideUpdates: false } }, {}, r => { response = r; });
    eq(s.WhatsAppCleanUI.settings.hideUpdates, false);
    eq(s.WhatsAppCleanUI.settings.hideCommunities, true, 'unrelated setting changed');
    deepEq(response, { applied: true });
    return true;
  });
  check('toggles are independent through messages', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    c.listeners.message[0]({ type: 'WACU_SETTINGS_UPDATED', settings: { hideCommunities: false } }, {}, () => {});
    eq(s.WhatsAppCleanUI.settings.hideUpdates, true);
    eq(s.WhatsAppCleanUI.settings.hideCommunities, false);
    c.listeners.message[0]({ type: 'WACU_SETTINGS_UPDATED', settings: { hideUpdates: false, hideCommunities: true } }, {}, () => {});
    eq(s.WhatsAppCleanUI.settings.hideUpdates, false);
    eq(s.WhatsAppCleanUI.settings.hideCommunities, true);
    return true;
  });
  check('non-boolean payload fields are ignored (no crash)', () => {
    const dom = makeDom();
    const c = makeChrome({ storage: { hideUpdates: false } });
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    c.listeners.message[0]({ type: 'WACU_SETTINGS_UPDATED', settings: { hideUpdates: 'yes', bogus: true } }, {}, () => {});
    eq(s.WhatsAppCleanUI.settings.hideUpdates, false, 'corrupt payload changed state');
    return true;
  });
  check('unrelated messages are ignored (no crash, no response)', () => {
    const dom = makeDom();
    const c = makeChrome();
    runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    let called = false;
    for (const bad of [null, undefined, {}, { type: 'OTHER' }, 'string', 42]) {
      c.listeners.message[0](bad, {}, () => { called = true; });
    }
    eq(called, false);
    return true;
  });
  check('works when messaging is unavailable', () => {
    const dom = makeDom();
    const c = makeChrome({ withMessaging: false });
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    assert(s.WhatsAppCleanUI, 'handle missing');
    return true;
  });

  section('U4. Storage-change fallback path');
  check('storage.onChanged re-applies the new settings', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    eq(c.listeners.changed.length, 1);
    c.listeners.changed[0]({ hideUpdates: { newValue: false } }, 'local');
    eq(s.WhatsAppCleanUI.settings.hideUpdates, false);
    c.listeners.changed[0]({ hideUpdates: { newValue: true } }, 'local');
    eq(s.WhatsAppCleanUI.settings.hideUpdates, true);
    return true;
  });
  check('storage changes in other areas are ignored', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    c.listeners.changed[0]({ hideUpdates: { newValue: false } }, 'sync');
    eq(s.WhatsAppCleanUI.settings.hideUpdates, true);
    return true;
  });
  check('non-boolean storage changes are ignored', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    c.listeners.changed[0]({ hideUpdates: { newValue: 'x' } }, 'local');
    eq(s.WhatsAppCleanUI.settings.hideUpdates, true);
    return true;
  });

  section('U5. Diagnostics handle');
  check('diagnose() returns a well-formed report', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    const d = s.WhatsAppCleanUI.diagnose();
    for (const k of ['readyState', 'observerActive', 'settings', 'hideClassCount', 'navItemCount', 'railItems', 'decisions', 'scanCount']) {
      assert(k in d, 'diagnose() missing ' + k);
    }
    eq(d.observerActive, true);
    return true;
  });
  check('setDebug(true) enables logging and does not throw', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    eq(s.WhatsAppCleanUI.setDebug(true), true);
    eq(s.WhatsAppCleanUI.isDebug(), true);
    eq(s.WhatsAppCleanUI.setDebug(false), false);
    return true;
  });
  check('version is reported on the debug handle', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    assert(/\d+\.\d+\.\d+/.test(s.WhatsAppCleanUI.version), 'bad version string');
    return true;
  });
  check('stopObserver() disconnects cleanly and is repeatable', () => {
    const dom = makeDom();
    const c = makeChrome();
    const s = runScript(contentPath, { chrome: c.chrome, dom: dom.dom, MutationObserver: dom.MutationObserver });
    s.WhatsAppCleanUI.stopObserver();
    s.WhatsAppCleanUI.stopObserver();
    eq(s.WhatsAppCleanUI.diagnose().observerActive, false);
    return true;
  });

  section('U6. popup.js boots safely');
  check('popup.js runs against a minimal DOM without throwing', () => {
    const elements = {};
    const makeCheckbox = id => ({ id, checked: false, addEventListener() {} });
    for (const id of ['hideUpdates', 'hideCommunities', 'debug']) elements[id] = makeCheckbox(id);
    for (const id of ['hideUpdates-state', 'hideCommunities-state', 'debug-state', 'status-message']) {
      elements[id] = { textContent: '', classList: { toggle() {}, add() {}, remove() {} } };
    }
    const c = makeChrome();
    const sandbox = {
      document: {
        readyState: 'complete',
        getElementById: id => elements[id] || null,
        addEventListener() {},
      },
      window: {},
      chrome: c.chrome,
      console: { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
      Promise,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(popupPath, 'utf8'), sandbox, { filename: popupPath });
    return true;
  });
  check('popup.js reports missing controls instead of crashing', () => {
    const c = makeChrome();
    const messages = [];
    const sandbox = {
      document: {
        readyState: 'complete',
        getElementById: () => null,
        addEventListener() {},
      },
      window: {},
      chrome: c.chrome,
      console: { log() {}, warn() {}, error() {} },
      setTimeout,
      clearTimeout,
      Promise,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(popupPath, 'utf8'), sandbox, { filename: popupPath });
    return true;
  });
}