# WhatsApp Clean UI

## Project Name and Purpose

**WhatsApp Clean UI** is a Microsoft Edge / Chrome (Chromium, Manifest V3) extension that provides a cleaner WhatsApp Web interface by hiding the **Updates/Status** and **Communities** navigation items. Chats, Calls, Settings, Channels, the profile, messages and every unrelated feature are left untouched.

## Status

- Version 1.1.0
- The detection failure that prevented anything from being hidden has been diagnosed and fixed (see "Root cause" below).
- **171 automated checks pass** (static, unit, and real-browser). These include loading the unmodified extension in a real Chromium and injecting the content script into the live `web.whatsapp.com`.
- The remaining unverified item is **visual confirmation on a logged-in WhatsApp Web account**, which cannot be automated without logging in. See `TESTING.md` for the manual checklist.

## Root cause of the earlier "nothing is hidden" failure

The content script *was* injected on WhatsApp Web, but its detection logic could never match WhatsApp's real markup:

1. **Wrong candidate selectors.** It looked for `nav a[href]`, `nav button`, `#pane-side a[href]`, `#pane-side button`, `[role="tab"]` and `a[href*="/status"]`. WhatsApp's rail entries are none of those.
2. **Wrong corroboration signals.** It additionally required an `href` route, a `<nav>` landmark, `role="tablist"`, `role="tab"` or membership in `#pane-side`. The rail is a *sibling* of `#pane-side`, is not a `<nav>`, and Status/Communities have **no URL at all** (they open a mid drawer).
3. Therefore the candidate list was always empty, so `.wacu-nav-item-hidden` was never applied — which is exactly what `document.querySelectorAll('.wacu-nav-item-hidden').length === 0` showed.

A second, misleading observation: `typeof window.WhatsAppCleanUI` returning `'undefined'` in the DevTools console did **not** mean the script failed to run. Content scripts execute in an **isolated world**; the DevTools console evaluates in the page's **main world** by default. The handle is only reachable after switching the console's context selector to *WhatsApp Clean UI*. This is now covered by an automated test.

## How WhatsApp Web actually renders the navigation rail

Verified against the production JavaScript bundle served by `web.whatsapp.com` (module `WAWebStatusNavBarItem.react` / `WAWebCommunityNavBarItem.react` and `useWAWebArrowKeyNavigation`):

| Fact | Consequence |
|---|---|
| Rail entries are rendered by `WDSMenuBarItem`, which writes `data-navbar-item`, `data-navbar-item-index` and `data-navbar-item-selected="true"` | `data-navbar-item` is the reliable "this is a navigation entry" marker. WhatsApp's own keyboard navigation reads it via `document.querySelectorAll("[data-navbar-item]")` |
| Callers pass a stable `testid`, rendered as `data-testid`: `navbar-item-chats`, `navbar-item-status`, `navbar-item-communities`, `navbar-item-metabot`, `navbar-item-settings`, … | `navbar-item-status` / `navbar-item-communities` identify the two targets. A test id is **not translated**, so detection keeps working on non-English WhatsApp interfaces |
| The Status entry's accessible title is `"Status"`; its unread activity indicator is labelled `"Updates in Status"` | Label matching must tolerate an unread-count suffix |
| Status and Communities have **no route** (they open `MidDrawerEmptyState`); only Chats and Newsletters have URLs | `href`-based detection can never work for these two items |
| The rail is a sibling pane of `#pane-side`, not inside it, and carries no `<nav>` landmark | `#pane-side` / `nav` corroboration must not be required |

## How the fix identifies a target

`content.js` requires **two independent signals to agree** before anything is hidden:

- **Path A — stable identity.** `data-testid` is one of the target's known `navbar-item-*` values, **and** the element is itself a nav entry (`data-navbar-item`) or sits in a navigation region.
- **Path B — accessible name.** The accessible name matches a target label (tolerating an unread-count suffix such as `Status 42`), **and** the element is interactive, **and** it sits in a navigation region.
- **Path C — legacy link.** An `href` matching `/status`, `/updates` or `/communities`, **and** the element is inside a navigation region.

Guard rails:

- **Fail-safe.** If a target cannot be identified confidently it is left visible.
- **Never a container.** An element that itself contains other navigation entries, or that contains `#pane-side` / `#side` / `#main` / `#app`, is never hidden.
- **Exclusions.** Anything inside a dialog, alert dialog, menu, menu item, list box, grid, tree, `main` / `role="main"`, a text box, a `contenteditable`, or a chat row (`[data-testid="cell-frame-container"]`) is excluded.
- **Non-destructive.** Elements are never deleted, recreated or re-ordered. Only one extension class, `.wacu-nav-item-hidden` (`display: none !important` in `styles.css`), is toggled, so React state is untouched.
- **Language independent.** Detection is primarily driven by non-translated test ids; the translated accessible name is only a secondary signal.

## Dynamic rendering

A single `MutationObserver` watches `document.body` for child-list changes, debounced by 120 ms so bursts coalesce into one scan. Only `childList` is observed, so the extension's own class toggles can never re-trigger it. Back-pressure limits the observer to 40 scans per 10 s; if that budget is exhausted the observer pauses and logs a warning instead of spinning.

