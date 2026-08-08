/**
 * analytics — minimal, dependency-free product-usage analytics.
 *
 * Sends a short, curated list of feature-usage events to PostHog's plain
 * HTTP capture API — no SDK, no build step, same approach and the same
 * verification discipline as errorReporter.js: the capture endpoint, CORS
 * preflight behavior for a browser `fetch()`, and the event JSON shape
 * were all confirmed with real curl requests against a real PostHog
 * project before this was wired in, not assumed from docs.
 *
 * Deliberately narrow in *what* gets tracked — see the call sites in
 * content.js/panel.js/background.js for the exact event list. Never a
 * video ID, title, URL, or anything else about what someone is watching,
 * same discipline as the error reporter. Every event is sent with
 * `$process_person_profile: false`: PostHog still counts it toward
 * trends/uniques by `distinct_id`, but skips building a full identity-
 * resolution "Person" profile — more tracking machinery than anonymous
 * feature-usage counting needs.
 *
 * On by default, but genuinely optional — unlike error reporting, this
 * one ships with a visible toggle (see panel.js's settings popover)
 * because tracking *what people do*, not just *what broke*, is exactly
 * the case users and reviewers expect a real control for. `init()` must
 * be called once per JS context with the current `analyticsEnabled`
 * setting before `track()` does anything; there's no silent-by-default
 * path.
 *
 * Loaded in two different JS worlds — a content script's `window` and the
 * background service worker's `self` — so this attaches to `self` rather
 * than `window` specifically, matching errorReporter.js.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.Analytics = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Public, write-only project token for the YouTube Highlight Player
  // PostHog project — safe to ship in client code, the same way PostHog's
  // own JS snippet embeds it directly in public page source.
  var API_KEY = "phc_zRmRzxbcsSJfHkcS43gU9Kt9ehsfpUTKfkDRmmQZ2wdA";
  var CAPTURE_URL = "https://eu.i.posthog.com/capture/";
  // Local, not synced — an anonymous per-install id doesn't need (and
  // shouldn't need) to follow the user's Google account across devices;
  // chrome.storage.local keeps it device-scoped, separate from the real,
  // synced settings in store.js.
  var DISTINCT_ID_STORAGE_KEY = "yhp_analytics_distinct_id";
  var MAX_EVENTS_PER_SESSION = 100; // generous but bounded — usage counting, not a firehose

  var enabled = false;
  var initialized = false;
  var eventCount = 0;
  var cachedDistinctId = null;

  function makeId() {
    if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
    // Fallback for contexts without crypto.randomUUID — shouldn't happen
    // in a modern Chrome extension, kept only as a last resort.
    var bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.prototype.map.call(bytes, function (b) {
      return (b < 16 ? "0" : "") + b.toString(16);
    }).join("");
  }

  /**
   * Reads the stored anonymous distinct id, generating and persisting one
   * on first use if none exists yet. Covers both the fresh-install path
   * (background.js also seeds it directly at onInstalled, so it's ready
   * before the very first event) and the upgrade path (an existing
   * install predating this feature never gets an onInstalled "install"
   * event, so it's created lazily here instead, the first time it's
   * needed).
   */
  function getOrCreateDistinctId() {
    return new Promise(function (resolve) {
      if (cachedDistinctId) { resolve(cachedDistinctId); return; }
      try {
        chrome.storage.local.get([DISTINCT_ID_STORAGE_KEY], function (result) {
          if (chrome.runtime.lastError) { resolve(makeId()); return; }
          var existing = result && result[DISTINCT_ID_STORAGE_KEY];
          if (typeof existing === "string" && existing) {
            cachedDistinctId = existing;
            resolve(existing);
            return;
          }
          var fresh = makeId();
          cachedDistinctId = fresh;
          try {
            var toStore = {};
            toStore[DISTINCT_ID_STORAGE_KEY] = fresh;
            chrome.storage.local.set(toStore);
          } catch (_err) {
            // Best-effort persistence — still resolve with the in-memory
            // id so this event isn't lost; a later call just persists again.
          }
          resolve(fresh);
        });
      } catch (_err) {
        resolve(makeId());
      }
    });
  }

  function safeManifestVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_err) {
      return "unknown";
    }
  }

  /**
   * Must be called once per JS context (content script / background)
   * before track() does anything — mirrors errorReporter's explicit-
   * install pattern rather than tracking silently by default.
   * @param {boolean} isEnabled - from Store's `analyticsEnabled` setting.
   */
  function init(isEnabled) {
    enabled = !!isEnabled;
    initialized = true;
  }

  /**
   * @param {string} event - short, snake_case event name (see call sites
   *   in content.js/panel.js/background.js)
   * @param {object} [properties] - small, non-content properties only —
   *   never a video id/title/URL. See file header.
   */
  function track(event, properties) {
    if (!initialized || !enabled) return;
    if (eventCount >= MAX_EVENTS_PER_SESSION) return;
    eventCount += 1;

    getOrCreateDistinctId().then(function (distinctId) {
      var body = {
        api_key: API_KEY,
        event: event,
        distinct_id: distinctId,
        properties: Object.assign({
          extension_version: safeManifestVersion(),
          "$process_person_profile": false,
        }, properties || {}),
        timestamp: new Date().toISOString(),
      };
      try {
        fetch(CAPTURE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          keepalive: true, // survives a fast SPA navigation/tab teardown mid-flight
        }).catch(function () { /* best-effort — a failed report must never surface to the user */ });
      } catch (_err) {
        // fetch() itself can throw synchronously in rare cases; telemetry
        // failing must never be allowed to break the extension it's watching.
      }
    });
  }

  return {
    init: init,
    track: track,
    getOrCreateDistinctId: getOrCreateDistinctId,
    // Pure helper, exposed mainly so it's directly unit-testable.
    makeId: makeId,
  };
});
