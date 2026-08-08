/**
 * detectionManager — composes the detection strategies and turns raw
 * signals into playable ranges.
 *
 * Split into two phases so the (relatively expensive, page-data-dependent)
 * extraction only has to run once per video:
 *
 *   1. fetchRawSignals(pageData, duration) — runs BOTH strategies
 *      independently and returns whatever each found. Deliberately does
 *      NOT decide "which source wins" — a video can have both a heatmap
 *      and chapters at once (the panel now shows a tab switcher for that
 *      case; see panel.js), so picking one here would silently throw the
 *      other away before the UI ever got a chance to know it existed. An
 *      earlier version returned an exclusive `source` field and only
 *      parsed chapters as a fallback when the heatmap came back empty —
 *      fine when only one source could ever matter, but it meant there
 *      was no way to detect "this video has both" at all. Callers decide
 *      what to do with two independent result arrays now.
 *
 *   2. computeHeatmapRanges / rangesFromChapterSelection — pure(ish)
 *      recomputation from the cached raw signals whenever the user changes
 *      mode/percentage/padding/chapter-selection in the panel. No re-fetch
 *      needed.
 *
 * Adding a future strategy (transcript analysis, SponsorBlock) means adding
 * another module with the same `{ parseX, isAvailable }` shape and calling
 * it alongside the two below — nothing else has to change.
 */
(function (root, factory) {
  var RangeUtils = (root && root.YHP && root.YHP.RangeUtils)
    || (typeof require === "function" ? require("../utils/rangeUtils") : null);
  var HeatmapStrategy = (root && root.YHP && root.YHP.HeatmapStrategy)
    || (typeof require === "function" ? require("./heatmapStrategy") : null);
  var ChapterStrategy = (root && root.YHP && root.YHP.ChapterStrategy)
    || (typeof require === "function" ? require("./chapterStrategy") : null);

  var api = factory(RangeUtils, HeatmapStrategy, ChapterStrategy);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.DetectionManager = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (RangeUtils, HeatmapStrategy, ChapterStrategy) {
  "use strict";

  /**
   * @param {object} pageData - from dataBridge; used for chapter parsing
   * @param {number} duration
   * @param {{doc?: Document}} [heatmapOptions] - forwarded to
   *   HeatmapStrategy.parseHeatmap; lets tests inject a fake `document`.
   * @returns {{heatmapSamples: Array, chapters: Array}}
   */
  function fetchRawSignals(pageData, duration, heatmapOptions) {
    var heatmapSamples = HeatmapStrategy.parseHeatmap(
      Object.assign({ duration: duration }, heatmapOptions)
    );
    var chapters = ChapterStrategy.parseChapters(pageData, duration);
    return { heatmapSamples: heatmapSamples, chapters: chapters };
  }

  /**
   * @param {Array} heatmapSamples
   * @param {{mode: 'most-replayed'|'skip-filler'|'custom-percentage', percentage:number,
   *          paddingBefore:number, paddingAfter:number, mergeGap:number, duration:number}} opts
   */
  function computeHeatmapRanges(heatmapSamples, opts) {
    var duration = opts.duration || 0;
    var paddingBefore = opts.paddingBefore || 0;
    var paddingAfter = opts.paddingAfter || 0;
    var mergeGap = typeof opts.mergeGap === "number" ? opts.mergeGap : 1;

    if (opts.mode === "skip-filler") {
      // Select the *lowest*-scoring segments as the ones to cut, pad/merge
      // those cut segments the same way a normal selection would be, then
      // keep everything that's left (the complement).
      var cut = RangeUtils.selectTopIntervals(heatmapSamples, opts.percentage, duration, "bottom");
      var paddedCut = RangeUtils.addPadding(RangeUtils.sortIntervals(cut), paddingBefore, paddingAfter);
      var mergedCut = RangeUtils.mergeIntervals(RangeUtils.sortIntervals(paddedCut), mergeGap);
      var clampedCut = RangeUtils.clampIntervals(mergedCut, duration);
      return RangeUtils.complementIntervals(clampedCut, duration);
    }

    // 'most-replayed' and 'custom-percentage' both keep the top-scoring slice;
    // they differ only in how the panel lets the user pick `percentage`.
    return RangeUtils.buildHighlightRanges(heatmapSamples, {
      percentage: opts.percentage,
      paddingBefore: paddingBefore,
      paddingAfter: paddingAfter,
      duration: duration,
      mergeGap: mergeGap,
    });
  }

  /**
   * Turn a user-picked subset of chapters into playable ranges (chapters
   * are already chronological, non-overlapping spans, so this is mostly
   * pad + re-merge + clamp).
   *
   * One deliberate deviation from the heatmap path: chapters are discrete,
   * creator-defined units, and adjacent ones routinely *touch* exactly at a
   * shared boundary (one chapter's endTime equals the next one's
   * startTime) — that's normal, not an artifact of padding/overlap the way
   * it would be for heatmap clusters. Fusing two touching-but-both-selected
   * chapters into one range would silently drop a chapter from "next/
   * previous chapter" navigation and from the panel's "Chapter X of Y"
   * count, so the merge gap is floored just below zero here: only genuine
   * overlap (which nonzero padding could still introduce) merges: a
   * shared boundary alone never does. Each selected chapter stays its own
   * independently steppable/countable range.
   */
  function rangesFromChapterSelection(selectedChapters, opts) {
    var options = opts || {};
    var duration = options.duration || 0;
    var paddingBefore = options.paddingBefore || 0;
    var paddingAfter = options.paddingAfter || 0;
    var mergeGap = typeof options.mergeGap === "number" ? options.mergeGap : 0;

    var base = (selectedChapters || []).map(function (c) {
      return { startTime: c.startTime, endTime: c.endTime, score: 1 };
    });
    var padded = RangeUtils.addPadding(RangeUtils.sortIntervals(base), paddingBefore, paddingAfter);
    var merged = RangeUtils.mergeIntervals(RangeUtils.sortIntervals(padded), Math.min(mergeGap, -0.001));
    return RangeUtils.clampIntervals(merged, duration);
  }

  return {
    fetchRawSignals: fetchRawSignals,
    computeHeatmapRanges: computeHeatmapRanges,
    rangesFromChapterSelection: rangesFromChapterSelection,
  };
});
