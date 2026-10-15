/**
 * WhatsApp Clean UI - Popup script (Phase 3)
 *
 * Loads the two hiding settings from chrome.storage.local,
 * renders them as toggles with ON/OFF state badges, and
 * persists changes immediately. After saving, it notifies
 * the content script(s) running on WhatsApp Web via
 * chrome.runtime.sendMessage so the change applies without
 * reloading the page.
 *
 * Safety properties:
 * - No permissions beyond the existing "storage" permission.
 * - No tab manipulation, no remote requests, no eval.
 * - Updates are serialized, so rapid toggles cannot
 *   produce duplicate or conflicting writes.
 * - Storage or messaging failures are caught and reported
 *   in the popup status area. Saved settings remain the
 *   source of truth: the content script also reads storage
 *   at startup and watches storage changes, so a failed
 *   live notification is not a data loss.
 */

(function () {
  'use strict';

  /** Defaults keep both hiding features enabled; debug stays off. */
  const DEFAULTS = {
    hideUpdates: true,
    hideCommunities: true,
    debug: false,
  };

  /** Message type shared with content.js. */
  const MESSAGE_TYPE = 'WACU_SETTINGS_UPDATED';

  /** Upper bound for live notification before it is treated as failed. */
  const MESSAGE_TIMEOUT_MS = 1500;

  /** Serializes save+notify operations in order. */
  let applyQueue = Promise.resolve();

  function byId(id) {
    return document.getElementById(id);
  }

  /** Read settings; falls back to defaults when storage is unavailable. */
  function loadSettings() {
    return new Promise(function (resolve) {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve(DEFAULTS);
        return;
      }
      try {
        chrome.storage.local.get(DEFAULTS, function (stored) {
          const settings = {};
          Object.keys(DEFAULTS).forEach(function (key) {
            settings[key] = typeof stored[key] === 'boolean' ? stored[key] : DEFAULTS[key];
          });
          resolve(settings);
        });
      } catch (err) {
        resolve(DEFAULTS);
      }
    });
  }

  /** Persist settings; resolves false when storage is unavailable or fails. */
  function saveSettings(settings) {
    return new Promise(function (resolve) {
      if (!chrome || !chrome.storage || !chrome.storage.local) {
        resolve(false);
        return;
      }
      try {
        chrome.storage.local.set(settings, function () {
          resolve(!chrome.runtime.lastError);
        });
      } catch (err) {
        resolve(false);
      }
    });
  }

  /**
   * Ask running content script(s) to apply the new settings now.
   * Resolves false when no WhatsApp Web tab is open (no receiving
   * end), when messaging fails, or when no response arrives within
   * MESSAGE_TIMEOUT_MS. The settings are still saved and will
   * apply on the next WhatsApp Web load or storage event.
   */
  function notifyContentScripts(settings) {
    return new Promise(function (resolve) {
      if (!chrome || !chrome.runtime || !chrome.runtime.sendMessage) {
        resolve(false);
        return;
      }
      let settled = false;
      const finish = function (result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(function () {
        finish(false); // no timely response: treat as not applied
      }, MESSAGE_TIMEOUT_MS);
      try {
        chrome.runtime.sendMessage(
          { type: MESSAGE_TYPE, settings: settings },
          function (response) {
            if (chrome.runtime.lastError) {
              finish(false);
              return;
            }
            finish(!!response && response.applied === true);
          }
        );
      } catch (err) {
        finish(false);
      }
    });
  }

  /** Render every toggle and its ON/OFF state badge from a settings object. */
  function render(settings) {
    Object.keys(DEFAULTS).forEach(function (key) {
      const checkbox = byId(key);
      if (!checkbox) return;
      checkbox.checked = !!settings[key];
      const state = byId(key + '-state');
      if (state) {
        state.textContent = settings[key] ? 'ON' : 'OFF';
        state.classList.toggle('off', !settings[key]);
      }
    });
  }

  /** Read the current checkbox state for every known setting key. */
  function readControls() {
    const settings = {};
    Object.keys(DEFAULTS).forEach(function (key) {
      const checkbox = byId(key);
      settings[key] = checkbox ? !!checkbox.checked : DEFAULTS[key];
    });
    return settings;
  }

  function setStatus(message, isError) {
    const status = byId('status-message');
    if (!status) return;
    status.textContent = message;
    if (isError) status.classList.add('error');
    else status.classList.remove('error');
  }

  /** One save+notify cycle; runs only after the previous one. */
  function applySettings(settings) {
    return saveSettings(settings).then(function (saved) {
      if (!saved) {
        setStatus('Could not save settings. Storage is unavailable.', true);
        return null;
      }
      render(settings); // badges now reflect the persisted state
      return notifyContentScripts(settings);
    }).then(function (applied) {
      // applied === null: the save failed and the error was already shown.
      if (applied === true) {
        setStatus('Saved and applied to open WhatsApp Web tabs.');
      } else if (applied === false) {
        setStatus('Saved. It will apply when WhatsApp Web next loads or reloads.');
      }
    });
  }

  /**
   * Toggle handler: queue the update so rapid or repeated
   * toggles are applied in order without conflicting writes.
   */
  function onToggle() {
    const settings = readControls();
    setStatus('Saving…');
    applyQueue = applyQueue.then(function () {
      return applySettings(settings);
    }).catch(function () {
      // Unexpected error: never leave the queue broken or the
      // status stuck on "Saving…".
      setStatus('Could not apply settings.', true);
    });
  }

  function init() {
    const missing = Object.keys(DEFAULTS).filter(function (key) { return !byId(key); });
    if (missing.length) {
      setStatus('Settings controls are missing from the popup: ' + missing.join(', '), true);
      return;
    }
    loadSettings().then(function (settings) {
      render(settings);
      if (!missing.length) setStatus('Ready.');
    });
    Object.keys(DEFAULTS).forEach(function (key) {
      byId(key).addEventListener('change', onToggle);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
