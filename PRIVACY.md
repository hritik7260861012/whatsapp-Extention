# Privacy Model — WhatsApp Clean UI

## Local-only operation by design

WhatsApp Clean UI operates entirely on the user's device:

- The content script is registered only for `https://web.whatsapp.com/*` and nowhere else (`all_frames: false`, so it is not injected into WhatsApp's own iframes).
- All extension code (`content.js`, `styles.css`, `popup.html`, `popup.css`, `popup.js`) is bundled locally in the extension package.
- The `storage` permission is used **only** to keep three local preferences in `chrome.storage.local`: `hideUpdates`, `hideCommunities` and `debug`. Nothing else is stored.
- Popup-to-content-script communication uses `chrome.runtime.sendMessage`, which stays inside the extension. The message payload contains only the two boolean settings and the debug flag.
- There is **no background service worker**, no `host_permissions`, no `web_accessible_resources`, and no `externally_connectable`.

## Data the project does not intentionally collect or transmit

The project does not collect, read, store or transmit:

- WhatsApp messages or message content
- Contact lists, contact names or contact information
- Phone numbers
- Credentials, passwords, session tokens or cookies
- WhatsApp account information
- Browsing history or activity on any other website

## Exactly what the content script reads

To decide which navigation items to hide, `content.js` reads only:

1. Structural attributes of **candidate** elements: `data-navbar-item`, `data-testid`, `role`, `href`, `tabindex`.
2. Accessibility attributes used to compute a candidate's accessible name: `aria-labelledby`, `aria-label`, `title`, and the candidate's own `textContent` (used only as a last-resort name source).
3. The two/three boolean preferences from `chrome.storage.local`.

It reads nothing outside candidate navigation elements, and it performs no network requests of any kind. The only DOM write is toggling one extension-specific class, `.wacu-nav-item-hidden`, on verified navigation entries. Elements are never read for their content beyond the label described above, never deleted, and never re-ordered.

The debug mode is **off by default**. When a user enables it, console output uses the `[WhatsApp Clean UI]` prefix and contains only element tags, `data-testid` values, accessible names, accept/reject reasons and settings state. It does not print message text, contact names, phone numbers or any other account data. The `diagnose()` report follows the same rule.

## Diagnostics and the debug handle

`window.WhatsAppCleanUI` is created in the content script's **isolated world**, not in the page. Page scripts on WhatsApp Web therefore cannot read or call it, and it is only reachable from the DevTools console after switching the console context selector to *WhatsApp Clean UI*. It exposes diagnostics and a manual rescan; it is a debugging aid, not a supported public API, and it grants no additional access to any data.

## Honest caveats

- The project has **not been fully privacy-audited** by an independent party.
- Content scripts execute in the context of WhatsApp Web. The navigation-hiding logic should be re-reviewed whenever WhatsApp Web changes its DOM, to confirm it still reads nothing beyond candidate navigation elements.
- The automated test suite asserts, among other things, that the fixture tab issues **no network requests** beyond its own origin, that the sources contain no `fetch`/`XMLHttpRequest`/`WebSocket`/`sendBeacon`, and that no `tabs`, `cookies`, `history`, `webRequest`, `downloads`, `bookmarks`, `clipboard`, `localStorage`, `sessionStorage` or `indexedDB` API is referenced.
- This document describes the project's design intent. It does not make claims about guarantees or behaviours provided by the browser itself.