/**
 * pageBridge — runs in the page's own JS context (manifest "world": "MAIN"),
 * NOT the extension's isolated content-script world.
 *
 * Heatmap and chapter data only exist as JS objects inside YouTube's own
 * page scripts (`ytInitialData`, and the player's `getPlayerResponse()`).
 * An isolated-world content script cannot read those directly — it only
 * shares the DOM with the page, not its JS heap. So this script's only job
 * is: on request, grab whatever raw data it can reach, JSON-round-trip it
 * (also strips functions/cycles so postMessage's structured clone can't
 * choke on it), and hand it back over `window.postMessage`.
 *
 * Deliberately dumb: no heatmap/chapter-specific parsing happens here. That
 * logic is isolated in detection/heatmapStrategy.js and
 * detection/chapterStrategy.js, which run in the isolated world on whatever
 * this script hands them. This file only knows how to *reach* the data, not
 * what it means.
 */
(function () {
  "use strict";

  var NAMESPACE = "YHP";
  var REQUEST_TYPE = "YHP_REQUEST_PAGE_DATA";
  var RESPONSE_TYPE = "YHP_PAGE_DATA_RESPONSE";

  function safeGet(fn) {
    try {
      return fn();
    } catch (_err) {
      return undefined;
    }
  }

  function safeClone(value) {
    if (value === null || typeof value === "undefined") return null;
    try {
      return JSON.parse(JSON.stringify(value));
    } catch (_err) {
      return null;
    }
  }

  // `window.ytInitialData` (below) is a load-once global: YouTube's own
  // client-side navigation never reassigns it, so on the second+ video
  // visited in a tab it can keep describing whichever video was on the
  // page at the very first full load — confirmed live (see
  // extractYtInitialData.js's header comment for the full story). This
  // extracts the one field in ytInitialData that unambiguously names "the
  // video this page is actually about" (as opposed to any of the dozens of
  // related/recommended videos also referenced throughout the same object,
  // each with their own indistinguishable-by-shape `"videoId"` field), so
  // content.js can tell whether the ytInitialData it just received is
  // trustworthy for the video it's currently initializing, or needs to be
  // fetched fresh over the network instead (see content.js's
  // fetchFreshChapters). Deliberately duplicated here in miniature rather
  // than sharing src/utils/extractYtInitialData.js's fuller version — this
  // script runs in the page's own MAIN-world JS context, which can't load
  // the isolated world's modules (that's the whole reason this bridge
  // exists at all).
  var CURRENT_VIDEO_ENDPOINT_SCAN_WINDOW = 300;
  function currentVideoIdFromText(jsonText) {
    if (typeof jsonText !== "string" || !jsonText) return null;
    var markerIdx = jsonText.indexOf('"currentVideoEndpoint"');
    if (markerIdx === -1) return null;
    var window_ = jsonText.slice(markerIdx, markerIdx + CURRENT_VIDEO_ENDPOINT_SCAN_WINDOW);
    var match = /"videoId":"([\w-]{11})"/.exec(window_);
    return match ? match[1] : null;
  }

  function getYtInitialData() {
    return safeGet(function () { return window.ytInitialData; })
      || safeGet(function () {
        var el = document.getElementById("initial-data");
        return el ? JSON.parse(el.textContent) : undefined;
      });
  }

  function getPlayerResponse() {
    return safeGet(function () { return document.querySelector("#movie_player").getPlayerResponse(); })
      || safeGet(function () { return document.querySelector("ytd-player").getPlayerResponse(); })
      || safeGet(function () { return window.ytInitialPlayerResponse; })
      || safeGet(function () { return window.ytplayer.config.args.raw_player_response; });
  }

  function getVideoId() {
    return safeGet(function () { return new URLSearchParams(window.location.search).get("v"); })
      || safeGet(function () { return document.querySelector("#movie_player").getVideoData().video_id; })
      || null;
  }

  function getDuration() {
    var fromApi = safeGet(function () { return document.querySelector("#movie_player").getDuration(); });
    if (typeof fromApi === "number" && fromApi > 0) return fromApi;
    var fromVideo = safeGet(function () { return document.querySelector("video").duration; });
    return typeof fromVideo === "number" && fromVideo > 0 ? fromVideo : 0;
  }

  function collectPageData() {
    // Stringified once and reused for both the clone (JSON.parse below)
    // and the freshness check (currentVideoIdFromText) — ytInitialData can
    // be several hundred KB, and this runs on every poll tick, so avoiding
    // a second full JSON.stringify of the same object matters here.
    var ytInitialDataText = safeGet(function () { return JSON.stringify(getYtInitialData()); });
    var ytInitialDataParsed = safeGet(function () {
      return ytInitialDataText ? JSON.parse(ytInitialDataText) : null;
    });
    return {
      videoId: getVideoId(),
      duration: getDuration(),
      ytInitialData: ytInitialDataParsed || null,
      ytInitialDataVideoId: currentVideoIdFromText(ytInitialDataText),
      playerResponse: safeClone(getPlayerResponse()),
      capturedAt: Date.now(),
    };
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    var msg = event.data;
    if (!msg || msg.namespace !== NAMESPACE || msg.type !== REQUEST_TYPE) return;

    var payload = null;
    var error = null;
    try {
      payload = collectPageData();
    } catch (err) {
      error = String((err && err.message) || err);
    }

    window.postMessage({
      namespace: NAMESPACE,
      type: RESPONSE_TYPE,
      requestId: msg.requestId,
      payload: payload,
      error: error,
    }, "*");
  });
})();
