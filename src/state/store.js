/**
 * store — persisted user settings, backed by chrome.storage.sync (falls
 * back to in-memory defaults if the extension APIs aren't available, e.g.
 * when this file is loaded outside a real extension context).
 *
 * This intentionally holds only *global* preferences (mode, percentage,
 * padding, whether highlight mode is on). Per-video state (which ranges
 * were detected, which chapters are checked) lives in content.js/panel.js
 * and is recomputed on every video load — it isn't persisted.
 */
(function (root) {
  "use strict";

  var DEFAULTS = {
    mode: "most-replayed", // 'most-replayed' | 'skip-filler' | 'custom-percentage'
    percentage: 0.3, // 0..1 — kept for schema completeness; panel.js currently pins this via FIXED_PERCENTAGE
    paddingBefore: 1.5, // seconds of context kept before each retained range
    paddingAfter: 1.5, // seconds of context kept after each retained range
    mergeGap: 1.5, // seconds; ranges closer together than this get merged
    // On by default (see background.js's onInstalled for the fuller
    // reasoning) so a fresh install's first video actually demonstrates
    // the extension instead of looking like a no-op until the user
    // notices and flips a switch below the player.
    highlightsEnabled: true,
    panelCollapsed: false, // whether the user last left the panel collapsed to its mini pill
    introSeen: false, // whether panel.js's one-time "here's what just happened" callout has been shown/dismissed
    // On by default (disclosed in the store listing's privacy section,
    // same as error reporting — see telemetry/analytics.js), but with a
    // real, visible opt-out in the panel's settings popover, unlike
    // error reporting — behavior tracking is the case users and
    // reviewers actually expect a control for.
    analyticsEnabled: true,
  };

  function hasChromeStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync;
  }

  function load() {
    return new Promise(function (resolve) {
      if (!hasChromeStorage()) {
        resolve(Object.assign({}, DEFAULTS));
        return;
      }
      try {
        chrome.storage.sync.get(DEFAULTS, function (items) {
          if (chrome.runtime && chrome.runtime.lastError) {
            resolve(Object.assign({}, DEFAULTS));
            return;
          }
          resolve(Object.assign({}, DEFAULTS, items));
        });
      } catch (_err) {
        resolve(Object.assign({}, DEFAULTS));
      }
    });
  }

  function save(partial) {
    if (!hasChromeStorage()) return;
    try {
      chrome.storage.sync.set(partial);
    } catch (_err) {
      // Persistence is a nice-to-have; a failed write shouldn't break playback.
    }
  }

  root.YHP = root.YHP || {};
  root.YHP.Store = { load: load, save: save, DEFAULTS: DEFAULTS };
})(typeof window !== "undefined" ? window : globalThis);
