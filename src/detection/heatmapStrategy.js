/**
 * heatmapStrategy — Strategy 1: YouTube's "Most replayed" heatmap.
 *
 * Ground-truth finding (verified against a live page, Aug 2026): the
 * heatmap is NOT reachable as a plain JS object. `ytInitialData`'s
 * `multiMarkersPlayerBarRenderer` is just a placeholder —
 * `{ visibleOnLoad: { key: "" } }` — pointing at an internal "entity key"
 * (its base64 payload literally decodes to the string "HEATSEEKER") that
 * YouTube resolves asynchronously via its own network/entity-store
 * machinery. That resolved data never lands back in `ytInitialData` or
 * `getPlayerResponse()`, so no amount of deep-searching those objects
 * finds it (an earlier version of this file tried exactly that, and came
 * up empty on a video that clearly had heatmap data).
 *
 * What IS reliable: YouTube renders the heatmap as one or more
 *   <div class="ytp-heat-map-chapter"> ... <svg class="ytp-heat-map-svg"
 *     viewBox="0 0 1000 100">
 *       <path class="ytp-modern-heat-map" d="M 0.0,100.0 C 1.0,91.8 ..." />
 *   </svg></div>
 * inside `.ytp-heat-map-container`, directly on the progress bar. That's
 * plain DOM — visible to an isolated-world content script with no MAIN-
 * world bridging needed — and it can't drift from what a viewer actually
 * sees the way reverse-engineering a private data schema can. The x axis
 * (0–1000, or whatever the SVG's viewBox says) maps linearly to time
 * across that chapter's span; the y axis (0–100, default) is *inverted*
 * intensity: y=0 is the top of the graph (highest replay activity), y=100
 * is the baseline (least). Multiple `.ytp-heat-map-chapter` elements show
 * up for videos with manual chapters, laid out left-to-right by inline
 * pixel `width`/`left` styles that sum to the full progress-bar width.
 *
 * Path parsing and the coordinate math are pure functions (no DOM), so
 * they're unit-tested directly against a captured real `d` string — see
 * tests/detection.test.js. Only extractHeatmapFromDom touches `document`.
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.HeatmapStrategy = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (root) {
  "use strict";

  function clamp01(n) {
    return Math.min(1, Math.max(0, n));
  }

  /**
   * Parses an SVG path `d` string of the form YouTube emits for the
   * heatmap ("M x,y" followed by any number of "C cx1,cy1 cx2,cy2 x,y"
   * segments) into its on-curve data points, discarding bezier control
   * points (they're smoothing handles, not distinct samples). Unknown
   * command letters are ignored rather than throwing, since a future
   * YouTube change to the curve style shouldn't crash detection — it
   * would just mean fewer/no points get extracted, which callers already
   * treat as "no heatmap available".
   *
   * @param {string} d
   * @returns {Array<{x:number, y:number}>}
   */
  function parseHeatmapPathPoints(d) {
    if (!d || typeof d !== "string") return [];
    var points = [];
    var re = /([MC])([^MC]*)/g;
    var match;
    while ((match = re.exec(d)) !== null) {
      var type = match[1];
      var nums = match[2]
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(Number);
      if (nums.some(function (n) { return !Number.isFinite(n); })) continue;

      if (type === "M" && nums.length >= 2) {
        points.push({ x: nums[0], y: nums[1] });
      } else if (type === "C" && nums.length >= 6) {
        points.push({ x: nums[4], y: nums[5] }); // endpoint only; skip the two control points
      }
    }
    return points;
  }

  /**
   * Converts on-curve points in SVG viewBox space into normalized
   * `{startTime, endTime, score}` samples, one per gap between
   * consecutive points, mapped linearly onto [startTime, endTime].
   *
   * @param {Array<{x:number,y:number}>} points
   * @param {number} startTime - seconds, chapter's start in the video
   * @param {number} endTime - seconds, chapter's end in the video
   * @param {number} viewBoxWidth - SVG viewBox width (x domain), default 1000
   * @param {number} viewBoxHeight - SVG viewBox height (y domain), default 100
   */
  function pointsToSamples(points, startTime, endTime, viewBoxWidth, viewBoxHeight) {
    if (!points || points.length < 2) return [];
    if (!(endTime > startTime)) return [];

    var w = viewBoxWidth > 0 ? viewBoxWidth : 1000;
    var h = viewBoxHeight > 0 ? viewBoxHeight : 100;
    var span = endTime - startTime;

    var timed = points.map(function (p) {
      var frac = clamp01(p.x / w);
      return {
        time: startTime + frac * span,
        score: clamp01((h - p.y) / h), // y is inverted: 0 = highest intensity
      };
    });

    var samples = [];
    for (var i = 0; i < timed.length - 1; i += 1) {
      var a = timed[i];
      var b = timed[i + 1];
      if (b.time <= a.time) continue; // guard against duplicate/degenerate x (path end-cap artifacts)
      samples.push({ startTime: a.time, endTime: b.time, score: (a.score + b.score) / 2 });
    }
    return samples;
  }

  function parseViewBox(svgEl) {
    var attr = svgEl && svgEl.getAttribute && svgEl.getAttribute("viewBox");
    if (!attr) return { width: 1000, height: 100 };
    var parts = attr.trim().split(/[\s,]+/).map(Number);
    if (parts.length !== 4 || !(parts[2] > 0) || !(parts[3] > 0)) return { width: 1000, height: 100 };
    return { width: parts[2], height: parts[3] };
  }

  /** Chronological, proportionally-sized time spans for each heat-map chapter, from their inline pixel widths. */
  function readChapterSpans(containerEl, totalDuration) {
    var chapterEls = Array.prototype.slice.call(containerEl.querySelectorAll(".ytp-heat-map-chapter"));
    if (!chapterEls.length) return [];

    var widths = chapterEls.map(function (el) {
      var styleWidth = el.style && parseFloat(el.style.width);
      if (styleWidth > 0) return styleWidth;
      var rect = el.getBoundingClientRect && el.getBoundingClientRect();
      return (rect && rect.width) || 0;
    });
    var totalWidth = widths.reduce(function (a, b) { return a + b; }, 0);
    if (!(totalWidth > 0)) return [];

    var cursor = 0;
    return chapterEls.map(function (el, i) {
      var chapterStart = (cursor / totalWidth) * totalDuration;
      cursor += widths[i];
      var chapterEnd = (cursor / totalWidth) * totalDuration;
      return { el: el, startTime: chapterStart, endTime: chapterEnd };
    });
  }

  /** Prefer the modern heat-map path; fall back to any path in the chapter that actually has curve data. */
  function findHeatmapPathEl(chapterEl) {
    var preferred = chapterEl.querySelector("path.ytp-modern-heat-map");
    if (preferred && preferred.getAttribute("d")) return preferred;

    var candidates = Array.prototype.slice.call(chapterEl.querySelectorAll("path"));
    for (var i = 0; i < candidates.length; i += 1) {
      if (candidates[i].getAttribute("d")) return candidates[i];
    }
    return null;
  }

  function extractHeatmapFromDom(doc, totalDuration) {
    if (!doc || !(totalDuration > 0)) return [];
    var container = doc.querySelector(".ytp-heat-map-container");
    if (!container) return [];

    var spans = readChapterSpans(container, totalDuration);
    var samples = [];
    spans.forEach(function (span) {
      var pathEl = findHeatmapPathEl(span.el);
      if (!pathEl) return;
      var points = parseHeatmapPathPoints(pathEl.getAttribute("d"));
      var viewBox = parseViewBox(span.el.querySelector("svg"));
      samples = samples.concat(
        pointsToSamples(points, span.startTime, span.endTime, viewBox.width, viewBox.height)
      );
    });
    return samples.sort(function (a, b) { return a.startTime - b.startTime; });
  }

  /**
   * Reports a genuinely unexpected exception from extractHeatmapFromDom —
   * deliberately NOT the ordinary "no `.ytp-heat-map-container` for this
   * video" case (that's an early `return []` inside extractHeatmapFromDom
   * itself, no exception ever thrown, nothing to report — and correctly
   * so, since the overwhelming majority of ordinary videos simply don't
   * have "most replayed" data; reporting that would be pure noise, not
   * signal). This is specifically for the rarer case where YouTube's
   * markup changed enough to break an assumption *inside* the parsing
   * code and it actually threw — a real, narrow "something we didn't
   * anticipate just happened" signal, and one errorReporter's global
   * `error`/`unhandledrejection` listeners can never see on their own,
   * since this exception is caught right here and never becomes
   * "uncaught."
   *
   * `options.errorReporter` lets tests inject a fake reporter directly
   * (so a test never triggers a real network call); production leaves it
   * unset and falls back to the real one already loaded into this page —
   * errorReporter.js loads before this file in manifest.json's
   * content_scripts list, so `root.YHP.ErrorReporter` is reliably there
   * by the time parseHeatmap ever runs.
   */
  function reportParseError(err, opts) {
    try {
      var reporter = opts.errorReporter || (root && root.YHP && root.YHP.ErrorReporter);
      if (reporter && typeof reporter.report === "function") {
        reporter.report(err, { context: "heatmapStrategy", extra: { phase: "parseHeatmap" } });
      }
    } catch (_reportErr) {
      // Reporting the failure must never itself become a new failure.
    }
  }

  /**
   * @param {{duration: number, doc?: Document, errorReporter?: {report: Function}}} options -
   *   `doc` is injectable for testing; defaults to the real `document` in
   *   a browser. `errorReporter` is injectable for testing; defaults to
   *   `root.YHP.ErrorReporter` in production — see reportParseError.
   * @returns {Array<{startTime:number, endTime:number, score:number}>}
   */
  function parseHeatmap(options) {
    var opts = options || {};
    var doc = opts.doc || (typeof document !== "undefined" ? document : null);
    var duration = opts.duration || 0;
    try {
      return extractHeatmapFromDom(doc, duration);
    } catch (err) {
      // Treat YouTube's player markup as unstable: fail closed, not loud —
      // but still worth knowing about, see reportParseError.
      reportParseError(err, opts);
      return [];
    }
  }

  function isAvailable(options) {
    return parseHeatmap(options).length > 0;
  }

  return {
    parseHeatmap: parseHeatmap,
    isAvailable: isAvailable,
    // exported for unit testing:
    parseHeatmapPathPoints: parseHeatmapPathPoints,
    pointsToSamples: pointsToSamples,
  };
});
