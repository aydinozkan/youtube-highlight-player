/**
 * background — minimal MV3 service worker.
 *
 * The extension's actual work all happens in the content scripts (which run
 * directly against the YouTube page); this worker only seeds default
 * settings on install. Kept intentionally small — it exists mainly as the
 * documented extension point for future strategies (e.g. a SponsorBlock
 * integration would fetch segment data here, where a network call is
 * cheaper/safer than from a content script) rather than because anything
 * needs it today.
 */
importScripts("../telemetry/errorReporter.js", "../telemetry/analytics.js");
self.YHP.ErrorReporter.installGlobalHandlers(self, "background");

chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason !== "install") return;
  chrome.storage.sync.get(null, function (existing) {
    if (chrome.runtime.lastError) return;
    if (Object.keys(existing).length > 0) return; // don't clobber a pre-existing sync profile
    chrome.storage.sync.set({
      mode: "most-replayed",
      percentage: 0.2,
      paddingBefore: 1.5,
      paddingAfter: 1.5,
      mergeGap: 1.5,
      // On by default for a fresh install so the very first video someone
      // watches actually demonstrates what this does, instead of looking
      // identical to a plain YouTube video until they happen to notice and
      // flip a switch below the player — a low-attention spot on the page.
      // panel.js pairs this with a one-time callout (gated on `introSeen`,
      // see store.js's DEFAULTS) explaining what just happened and how to
      // turn it off, so the behavior change is never a silent surprise.
      highlightsEnabled: true,
      introSeen: false,
      analyticsEnabled: true,
    });
  });
  // A fresh install is the one reliable, single-fire point to both create
  // the anonymous per-device analytics id and record that an install
  // happened — an *upgrade* to this version (as opposed to a fresh
  // install) never reaches this branch at all, so existing installs never
  // get a retroactive "installed" event; analytics.js's own
  // getOrCreateDistinctId() lazily creates the id for them instead, the
  // first time any other event actually fires.
  self.YHP.Analytics.init(true);
  self.YHP.Analytics.getOrCreateDistinctId().then(function () {
    self.YHP.Analytics.track("extension_installed");
  });
});
