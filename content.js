/**
 * WhatsApp Clean UI - Content Script
 *
 * Hides the "Updates/Status" and "Communities" navigation items on
 * WhatsApp Web, controlled by popup toggles persisted in
 * chrome.storage.local. Both features are enabled by default.
 *
 * ---------------------------------------------------------------------
 * How WhatsApp Web actually renders its navigation rail
 * ---------------------------------------------------------------------
 * Verified against the production bundle served by web.whatsapp.com
 * (module WAWebStatusNavBarItem.react / WAWebCommunityNavBarItem.react,
 * and useWAWebArrowKeyNavigation):
 *
 *   - Every rail entry is rendered by `WDSMenuBarItem.react`, which puts
 *     the attributes `data-navbar-item`, `data-navbar-item-index` and
 *     (for the active one) `data-navbar-item-selected="true"` on the
 *     element. WhatsApp's own keyboard-navigation code reads them with
 *     document.querySelectorAll("[data-navbar-item]").
 *   - The caller supplies a stable `testid`, rendered as `data-testid`:
 *     "navbar-item-chats", "navbar-item-status", "navbar-item-communities",
 *     "navbar-item-metabot", "navbar-item-settings", ... The Status entry's
 *     accessible title is "Status" (its unread activity indicator is
 *     labelled "Updates in Status").
 *   - Status and Communities do NOT have a URL: they open a mid drawer
 *     (WAWebMidDrawerEmptyState). Only Chats (root URL) and Newsletters
 *     have routes. So href-based detection cannot work.
 *   - The rail is not inside <nav>, and not inside #pane-side either; it is
 *     a sibling pane. role="tab" does not apply.
 *
 * The previous implementation looked for `nav a[href]`, `nav button`,
 * `#pane-side a[href]`, `#pane-side button`, `[role="tab"]` and
 * `a[href*="/status"]` and additionally demanded corroboration from
 * href / <nav> / role="tablist" / role="tab" / #pane-side. None of those
 * exist in this DOM, so the candidate list was always empty and nothing
 * was ever hidden.
 *
 * Design principles (unchanged):
 * - Conservative identification: two independent signals must agree.
 * - Fail-safe: if a target cannot be identified confidently it stays visible.
 * - Non-destructive: elements are never deleted, recreated or re-ordered;
 *   only one extension-specific CSS class is toggled.
 * - No access to messages, contacts, cookies, credentials or account data;
 *   no network requests. Storage holds only the two local preferences.
 */

