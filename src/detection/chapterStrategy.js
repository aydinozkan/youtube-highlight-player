/**
 * chapterStrategy — Strategy 2: creator-defined or auto-generated chapters.
 *
 * Used when heatmapStrategy finds no "most replayed" data (many videos don't
 * have one — it requires a minimum view count). Chapters live in the same
 * general area of YouTube's page data as the heatmap, under a "markersMap"
 * keyed by e.g. "DESCRIPTION_CHAPTERS" / "AUTO_CHAPTERS", with each entry
 * shaped roughly like `{ chapterRenderer: { title, timeRangeStartMillis } }`.
 *
 * Like heatmapStrategy, this treats that shape as unstable: it does a
 * bounded structural search for anything shaped like a chapter renderer
 * instead of hardcoding the full nested path, and returns [] on any failure
 * so the caller can show a clear "no chapter data" message instead of
 * breaking.
 */
(function (root, factory) {
  var deepFindModule = (root && root.YHP && root.YHP.DeepFind)
    || (typeof require === "function" ? require("../utils/deepFind") : null);
  var api = factory(deepFindModule, root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.ChapterStrategy = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (DeepFind, root) {
  "use strict";

  var deepFind = DeepFind ? DeepFind.deepFind : function () { return []; };

  function isChapterNode(node) {
    if (!node || typeof node !== "object") return false;
    if (node.chapterRenderer && typeof node.chapterRenderer === "object") return true;
    return (
      typeof node.timeRangeStartMillis !== "undefined" &&
      !!node.title &&
      (typeof node.title === "object" || typeof node.title === "string")
    );
  }

  function extractTitle(chapter, fallbackIndex) {
    var title = chapter.title;
    if (typeof title === "string") return title;
    if (title && typeof title.simpleText === "string") return title.simpleText;
    if (title && Array.isArray(title.runs)) {
      var joined = title.runs.map(function (r) { return r.text || ""; }).join("");
      if (joined) return joined;
    }
    return "Chapter " + (fallbackIndex + 1);
  }

  function extractRawChapterNodes(pageData) {
    if (!pageData) return [];
    var roots = [pageData.ytInitialData, pageData.playerResponse].filter(Boolean);
    var found = [];
    for (var i = 0; i < roots.length; i += 1) {
      try {
        found = found.concat(deepFind(roots[i], isChapterNode, { maxDepth: 16 }));
      } catch (_err) {
        // Ignore and try the other root.
      }
    }
    return found;
  }

  /**
   * See heatmapStrategy.js's identical helper for the full reasoning —
   * this is specifically for a genuine, unexpected exception during
   * parsing, not the ordinary "no chapter data present" case (extractRaw
   * ChapterNodes already returns [] for that with nothing thrown, so
   * parseChapters below just produces [] naturally, no exception, nothing
   * to report). `opts.errorReporter` lets tests inject a fake reporter;
   * production falls back to `root.YHP.ErrorReporter`.
   */
  function reportParseError(err, opts) {
    try {
      var reporter = opts.errorReporter || (root && root.YHP && root.YHP.ErrorReporter);
      if (reporter && typeof reporter.report === "function") {
        reporter.report(err, { context: "chapterStrategy", extra: { phase: "parseChapters" } });
      }
    } catch (_reportErr) {
      // Reporting the failure must never itself become a new failure.
    }
  }

  /**
   * @param {{ytInitialData?: object, playerResponse?: object}} pageData
   * @param {number} [videoDuration] - used to give the final chapter an end time
   * @param {{errorReporter?: {report: Function}}} [opts] - errorReporter
   *   is injectable for testing; see reportParseError.
   * @returns {Array<{id:string, title:string, startTime:number, endTime:number}>}
   */
  function parseChapters(pageData, videoDuration, opts) {
    try {
      var rawNodes = extractRawChapterNodes(pageData);

      var starts = {};
      var partial = [];
      for (var i = 0; i < rawNodes.length; i += 1) {
        var node = rawNodes[i].chapterRenderer || rawNodes[i];
        var startMs = Number(node.timeRangeStartMillis);
        if (!Number.isFinite(startMs) || starts[startMs]) continue;
        starts[startMs] = true;
        partial.push({ startMs: startMs, title: node.title });
      }

      partial.sort(function (a, b) { return a.startMs - b.startMs; });

      var total = Number.isFinite(videoDuration) && videoDuration > 0 ? videoDuration : undefined;

      return partial.map(function (chapter, index) {
        var startTime = chapter.startMs / 1000;
        var next = partial[index + 1];
        var endTime = next ? next.startMs / 1000 : total;
        if (!Number.isFinite(endTime)) endTime = startTime;
        return {
          id: "chapter-" + index,
          title: extractTitle(chapter, index),
          startTime: startTime,
          endTime: Math.max(endTime, startTime),
        };
      });
    } catch (err) {
      // Treat YouTube's page data shape as unstable: fail closed, not
      // loud — but still worth knowing about, see reportParseError.
      reportParseError(err, opts || {});
      return [];
    }
  }

  function isAvailable(pageData) {
    return parseChapters(pageData).length > 0;
  }

  return { parseChapters: parseChapters, isAvailable: isAvailable };
});
