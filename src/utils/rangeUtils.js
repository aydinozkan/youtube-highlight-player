/**
 * rangeUtils — pure, dependency-free functions for working with time intervals.
 *
 * Every function here takes plain data in and returns plain data out. None of
 * them touch the DOM, chrome.* APIs, or YouTube. That's deliberate: it's what
 * makes them unit-testable in plain Node (see tests/rangeUtils.test.js) and
 * safe to reuse from both the heatmap and chapter detection strategies.
 *
 * Interval shape used throughout: { startTime: seconds, endTime: seconds, score?: 0..1 }
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.RangeUtils = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function duration(interval) {
    return Math.max(0, interval.endTime - interval.startTime);
  }

  /** Chronological copy of `intervals`, sorted by startTime ascending. Does not mutate input. */
  function sortIntervals(intervals) {
    return (intervals || []).slice().sort(function (a, b) {
      return a.startTime - b.startTime;
    });
  }

  /**
   * Clamp every interval's start/end into [0, totalDuration], dropping any
   * interval that collapses to zero (or negative) length after clamping.
   */
  function clampIntervals(intervals, totalDuration) {
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) return [];
    var out = [];
    for (var i = 0; i < (intervals || []).length; i += 1) {
      var interval = intervals[i];
      var startTime = Math.min(Math.max(interval.startTime, 0), totalDuration);
      var endTime = Math.min(Math.max(interval.endTime, 0), totalDuration);
      if (endTime - startTime <= 0) continue;
      var clamped = { startTime: startTime, endTime: endTime };
      if (typeof interval.score === "number") clamped.score = interval.score;
      out.push(clamped);
    }
    return out;
  }

  /**
   * Merge overlapping intervals, and any two intervals separated by no more
   * than `gapThreshold` seconds. Merged scores are duration-weighted so a
   * long low-score neighbor doesn't get silently overwritten by a short
   * high-score one (or vice versa).
   */
  function mergeIntervals(intervals, gapThreshold) {
    var gap = typeof gapThreshold === "number" ? gapThreshold : 0;
    var sorted = sortIntervals(intervals);
    var merged = [];

    for (var i = 0; i < sorted.length; i += 1) {
      var interval = sorted[i];
      var last = merged[merged.length - 1];

      if (last && interval.startTime <= last.endTime + gap) {
        var lastDur = duration(last);
        var curDur = duration(interval);
        var totalDur = lastDur + curDur;
        var lastScore = typeof last.score === "number" ? last.score : 0;
        var curScore = typeof interval.score === "number" ? interval.score : 0;

        last.endTime = Math.max(last.endTime, interval.endTime);
        last.score = totalDur > 0
          ? (lastScore * lastDur + curScore * curDur) / totalDur
          : Math.max(lastScore, curScore);
      } else {
        merged.push({
          startTime: interval.startTime,
          endTime: interval.endTime,
          score: typeof interval.score === "number" ? interval.score : 0,
        });
      }
    }

    return merged;
  }

  /**
   * The most common score value among `intervals`, rounded to 3 decimals —
   * i.e. the flat "baseline" a real heatmap sits at outside its actual
   * replay spikes. Returns null when nothing looks like a genuine
   * repeated baseline (too few samples, or no value repeats enough to
   * mean anything) — callers should treat null as "don't filter".
   */
  function computeBaselineScore(intervals) {
    if (intervals.length < 10) return null; // too few samples for "baseline" to be a meaningful concept
    var counts = {};
    var bestKey = null;
    var bestCount = 0;
    intervals.forEach(function (iv) {
      var key = (typeof iv.score === "number" ? iv.score : 0).toFixed(3);
      counts[key] = (counts[key] || 0) + 1;
      if (counts[key] > bestCount) {
        bestCount = counts[key];
        bestKey = key;
      }
    });
    if (bestKey === null) return null;
    var isDominant = bestCount / intervals.length >= 0.3; // repeats across ≥30% of samples
    return isDominant ? Number(bestKey) : null;
  }

  /**
   * Rank intervals by score and greedily keep the top (or bottom) ones until
   * their combined duration reaches `percentage` of `totalDuration`.
   *
   * @param {Array} intervals
   * @param {number} percentage - 0..1, fraction of totalDuration to select
   * @param {number} totalDuration - seconds; used as the target basis
   * @param {'top'|'bottom'} [direction] - 'top' selects highest-scoring
   *   (used for "most replayed"); 'bottom' selects lowest-scoring (used for
   *   "skip filler", where the caller inverts the result afterward).
   *
   * For 'top', once a genuine flat baseline is detected (see
   * computeBaselineScore), only samples scoring strictly above it are ever
   * candidates — a mostly-flat heatmap with one real spike selects just
   * that spike (even if it falls well short of `percentage`), rather than
   * padding out the selection with arbitrary baseline-tied filler just to
   * hit a duration quota. 'bottom' (skip-filler) is unaffected — filler IS
   * what it's supposed to find.
   */
  function selectTopIntervals(intervals, percentage, totalDuration, direction) {
    var list = intervals || [];
    if (!list.length || !(percentage > 0)) return [];

    var dir = direction === "bottom" ? "bottom" : "top";

    var candidates = list;
    if (dir === "top") {
      var baseline = computeBaselineScore(list);
      if (baseline !== null) {
        var aboveBaseline = list.filter(function (iv) {
          return (typeof iv.score === "number" ? iv.score : 0) > baseline;
        });
        if (aboveBaseline.length) candidates = aboveBaseline;
      }
    }

    var pct = Math.min(1, Math.max(0, percentage));
    var basis = Number.isFinite(totalDuration) && totalDuration > 0
      ? totalDuration
      : list.reduce(function (sum, i) { return sum + duration(i); }, 0);
    var targetDuration = basis * pct;

    var ranked = candidates.slice().sort(function (a, b) {
      var scoreA = typeof a.score === "number" ? a.score : 0;
      var scoreB = typeof b.score === "number" ? b.score : 0;
      return dir === "top" ? scoreB - scoreA : scoreA - scoreB;
    });

    var selected = [];
    var accumulated = 0;
    for (var i = 0; i < ranked.length; i += 1) {
      if (accumulated >= targetDuration) break;
      selected.push(ranked[i]);
      accumulated += duration(ranked[i]);
    }
    return selected;
  }

  /** Expand every interval's bounds by fixed padding. Does not clamp — call clampIntervals after. */
  function addPadding(intervals, paddingBefore, paddingAfter) {
    var before = paddingBefore || 0;
    var after = paddingAfter || 0;
    return (intervals || []).map(function (interval) {
      var padded = {
        startTime: interval.startTime - before,
        endTime: interval.endTime + after,
      };
      if (typeof interval.score === "number") padded.score = interval.score;
      return padded;
    });
  }

  /** Sum of (endTime - startTime) across all intervals. */
  function calcSelectedDuration(intervals) {
    return (intervals || []).reduce(function (sum, i) { return sum + duration(i); }, 0);
  }

  /** How many seconds a viewer skips by only watching `intervals` out of a video of `totalDuration`. */
  function calcTimeSaved(intervals, totalDuration) {
    if (!Number.isFinite(totalDuration)) return 0;
    return Math.max(0, totalDuration - calcSelectedDuration(intervals));
  }

  /** The interval containing `time`, or null. Half-open: [startTime, endTime). */
  function findCurrentInterval(intervals, time) {
    var list = intervals || [];
    for (var i = 0; i < list.length; i += 1) {
      if (time >= list[i].startTime && time < list[i].endTime) return list[i];
    }
    return null;
  }

  /** The chronologically-next interval that starts after `time`, or null if none remain. */
  function findNextInterval(intervals, time) {
    var sorted = sortIntervals(intervals);
    for (var i = 0; i < sorted.length; i += 1) {
      if (sorted[i].startTime > time) return sorted[i];
    }
    return null;
  }

  /** The chronologically-previous interval that starts before `time`, or null if none precede it. Mirrors findNextInterval. */
  function findPreviousInterval(intervals, time) {
    var sorted = sortIntervals(intervals);
    for (var i = sorted.length - 1; i >= 0; i -= 1) {
      if (sorted[i].startTime < time) return sorted[i];
    }
    return null;
  }

  /**
   * The gaps *between* a set of (assumed merged/sorted) cut intervals, over
   * [0, totalDuration] — i.e. "everything except these intervals". Used by
   * skip-filler mode: the lowest-scoring segments are the ones selected for
   * removal, and complementIntervals turns "removed" into "retained".
   */
  function complementIntervals(intervals, totalDuration) {
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) return [];
    var merged = mergeIntervals(intervals, 0);
    var result = [];
    var cursor = 0;

    for (var i = 0; i < merged.length; i += 1) {
      var start = Math.min(Math.max(merged[i].startTime, 0), totalDuration);
      var end = Math.min(Math.max(merged[i].endTime, 0), totalDuration);
      if (start > cursor) {
        result.push({ startTime: cursor, endTime: start, score: 0 });
      }
      cursor = Math.max(cursor, end);
    }

    if (cursor < totalDuration) {
      result.push({ startTime: cursor, endTime: totalDuration, score: 0 });
    }

    return result;
  }

  /**
   * Full pipeline for "keep the top N%": select -> merge -> pad -> re-merge
   * (padding can create new overlaps) -> clamp -> sort chronologically.
   */
  function buildHighlightRanges(rawSamples, options) {
    var opts = options || {};
    var percentage = typeof opts.percentage === "number" ? opts.percentage : 0.2;
    var paddingBefore = typeof opts.paddingBefore === "number" ? opts.paddingBefore : 1;
    var paddingAfter = typeof opts.paddingAfter === "number" ? opts.paddingAfter : 1;
    var totalDuration = opts.duration || 0;
    var mergeGap = typeof opts.mergeGap === "number" ? opts.mergeGap : 1;

    var selected = selectTopIntervals(rawSamples, percentage, totalDuration, "top");
    var mergedOnce = mergeIntervals(selected, mergeGap);
    var padded = addPadding(mergedOnce, paddingBefore, paddingAfter);
    var mergedTwice = mergeIntervals(padded, mergeGap);
    var clamped = clampIntervals(mergedTwice, totalDuration);
    return sortIntervals(clamped);
  }

  return {
    sortIntervals: sortIntervals,
    clampIntervals: clampIntervals,
    mergeIntervals: mergeIntervals,
    computeBaselineScore: computeBaselineScore,
    selectTopIntervals: selectTopIntervals,
    addPadding: addPadding,
    calcSelectedDuration: calcSelectedDuration,
    calcTimeSaved: calcTimeSaved,
    findCurrentInterval: findCurrentInterval,
    findNextInterval: findNextInterval,
    findPreviousInterval: findPreviousInterval,
    complementIntervals: complementIntervals,
    buildHighlightRanges: buildHighlightRanges,
  };
});