(function () {
  'use strict';

  /* ----------------------------------------------------------------
   * Settings
   *
   * Both features default to enabled. Values are persisted by the popup
   * in chrome.storage.local; the same defaults apply when nothing is
   * stored yet. `debug` is an optional diagnostics switch (off by
   * default) and is never read from the page.
   * ---------------------------------------------------------------- */
  const DEFAULTS = {
    hideUpdates: true,
    hideCommunities: true,
    debug: false,
  };

  const settings = {
    hideUpdates: true,
    hideCommunities: true,
    debug: false,
  };

  /**
   * Extension-specific hiding class. MUST stay in sync with styles.css.
   */
  const HIDE_CLASS = 'wacu-nav-item-hidden';

  /** Debug console prefix. */
  const LOG_PREFIX = '[WhatsApp Clean UI]';

  /* ----------------------------------------------------------------
   * Target definitions
   *
   * testids:  stable `data-testid` values supplied by WhatsApp to the
   *           rail item components (primary, strongest signal).
   * labels:   acceptable normalized accessible names (secondary signal).
   * hrefPaths: legacy layouts where the item was a real link.
   * ---------------------------------------------------------------- */
  const TARGETS = [
    {
      id: 'updates-status',
      setting: 'hideUpdates',
      testids: [
        'navbar-item-status',
        'navbar-item-updates',
        'navbar-item-updates-status',
        'navbar-item-status-updates',
      ],
      labels: ['status', 'updates', 'updates status', 'updates/status', 'updates in status'],
      hrefPaths: ['/updates', '/status'],
    },
    {
      id: 'communities',
      setting: 'hideCommunities',
      testids: ['navbar-item-communities', 'navbar-item-community'],
      labels: ['communities'],
      hrefPaths: ['/communities'],
    },
  ];

  /**
   * Markup that marks an element as one of WhatsApp's own navigation
   * entries. `[data-navbar-item]` is written by WDSMenuBarItem and read
   * back by WhatsApp's own useWAWebArrowKeyNavigation. The data-testid
   * variants are a redundant path in case the attribute is renamed.
   */
  const NAV_ITEM_SELECTOR = '[data-navbar-item], [data-testid^="navbar-item-"]';

  /**
   * Containers that identify a navigation region. Used as the second
   * signal when a candidate is identified by its stable id or by its
   * accessible name.
   *
   * `#pane-side` itself is deliberately NOT listed: it is the whole chat
   * list pane and would let a stray "Status" chip qualify as navigation.
   * Only its header sub-region qualifies.
   */
  const NAV_CONTAINER_SELECTOR = [
    '[role="navigation"]',
    'nav',
    '[role="tablist"]',
    '[role="menubar"]',
    'header[data-testid="chatlist-header"]',
    '#pane-side > header',
  ].join(', ');

  /** Elements that can actually be operated as navigation entries. */
  const INTERACTIVE_SELECTOR = [
    'a[href]',
    'button',
    '[role="button"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[role="link"]',
    '[tabindex]',
  ].join(', ');

  /**
   * Regions where matching text is never a navigation item: dialogs,
   * menus, list boxes/grids, the conversation region, the chat list
   * rows, search surfaces and editable areas.
   */
  const EXCLUDED_SELECTOR = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="menu"]',
    '[role="menuitem"]',
    '[role="listbox"]',
    '[role="grid"]',
    '[role="tree"]',
    '[role="main"]',
    'main',
    '[role="textbox"]',
    '[contenteditable="true"]',
    '[data-testid="cell-frame-container"]',
    '#main',
  ].join(', ');

  /* ----------------------------------------------------------------
   * Diagnostics
   * ---------------------------------------------------------------- */

  let debugEnabled = false;

  function log() {
    if (!debugEnabled) return;
    try {
      console.log.apply(console, [LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
    } catch (err) {
      /* logging must never break the extension */
    }
  }

  function warn() {
    if (!debugEnabled) return;
    try {
      console.warn.apply(console, [LOG_PREFIX].concat(Array.prototype.slice.call(arguments)));
    } catch (err) {
      /* ignore */
    }
  }

  function setDebug(value) {
    debugEnabled = !!value;
    settings.debug = debugEnabled;
    log('debug mode', debugEnabled ? 'ON' : 'OFF');
  }

  /* ----------------------------------------------------------------
   * Settings plumbing
   * ---------------------------------------------------------------- */

  /**
   * Copy valid values from an object received from storage or a popup
   * message. Unknown keys and non-boolean values are ignored so a
   * corrupt payload cannot break identification.
   * Returns true when anything changed.
   */
  function updateSettings(newSettings) {
    if (!newSettings || typeof newSettings !== 'object') return false;
    let changed = false;
    Object.keys(DEFAULTS).forEach(function (key) {
      if (typeof newSettings[key] === 'boolean' && settings[key] !== newSettings[key]) {
        settings[key] = newSettings[key];
        changed = true;
      }
    });
    return changed;
  }

  /** Load persisted settings once at startup; defaults stand on failure. */
  function loadStoredSettings(callback) {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      log('chrome.storage.local unavailable; using built-in defaults');
      if (callback) callback();
      return;
    }
    try {
      chrome.storage.local.get(DEFAULTS, function (stored) {
        // Reading lastError (even into a local) both clears it and reports it.
        if (chrome.runtime && chrome.runtime.lastError) {
          warn('storage read failed:', chrome.runtime.lastError.message);
        }
        updateSettings(stored || {});
        setDebug(settings.debug);
        if (callback) callback();
      });
    } catch (err) {
      warn('storage read threw:', err && err.message);
      if (callback) callback();
    }
  }

  /* ----------------------------------------------------------------
   * Identification helpers
   * ---------------------------------------------------------------- */

  /** Lowercase, collapse whitespace, trim. */
  function normalize(text) {
    return (text || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  /**
   * Best-effort accessible name, following the accessible-name order:
   * aria-labelledby references, then aria-label, then title, then own
   * text content. Only these attributes are read; no message text is
   * inspected beyond the candidate element's own label.
   */
  function getAccessibleName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(function (id) {
        const ref = document.getElementById(id);
        return ref ? ref.textContent : '';
      }).join(' ');
      if (normalize(text)) return normalize(text);
    }
    const ariaLabel = normalize(el.getAttribute('aria-label'));
    if (ariaLabel) return ariaLabel;
    const title = normalize(el.getAttribute('title'));
    if (title) return title;
    return normalize(el.textContent);
  }

  /**
   * True when the element's accessible name equals one of the target's
   * labels. A trailing unread-count badge is tolerated (e.g. the
   * normalized name "status 3" matches "status"); the remainder after
   * the label may only contain digits and spaces.
   */
  function nameMatches(name, target) {
    if (!name) return false;
    return target.labels.some(function (label) {
      if (name === label) return true;
      if (name.indexOf(label) === 0) {
        return /^[\s\d]+$/.test(name.slice(label.length));
      }
      return false;
    });
  }

  /** True when the element sits inside a known navigation region. */
  function inNavContainer(el) {
    try {
      return !!el.closest(NAV_CONTAINER_SELECTOR);
    } catch (err) {
      return false;
    }
  }

  /** True when the element is one of WhatsApp's own rail entries. */
  function isNavItem(el) {
    try {
      return el.matches(NAV_ITEM_SELECTOR);
    } catch (err) {
      return false;
    }
  }

  /** True when the element can be operated (button, link, role=button...). */
  function isInteractive(el) {
    try {
      return el.matches(INTERACTIVE_SELECTOR);
    } catch (err) {
      return false;
    }
  }

  /** True when the element lives in a region that is never navigation. */
  function isExcluded(el) {
    try {
      if (el.closest(EXCLUDED_SELECTOR)) return true;
    } catch (err) {
      return false;
    }
    return false;
  }

  /**
   * True when the element would hide more than one navigation entry
   * (a rail container, the side pane, the app root). Never hide those.
   */
  function wrapsOtherNavItems(el) {
    try {
      if (el.querySelector(NAV_ITEM_SELECTOR)) return true;
    } catch (err) {
      return true;
    }
    return ['#pane-side', '#side', '#main', '#app'].some(function (id) {
      try {
        return el.querySelector(id) !== null;
      } catch (err) {
        return false;
      }
    });
  }

  /** Legacy layouts where the entry was a real link. */
  function hrefMatches(el, target) {
    const href = el.getAttribute('href') || '';
    if (!href) return false;
    return target.hrefPaths.some(function (p) {
      return href.indexOf(p) !== -1;
    });
  }

  /**
   * Decide whether a candidate is one of our targets.
   *
   * Two independent signals must always agree:
   *
   *   Path A - stable identity: `data-testid` is a WhatsApp test id, NOT a
   *            translated string, so it keeps working when the interface
   *            language is not English. Corroborated by the element being
   *            a nav entry or living in a navigation region.
   *   Path B - accessible name matching a known label. Corroborated by the
   *            element being interactive AND inside a navigation region.
   *   Path C - legacy layouts where the entry was a real link.
   *
   * Returns { targetId, via } when accepted, otherwise null.
   */
  function identify(el) {
    if (!el || !el.getAttribute) return null;
    if (isExcluded(el)) return null;

    const testid = normalize(el.getAttribute('data-testid'));
    const name = getAccessibleName(el);
    const navItem = isNavItem(el);
    const navContainer = inNavContainer(el);
    const structural = navItem || navContainer;

    for (let i = 0; i < TARGETS.length; i++) {
      const target = TARGETS[i];

      // Path A: stable, language-independent test id.
      if (testid && target.testids.indexOf(testid) !== -1) {
        if (structural) {
          return {
            targetId: target.id,
            via: 'data-testid+' + (navItem ? 'nav-item' : 'nav-container'),
          };
        }
        continue;
      }

      // Path B: accessible name (tolerates an unread-count suffix).
      if (nameMatches(name, target)) {
        if (navItem || (navContainer && isInteractive(el))) {
          return {
            targetId: target.id,
            via: 'accessible-name+' + (navItem ? 'nav-item' : 'nav-container'),
          };
        }
        continue;
      }

      // Path C: legacy link route, still requiring navigation structure.
      if (hrefMatches(el, target) && structural) {
        return { targetId: target.id, via: 'href+' + (navItem ? 'nav-item' : 'nav-container') };
      }
    }
    return null;
  }

  /**
   * Collect a small, targeted candidate set instead of scanning the whole
   * document. Every selector is wrapped so an unsupported selector on an
   * older browser build degrades to "no candidates" rather than throwing.
   */
  function collectCandidates() {
    const selectors = [
      NAV_ITEM_SELECTOR,
      '[role="navigation"] a[href]',
      '[role="navigation"] button',
      '[role="navigation"] [role="button"]',
      'nav a[href]',
      'nav button',
      'nav [role="button"]',
      '[role="tablist"] [role="tab"]',
      '[role="menubar"] [role="menuitem"]',
      '#pane-side a[href]',
      '#pane-side button',
      '#pane-side [role="button"]',
      'header[data-testid="chatlist-header"] a[href]',
      'header[data-testid="chatlist-header"] button',
      'header[data-testid="chatlist-header"] [role="button"]',
      'a[href*="/status"]',
      'a[href*="/updates"]',
      'a[href*="/communities"]',
    ];
    const candidates = new Set();
    selectors.forEach(function (selector) {
      let list;
      try {
        list = document.querySelectorAll(selector);
      } catch (err) {
        warn('unsupported selector, skipped:', selector);
        return;
      }
      for (let i = 0; i < list.length; i++) candidates.add(list[i]);
    });
    return candidates;
  }

  /* ----------------------------------------------------------------
   * Applying settings (idempotent)
   * ---------------------------------------------------------------- */

  let scanCount = 0;

  /**
   * Apply the current settings.
   * - Verified targets receive the hiding class only while their feature
   *   is enabled, and lose it immediately when disabled.
   * - The class is removed from anything that no longer verifies as a
   *   target (e.g. after a React re-render).
   * Safe to call repeatedly; always converges to the same end state.
   */
  function applyHiding(reason) {
    scanCount += 1;
    const verified = new Set();
    const decisions = [];
    const candidates = collectCandidates();

    candidates.forEach(function (el) {
      const verdict = identify(el);
      const testid = el.getAttribute('data-testid') || '';
      const name = getAccessibleName(el);

      if (!verdict) {
        if (testid || name) {
          decisions.push({
            element: el,
            testid: testid,
            name: name,
            accepted: false,
            reason: isExcluded(el) ? 'excluded-region' : 'no-target-match',
          });
        }
        return;
      }

      if (wrapsOtherNavItems(el)) {
        // A container of several entries: never hide it.
        decisions.push({
          element: el,
          testid: testid,
          name: name,
          accepted: false,
          reason: 'wraps-other-nav-items',
        });
        return;
      }

      verified.add(el);
      const target = TARGETS.filter(function (t) { return t.id === verdict.targetId; })[0];
      const enabled = !!settings[target.setting];
      if (enabled) {
        if (!el.classList.contains(HIDE_CLASS)) {
          el.classList.add(HIDE_CLASS);
          log('hidden', verdict.targetId, target.setting, 'via', verdict.via, '|', el.tagName, 'testid=' + (testid || '-'), 'name=' + JSON.stringify(name));
        }
      } else if (el.classList.contains(HIDE_CLASS)) {
        el.classList.remove(HIDE_CLASS);
        log('restored', verdict.targetId, target.setting, '|', el.tagName, 'testid=' + (testid || '-'));
      }
      decisions.push({
        element: el,
        testid: testid,
        name: name,
        accepted: true,
        target: verdict.targetId,
        via: verdict.via,
        enabled: enabled,
      });
    });

    // Clean up stale applications on elements that no longer verify.
    let removed = 0;
    document.querySelectorAll('.' + HIDE_CLASS).forEach(function (el) {
      if (!verified.has(el)) {
        el.classList.remove(HIDE_CLASS);
        removed += 1;
      }
    });
    if (removed) log('cleared', removed, 'stale hidden element(s)');

    const accepted = decisions.filter(function (d) { return d.accepted; });
    log(
      'scan#' + scanCount + ' (' + (reason || 'manual') + ')',
      'candidates=' + candidates.size,
      'matched=' + accepted.length,
      'hiddenNow=' + document.querySelectorAll('.' + HIDE_CLASS).length,
      'settings=' + JSON.stringify({ hideUpdates: settings.hideUpdates, hideCommunities: settings.hideCommunities })
    );
    return decisions;
  }

  /* ----------------------------------------------------------------
   * Dynamic rendering support
   * ---------------------------------------------------------------- */

  let observer = null;
  let scanTimer = null;
  let stopForChurn = false;
  let windowStart = Date.now();
  let windowScans = 0;

  /** Back-pressure: at most one scan per 120 ms, and a burst cap. */
  const SCAN_DEBOUNCE_MS = 120;
  const BURST_WINDOW_MS = 10000;
  const BURST_MAX_SCANS = 40;

  function scheduleScan() {
    if (stopForChurn) return;
    if (scanTimer !== null) return; // coalesce bursts
    scanTimer = setTimeout(function () {
      scanTimer = null;
      const now = Date.now();
      if (now - windowStart > BURST_WINDOW_MS) {
        windowStart = now;
        windowScans = 0;
      }
      windowScans += 1;
      if (windowScans > BURST_MAX_SCANS) {
        stopForChurn = true;
        warn('mutation burst limit reached; observer paused. Use WhatsAppCleanUI.applyHiding() to rescan manually.');
        return;
      }
      try {
        applyHiding('observer');
      } catch (err) {
        warn('scan failed:', err && err.message);
      }
    }, SCAN_DEBOUNCE_MS);
  }

  function startObserver() {
    if (observer) return; // never create a second observer
    if (typeof MutationObserver === 'undefined') {
      warn('MutationObserver unavailable; hiding will not re-apply automatically');
      return;
    }
    if (!document.body) {
      warn('document.body not available yet; observer not started');
      return;
    }
    observer = new MutationObserver(function (mutations) {
      for (let i = 0; i < mutations.length; i++) {
        if (mutations[i].addedNodes.length > 0 || mutations[i].removedNodes.length > 0) {
          scheduleScan();
          break;
        }
      }
    });
    // childList only: our own classList toggles are attribute mutations,
    // so the observer can never re-trigger itself (no recursion).
    observer.observe(document.body, { childList: true, subtree: true });
    log('MutationObserver started on document.body');
  }

  /** Cleanup: disconnect the observer and cancel any pending scan. */
  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
      log('MutationObserver stopped');
    }
    if (scanTimer !== null) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    stopForChurn = false;
    windowScans = 0;
    windowStart = Date.now();
  }

  /* ----------------------------------------------------------------
   * Popup connection
   * ---------------------------------------------------------------- */

  /** Handle a settings message from the popup. */
  function handleSettingsMessage(message, sender, sendResponse) {
    if (!message || message.type !== 'WACU_SETTINGS_UPDATED') return undefined;
    if (message.settings && typeof message.settings === 'object') {
      if (typeof message.settings.debug === 'boolean') setDebug(message.settings.debug);
      updateSettings(message.settings);
    }
    try {
      applyHiding('popup-message');
    } catch (err) {
      warn('apply failed after message:', err && err.message);
    }
    if (sendResponse) sendResponse({ applied: true });
    return undefined;
  }

  function startMessaging() {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.onMessage) {
      warn('runtime messaging unavailable; settings will apply on reload only');
      return;
    }
    try {
      chrome.runtime.onMessage.addListener(handleSettingsMessage);
      log('listening for WACU_SETTINGS_UPDATED');
    } catch (err) {
      warn('could not register message listener:', err && err.message);
    }
  }

  /**
   * Independent second path: re-apply whenever the popup (or any other
   * context, including an extension reload) changes the settings. A
   * failed popup message is therefore never a data loss.
   */
  function startStorageWatcher() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
    try {
      chrome.storage.onChanged.addListener(function (changes, areaName) {
        if (areaName !== 'local') return;
        const next = {};
        let relevant = false;
        Object.keys(DEFAULTS).forEach(function (key) {
          const change = changes[key];
          if (change && typeof change.newValue === 'boolean') {
            next[key] = change.newValue;
            relevant = true;
          }
        });
        if (!relevant) return;
        if (typeof next.debug === 'boolean') setDebug(next.debug);
        updateSettings(next);
        log('storage changed ->', JSON.stringify(next));
        try {
          applyHiding('storage-change');
        } catch (err) {
          warn('apply failed after storage change:', err && err.message);
        }
      });
      log('watching chrome.storage.onChanged');
    } catch (err) {
      warn('could not register storage watcher:', err && err.message);
    }
  }

  /* ----------------------------------------------------------------
   * Diagnostics API (debug handle)
   * ---------------------------------------------------------------- */

  /**
   * Returns a structured report of what the script currently sees.
   * Contains only navigation metadata (tags, test ids, accessible
   * names of candidate elements) - never message content.
   */
  function diagnose() {
    const decisions = applyHiding('diagnose');
    return {
      readyState: document.readyState,
      observerActive: !!observer,
      paused: stopForChurn,
      scanCount: scanCount,
      settings: {
        hideUpdates: settings.hideUpdates,
        hideCommunities: settings.hideCommunities,
      },
      hideClassCount: document.querySelectorAll('.' + HIDE_CLASS).length,
      navItemCount: (function () {
        try {
          return document.querySelectorAll(NAV_ITEM_SELECTOR).length;
        } catch (err) {
          return 0;
        }
      })(),
      railItems: (function () {
        const rows = [];
        let list = [];
        try {
          list = document.querySelectorAll(NAV_ITEM_SELECTOR);
        } catch (err) {
          return rows;
        }
        for (let i = 0; i < list.length; i++) {
          const el = list[i];
          rows.push({
            tag: el.tagName,
            testid: el.getAttribute('data-testid') || '',
            name: getAccessibleName(el),
            hidden: el.classList.contains(HIDE_CLASS),
          });
        }
        return rows;
      })(),
      decisions: decisions.map(function (d) {
        return {
          tag: d.element.tagName,
          testid: d.testid,
          name: d.name,
          accepted: d.accepted,
          reason: d.reason || null,
          target: d.target || null,
          via: d.via || null,
          enabled: typeof d.enabled === 'boolean' ? d.enabled : null,
          hidden: d.element.classList.contains(HIDE_CLASS),
        };
      }),
    };
  }

  /* ----------------------------------------------------------------
   * Boot
   * ---------------------------------------------------------------- */

  function start() {
    log('content script started | readyState=' + document.readyState);
    loadStoredSettings(function () {
      log('settings loaded:', JSON.stringify({
        hideUpdates: settings.hideUpdates,
        hideCommunities: settings.hideCommunities,
        debug: settings.debug,
      }));
      try {
        applyHiding('startup');
      } catch (err) {
        warn('initial scan failed:', err && err.message);
      }
    });
    startObserver();
    startMessaging();
    startStorageWatcher();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }

  /**
   * Debug handle.
   *
   * NOTE: this object lives in the content script's ISOLATED WORLD, the
   * same place the DevTools console can reach only after switching its
   * context selector to "WhatsApp Clean UI". Typing
   * `typeof window.WhatsAppCleanUI` in the default ("top") console context
   * always reports "undefined" even when the script is running correctly.
   */
  window.WhatsAppCleanUI = {
    settings: settings,
    applyHiding: applyHiding,
    stopObserver: stopObserver,
    diagnose: diagnose,
    setDebug: function (value) {
      setDebug(value);
      if (value) {
        console.log(LOG_PREFIX + ' debug mode ON. Diagnose with WhatsAppCleanUI.diagnose()');
      }
      return debugEnabled;
    },
    isDebug: function () { return debugEnabled; },
    version: '1.1.0',
  };
})();