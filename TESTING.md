# Testing — WhatsApp Clean UI (v1.1.0)

All results below come from checks that were **actually executed** in this environment. Nothing is marked as passed on prediction.

## Environment

- OS: Windows 11 (win32), PowerShell 5.1
- Node.js: v24.14.0 (no npm packages installed for this project)
- Browser used by the automated group: **Google Chrome 156.0.8078.35**, headless, launched with a throwaway profile in `%TEMP%` and deleted afterwards. The user's normal browser profile was never touched.

## How to run

```powershell
node "D:\project by ritik\Whatsapp Extention\tests\run-tests.mjs"              # everything
node "D:\project by ritik\Whatsapp Extention\tests\run-tests.mjs" --no-browser # static + unit only
node "D:\project by ritik\Whatsapp Extention\tests\run-tests.mjs" --only=browser
```

No npm packages are required. The browser group drives Chromium over the DevTools Protocol using Node's built-in `WebSocket` (`tests/lib/cdp.mjs`).

## Summary of the last run

| Group | Checks | Result |
|---|---|---|
| Static (manifest, file integrity, cross-file consistency, source review) | 90 | all pass |
| Unit (real `content.js` / `popup.js` in a `node:vm` sandbox, stubbed chrome APIs) | 28 | all pass |
| Real browser (live site + fixture + popup end-to-end) | 53 | all pass |
| **Total** | **171** | **171 passed, 0 failed** |

The suite was run four times consecutively with identical results (171 passed, 0 failed each time, ~16 s per run).

## What each group covers

### Static — `tests/static.test.mjs`

