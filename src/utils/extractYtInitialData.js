/**
 * extractYtInitialData — pulls the `ytInitialData` JSON blob and the
 * page-embedded "this is the video the page is about" id back out of a raw
 * YouTube watch-page HTML string.
 *
 * Exists because `window.ytInitialData` on the *live* page (see
 * pageBridge.js) is a load-once global: YouTube's own client-side
 * navigation (`yt-navigate-finish`) never reassigns it, so after navigating
 * to a second video in the same tab it keeps describing whichever video was
 * on the page at the very first full load — confirmed live, from a real
 * "navigate to a video with neither chapters nor a heatmap, and the
 * previous video's chapters stick around" report: the chapter start times
 * shown for video 2 exactly matched video 1's, well after the URL, the
 * player's own `getPlayerResponse()`, and the `<video>` element itself had
 * all already moved on. content.js works around this by fetching the
 * target video's own watch page directly (see fetchFreshChapters there) and
 * handing the HTML to this module — correct by construction, since it's
 * scoped to a specific videoId rather than any shared, page-global state.
 *
 * `extractBalancedJson` exists instead of a single non-greedy regex over
 * the whole blob (e.g. `/var ytInitialData = (\{.+?\});/`) because that
 * regex's `.+?` stops at the *first* `};` it finds — which can land inside
 * a nested object or a string value well before the real end of a
 * multi-hundred-KB object — rather than the one that actually balances the
 * opening brace. This walks the text counting brace depth instead, so it
 * finds the real end regardless of what's nested inside (verified against
 * real fetched YouTube HTML, including videos with real chapter data).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.ExtractYtInitialData = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  var MARKER = "ytInitialData";
  var MAX_MARKER_TO_BRACE_GAP = 40; // covers `var ytInitialData = {` / `window["ytInitialData"] = {` style assignments
  // How far past "currentVideoEndpoint" to look for its nested videoId —
  // observed ~150 chars away on a real page (clickTrackingParams +
  // commandMetadata sit in between); 300 leaves real margin.
  var CURRENT_VIDEO_ENDPOINT_SCAN_WINDOW = 300;

  function extractBalancedJson(text, openIndex) {
    var depth = 0;
    var inString = false;
    var stringChar = "";
    var escaped = false;
    for (var i = openIndex; i < text.length; i += 1) {
      var ch = text[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === "\\") {
          escaped = true;
        } else if (ch === stringChar) {
          inString = false;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === "{") {
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(openIndex, i + 1);
      }
    }
    return null;
  }

  /**
   * @param {string} html - a full YouTube watch-page HTML document
   * @returns {object|null} the parsed ytInitialData object, or null if it
   *   couldn't be found/parsed (malformed/unexpected page — caller treats
   *   this as "no data", same as every other detection failure mode).
   */
  function extractYtInitialData(html) {
    if (typeof html !== "string" || !html) return null;
    var markerIdx = html.indexOf(MARKER);
    while (markerIdx !== -1) {
      var braceIdx = html.indexOf("{", markerIdx);
      if (braceIdx !== -1 && braceIdx - markerIdx < MAX_MARKER_TO_BRACE_GAP) {
        var jsonText = extractBalancedJson(html, braceIdx);
        if (jsonText) {
          try {
            return JSON.parse(jsonText);
          } catch (_err) {
            // Fall through and try the next "ytInitialData" occurrence.
          }
        }
      }
      markerIdx = html.indexOf(MARKER, markerIdx + 1);
    }
    return null;
  }

  /**
   * The one field in ytInitialData that unambiguously names "the video this
   * page is about" rather than one of the dozens of related/recommended
   * videos also referenced throughout the object (each with their own,
   * indistinguishable-by-shape `"videoId"` field) — used elsewhere
   * (pageBridge.js) to detect when the *live* page's ytInitialData has
   * fallen behind the actual video being watched.
   *
   * @param {object|null} ytInitialData
   * @returns {string|null}
   */
  function currentVideoIdFrom(ytInitialData) {
    if (!ytInitialData) return null;
    try {
      var id = ytInitialData.currentVideoEndpoint
        && ytInitialData.currentVideoEndpoint.watchEndpoint
        && ytInitialData.currentVideoEndpoint.watchEndpoint.videoId;
      return typeof id === "string" ? id : null;
    } catch (_err) {
      return null;
    }
  }

  /**
   * Same lookup as `currentVideoIdFrom`, but scanning raw (not-yet-parsed)
   * JSON text — lets pageBridge.js (which already has to stringify
   * ytInitialData once anyway, to postMessage-clone it) get the id without
   * a second full JSON.parse of a potentially large object.
   *
   * @param {string|null} jsonText
   * @returns {string|null}
   */
  function currentVideoIdFromText(jsonText) {
    if (typeof jsonText !== "string" || !jsonText) return null;
    var markerIdx = jsonText.indexOf('"currentVideoEndpoint"');
    if (markerIdx === -1) return null;
    var window_ = jsonText.slice(markerIdx, markerIdx + CURRENT_VIDEO_ENDPOINT_SCAN_WINDOW);
    var match = /"videoId":"([\w-]{11})"/.exec(window_);
    return match ? match[1] : null;
  }

  return {
    extractYtInitialData: extractYtInitialData,
    extractBalancedJson: extractBalancedJson,
    currentVideoIdFrom: currentVideoIdFrom,
    currentVideoIdFromText: currentVideoIdFromText,
  };
});
