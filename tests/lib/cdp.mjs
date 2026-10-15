/**
 * Zero-dependency Chrome DevTools Protocol driver for the test suite.
 * Uses Node's built-in WebSocket (Node >= 22) and fetch. No npm packages.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const CANDIDATE_BROWSERS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

export function findBrowser(explicit) {
  const list = explicit ? [explicit, ...CANDIDATE_BROWSERS] : CANDIDATE_BROWSERS;
  for (const b of list) if (b && existsSync(b)) return b;
  return null;
}

export async function launch({ binary, headless = true } = {}) {
  const port = 9200 + Math.floor(Math.random() * 600);
  const profile = mkdtempSync(join(tmpdir(), 'wacu-profile-'));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-sandbox',
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  args.push('about:blank');

  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', d => { stderr += d.toString(); });
  let exited = false;
  child.on('exit', () => { exited = true; });

  const deadline = Date.now() + 30000;
  let version = null;
  while (Date.now() < deadline && !exited) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch { /* not up yet */ }
    await delay(200);
  }
  if (!version) {
    child.kill();
    throw new Error(`Browser did not expose a CDP endpoint.\n${stderr.slice(-2000)}`);
  }

  const browser = await connect(version.webSocketDebuggerUrl);
  browser.kill = async () => {
    try { browser.ws.close(); } catch { /* already closed */ }
    const image = binary.toLowerCase().includes('edge') ? 'msedge.exe' : 'chrome.exe';
    spawnSync('taskkill', ['/IM', image, '/F', '/T'], { stdio: 'ignore' });
    await delay(300);
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  browser.version = version;
  return browser;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    const handlers = [];
    let nextId = 1;

    ws.addEventListener('open', () => resolve(api));
    ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
    ws.addEventListener('message', ev => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        for (const h of handlers) h(msg.method, msg.params, msg.sessionId);
      }
    });

    const api = {
      ws,
      send(method, params = {}, sessionId = undefined) {
        const id = nextId++;
        const payload = { id, method, params };
        if (sessionId) payload.sessionId = sessionId;
        ws.send(JSON.stringify(payload));
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          setTimeout(() => {
            if (pending.has(id)) { pending.delete(id); rej(new Error('CDP timeout: ' + method)); }
          }, 120000);
        });
      },
      on(fn) { handlers.push(fn); },
    };
  });
}

export async function newPage(browser, url = 'about:blank') {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    targetId,
    sessionId,
    consoleEvents: [],
    exceptions: [],
    contexts: new Map(),
    requests: [],
    send: (m, p) => browser.send(m, p, sessionId),
  };
  let ctxOrder = 0;
  browser.on((method, params, sid) => {
    if (sid !== sessionId) return;
    if (method === 'Runtime.consoleAPICalled') {
      page.consoleEvents.push({
        type: params.type,
        text: (params.args || []).map(argToString).join(' '),
        stack: params.stackTrace?.callFrames?.[0]?.url || '',
      });
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails || {};
      page.exceptions.push({ text: d.exception?.description || d.text || '', url: d.url });
    } else if (method === 'Network.requestWillBeSent') {
      page.requests.push(params.request && params.request.url);
    } else if (method === 'Runtime.executionContextCreated') {
      page.contexts.set(params.context.id, { ...params.context, __order: ++ctxOrder });
    } else if (method === 'Runtime.executionContextDestroyed') {
      page.contexts.delete(params.executionContextId);
    } else if (method === 'Runtime.executionContextCleared') {
      page.contexts.clear();
    }
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  if (url && url !== 'about:blank') await page.send('Page.navigate', { url });
  return page;
}

function argToString(a) {
  if (a.value !== undefined) return typeof a.value === 'string' ? a.value : JSON.stringify(a.value);
  if (a.description) return a.description;
  if (a.unserializableValue) return a.unserializableValue;
  return a.type;
}

/**
 * Locate the isolated world created by the extension's content script.
 * Always returns the most recently created match: Chromium does not always
 * emit executionContextDestroyed for the pre-navigation context, so the
 * map can hold a stale entry whose id the renderer has already dropped.
 */
export function findExtensionContext(page, extensionName = 'WhatsApp Clean UI') {
  let best = null;
  for (const ctx of page.contexts.values()) {
    if (ctx.auxData?.isDefault !== false) continue;
    const matches = ctx.name === extensionName || (ctx.origin || '').startsWith('chrome-extension://');
    if (matches && (!best || ctx.__order > best.__order)) best = ctx;
  }
  return best;
}

export function findMainContext(page) {
  let best = null;
  for (const ctx of page.contexts.values()) {
    if (ctx.auxData?.isDefault && (!best || ctx.__order > best.__order)) best = ctx;
  }
  return best;
}

export async function evaluateIn(page, contextId, expression, { awaitPromise = true } = {}) {
  const res = await page.send('Runtime.evaluate', {
    expression, contextId, returnByValue: true, awaitPromise, userGesture: true,
  });
  if (res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('evaluate failed: ' + (d.exception?.description || d.text));
  }
  return res.result.value;
}

/** Load an unpacked extension and return its generated id. */
export async function loadExtension(browser, path) {
  const res = await browser.send('Extensions.loadUnpacked', { path });
  return res.id;
}

export { delay };