- **Manifest**: valid JSON; `manifest_version` 3; name/version shape; `action.default_popup`; match pattern is exactly `["https://web.whatsapp.com/*"]`; every referenced file exists; `run_at` and `all_frames`; no background/service worker.
- **Permissions**: `permissions` is exactly `["storage"]`; no `tabs`; no `host_permissions`, `optional_permissions`, `web_accessible_resources`, `externally_connectable` or CSP override; no `<all_urls>`; no origin other than `web.whatsapp.com`.
- **Syntax**: `node --check` on `content.js` and `popup.js`.
- **Cross-file consistency**: the hiding class matches between `content.js` and `styles.css`; `styles.css` really applies `display: none !important` and contains exactly one rule; the `WACU_SETTINGS_UPDATED` name and the `hideUpdates` / `hideCommunities` / `debug` keys match across files; every popup storage key has a checkbox, a `<label for>` and a state badge; `popup.html` references only local assets.
- **Source review**: detection uses the `data-navbar-item` contract and the `navbar-item-*` test ids; the class is applied only through `classList`; no `remove()`/`removeChild`/`replaceWith`/`innerHTML =`; no `insertBefore`/`appendChild`/`parentNode.`; the observer is single, disconnectable, debounced, `childList`-only, and has a bounded scan budget; chrome APIs are guarded; diagnostics exist; debug logging is gated and prefixed.
- **Safety**: 20 forbidden APIs checked in both scripts (`eval`, `new Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `sendBeacon`, `chrome.tabs`, `chrome.cookies`, `chrome.history`, `chrome.webRequest`, `chrome.downloads`, `chrome.bookmarks`, `clipboard`, `cookie`, `localStorage`, `sessionStorage`, `indexedDB`, `Notification`, …); `textContent` is read at most twice (accessible-name helper only); no inline handlers; no remote URLs in CSS.

### Unit — `tests/unit.test.mjs`

The actual project sources are executed in a `node:vm` sandbox with stubbed chrome APIs:

- Boots with no chrome APIs at all, with full APIs, and creates exactly one `MutationObserver`.
- Defaults (both features enabled, debug off), persisted `true`/`false` values honoured, non-boolean stored values fall back to defaults, missing storage keeps built-in defaults.
- Message listener: registered exactly once; `WACU_SETTINGS_UPDATED` updates settings and acknowledges `{applied:true}`; the two toggles are independent; non-boolean and unknown payload fields ignored; `null`, `{}`, `{type:'OTHER'}`, strings and numbers cause no crash and no response.
- `chrome.storage.onChanged` re-applies changes; other storage areas and non-boolean changes are ignored.
- `diagnose()` returns a well-formed report; `setDebug`, `stopObserver` (repeatable) and the version string behave.
- `popup.js` boots against a minimal DOM and reports missing controls instead of crashing.

### Real browser — `tests/browser.test.mjs`

Three parts, all in a real Chromium driven over CDP:

1. **Live site, unmodified project.** The project directory is loaded as an unpacked extension and `https://web.whatsapp.com/` is opened.
2. **Fixture.** A byte-identical copy of `content.js`/`styles.css`/`popup.*` is loaded with **only** the manifest match pattern extended to a local test origin, then driven against `tests/fixtures/whatsapp-nav.html`, which replicates the live-verified WhatsApp rail markup. The suite asserts the SHA-256 of every copied file matches the shipped file, so the code under test is byte-identical.
3. **Popup.** The real `popup.html` is opened and driven: checkbox → `chrome.storage.local` → the live tab.

Executed and passing:

- The extension loads from the project directory and **the content script is injected into the real `web.whatsapp.com` tab**.
- The debug handle exists in the extension isolated world and is **`undefined` in the page main world** — this reproduces and explains the original misleading console result.
- `diagnose()` runs on the live site without throwing; the observer is running; no exceptions and no console output from the extension.
- On the live site the unauthenticated screen renders no `#pane-side` and no `[data-navbar-item]` entries, i.e. the rail only exists for a logged-in account.
- Fixture: Updates/Status and Communities are hidden by default with computed `display: none` (proving the injected CSS applies); exactly two elements carry the class.
- Chats, Meta AI, Settings and New chat are not hidden; the rail container is not hidden.
- Matching text elsewhere stays visible: a chat row named "Communities", a row preview mentioning Status, a non-interactive "Status" chip inside `#pane-side`, a search result, two message bubbles, the composer, a button inside the settings dialog, and a menu item.
- No element was detached by the extension.
- Robustness: unread-count suffix (`Status 42`) still matches; a **localized** accessible name does not defeat `data-testid` detection; a legacy `<a href="/status">` inside a nav landmark is matched.
- Settings: each toggle independently restores/re-hides only its own item; both off hides nothing; both on hides both.
- Dynamic rendering: a late-rendered entry is hidden; a React-style re-render (fresh node, class lost) is re-hidden; a burst of 300 mutations does **not** cause unbounded rescans; a stale class on a non-target element is removed.
- Preferences survive a page reload and re-apply.
- Diagnostics: `diagnose()` lists every rail entry with its test id and records the accept/reject reason for each candidate; debug output stays silent until explicitly enabled and contains no contact-like data.
- Popup end-to-end: both toggles checked with ON badges, debug OFF by default; toggling writes `chrome.storage.local` without touching the other setting; the change reaches the already-open tab immediately; the status area reports it; re-enabling re-hides live; controls are labelled and reachable.
- Safety in the browser: no extension exceptions, no extension console errors, and **no network request from the tab to any origin other than the fixture's own**.

## Test-harness bugs found and fixed while writing this suite

1. `__queryCalls` was read from the wrapper object instead of the fake DOM (unit harness).
2. Asynchronous browser checks were not awaited, so they raced and corrupted each other's DOM (fixed by making `check()` awaitable and awaiting every browser check).
3. Chromium does not always announce `Runtime.executionContextDestroyed` for the pre-navigation context, so context lookups returned a stale id ("Cannot find context with specified id"). Fixed by tracking context recency and only accepting a context that has just answered an `evaluate()` call.
4. The late-render test removed a fixture element that later tests depended on; it now re-renders the entry in place.
5. Two assertions were themselves wrong (a badge expectation and a "no network requests" check that was actually counting console output); the network check was replaced with a real request-origin assertion.

## Not run / blocked

| # | Check | Status |
|---|---|---|
| M1 | Visual confirmation that Updates/Status and Communities disappear on a **logged-in** WhatsApp Web account | **NOT RUN** — requires the user's own signed-in session; no login, QR scan, cookie import or credential handling was attempted |
| M2 | Visual confirmation on a non-English WhatsApp interface | **NOT RUN** — same reason (detection is covered by an automated test with a localized label, but not visually) |
| M3 | Microsoft Edge specifically (rather than Chrome 156) | **NOT RUN** — the CDP client supports both; the recorded run used Chrome because it was first on the search list. Edge is installed and the manifest is standard MV3 |
| M4 | Playwright / Puppeteer | **NOT USED** — not installed; a zero-dependency CDP client was written instead, and no dependency was installed |

## Manual verification checklist (run these yourself in Edge)

1. `edge://extensions` → Developer mode → **Load unpacked** → select `D:\project by ritik\Whatsapp Extention`.
2. Log in to `https://web.whatsapp.com/` yourself.
3. **Updates/Status and Communities are gone from the left rail.** Chats, Calls, Channels, Meta AI, Settings and your profile are still there.
4. Open the popup → turn **Hide Updates/Status** off → Updates/Status returns *immediately*, Communities stays hidden.
5. Turn **Hide Communities** off → Communities returns; Update/Status stays hidden.
6. Turn both back on → both disappear again.
7. Press `F5` on the WhatsApp tab → preferences persist and re-apply.
8. Click around (open chats, open settings, search) → nothing unrelated disappears.
9. Resize the window / collapse the chat list → hidden items stay hidden.
10. Open DevTools → Console → **switch the context selector from `top` to `WhatsApp Clean UI`** → run `WhatsAppCleanUI.diagnose()` and confirm `hideClassCount: 2`.
11. Toggle *Diagnostics → Enable debug logging* in the popup and confirm `[WhatsApp Clean UI]` lines appear in that same context.
12. Close WhatsApp Web, toggle a setting, reopen it → the saved state is applied.