## Settings and messaging

- Both toggles default to **enabled**, and only when no preference has previously been saved.
- Values persist in `chrome.storage.local` under `hideUpdates`, `hideCommunities` and `debug`.
- Toggling applies immediately to open WhatsApp Web tabs through `chrome.runtime.sendMessage` (`WACU_SETTINGS_UPDATED`).
- `chrome.storage.onChanged` is an independent second path, so a failed message is never a data loss; it also covers extension reloads.
- If no WhatsApp Web tab is open, the popup reports *"Saved. It will apply when WhatsApp Web next loads or reloads."* — it never claims a live application that did not happen.
- **No additional permissions.** `chrome.tabs.query` was evaluated and rejected: without the `tabs` permission it cannot filter by URL, and the permission would expose every site's tab URLs, titles and favicons. `chrome.runtime.sendMessage` reaches the only content script registered (`https://web.whatsapp.com/*`) with zero extra permissions.

## Diagnostics

Debug logging is **off by default** and is enabled from the popup (*Diagnostics → Enable debug logging*) or from the console in the extension context.

**The debug handle lives in the content script's isolated world.** To use it in DevTools, open the console and switch the context selector at the top-left from `top` to *WhatsApp Clean UI*; typing `typeof window.WhatsAppCleanUI` in the default context always reports `"undefined"`.

```js
WhatsAppCleanUI.diagnose()          // full report: settings, rail items, accept/reject reasons
WhatsAppCleanUI.setDebug(true)      // enable console logging at runtime
WhatsAppCleanUI.applyHiding()       // force a rescan
WhatsAppCleanUI.stopObserver()      // disconnect the observer
WhatsAppCleanUI.settings            // current preferences
```

Limitations of the handle: it is only reachable from the extension's isolated world (a page script cannot see it), it reports only navigation metadata — element tags, `data-testid`s and accessible names of *candidate* elements — and it is a debugging aid, not a supported public API. Console output uses the `[WhatsApp Clean UI]` prefix and never contains messages, contacts, phone numbers, cookies or account data.

## Technology Stack

- JavaScript (no build step), Manifest V3
- HTML and CSS, local files only — no external fonts, scripts or assets
- `chrome.storage.local` and `chrome.runtime.sendMessage` (extension-internal only)
- No dependencies, no build tools, no backend, no network requests

## Project File Structure

```text
Whatsapp Extention/
├── manifest.json      # MV3 manifest; storage permission only
├── content.js         # content script: identification, hiding, settings, messaging
├── styles.css         # content stylesheet: .wacu-nav-item-hidden
├── popup.html         # popup markup: two toggles + diagnostics
├── popup.css          # popup styles (local CSS only)
├── popup.js           # popup: load/save settings, notify content script
├── README.md          # this file
├── PRIVACY.md         # privacy model
├── TESTING.md         # test plan and recorded results
├── icons/             # reserved for future icons (currently empty)
└── tests/             # automated test suite (no npm packages required)
    ├── run-tests.mjs
    ├── static.test.mjs
    ├── unit.test.mjs
    ├── browser.test.mjs
    ├── fixtures/whatsapp-nav.html
    └── lib/{harness,cdp}.mjs
```

## How to Load the Extension in Microsoft Edge

1. Open Microsoft Edge.
2. Go to `edge://extensions`.
3. Turn on **Developer mode** (toggle in the lower-left corner).
4. Click **Load unpacked**.
5. Select `D:\project by ritik\Whatsapp Extention` (the folder containing `manifest.json`).
6. Open `https://web.whatsapp.com/`. Updates/Status and Communities should disappear from the left rail.
7. To pick up code changes later, press the **reload** arrow on the extension card at `edge://extensions`, then refresh the WhatsApp Web tab.

The extension has no icon files yet, so Edge shows its default placeholder icon. That is expected.

## Development Workflow

1. Edit the files in this directory (e.g. `code "D:\project by ritik\Whatsapp Extention"`).
2. Run the full automated suite:
   ```powershell
   node "D:\project by ritik\Whatsapp Extention\tests\run-tests.mjs"
   ```
   Add `--no-browser` to skip the real-browser group, or `--only=static|unit|browser` to run one group.
3. Reload the extension at `edge://extensions`, then refresh the WhatsApp Web tab.
4. If something is not hidden, turn on *Diagnostics → Enable debug logging* in the popup and inspect `WhatsAppCleanUI.diagnose()` from the extension context.

## Testing

See `TESTING.md` for the full list of executed checks and the manual verification checklist.

## Current Limitations

- **Live visual confirmation is still pending.** The automated suite proves injection on the real `web.whatsapp.com` and proves hiding against a fixture that replicates the current rail markup, but the rail is only rendered for a logged-in account, which the tests deliberately do not log into.
- Detection depends on `data-navbar-item` and `navbar-item-*` test ids. If WhatsApp renames them, detection stops matching and the failure mode is fail-safe — items simply stay visible. `diagnose()` makes this easy to spot.
- Settings apply to all WhatsApp Web tabs; there is no per-tab control.
- No icon files exist yet.#   w h a t s a p p - E x t e n t i o n  
 #   w h a t s a p p - E x t e n t i o n  
 