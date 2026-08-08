/**
 * rangeOverlay — the timeline/waveform visualization and its interaction
 * (hover preview, click/drag-to-seek, live playhead, active-segment glow).
 *
 * Visual design (redesigned per the glassmorphic HUD direction — colored
 * this time, a deliberate reversal of an earlier monochrome-white pass that
 * matched YouTube's own heat-map look):
 *  - ONE continuous smooth curve across the whole video (Catmull-Rom
 *    smoothing through the raw score samples, converted to cubic beziers).
 *    Height encodes replay score, same as YouTube's own graph.
 *  - Fill + stroke use a violet(#7B5CF0)→magenta(#D24FC8) gradient
 *    positioned along the timeline by score, so density peaks read as
 *    magenta and the baseline reads as violet — "area-chart style".
 *  - No permanent marking of retained-vs-skipped spans — an earlier pass
 *    masked skipped spans and dimmed inactive-retained ones, but the
 *    resulting hard-edged alternating blocks fought the continuous-
 *    waveform feel and added visual noise the curve's own gradient peaks
 *    already communicate. The *only* overlay drawn is a bright, glowing
 *    path tracing just the currently-playing segment's own portion of the
 *    curve (buildActiveGlowPathD / paintActiveOverlays /
 *    updateActiveSegment) — no filled background shape at all, so it
 *    can't read as a plain dark block the way a translucent rect did
 *    wherever the underlying peak was weak. That path is *trimmed* from
 *    the real curve (De Casteljau bezier splitting — see
 *    trimCurveToXRange), not re-fit from a smaller point subset and not a
 *    clip-path'd copy of the rendered whole: re-fitting from just the
 *    points inside a short range starved the curve of tangent context and
 *    silently flattened short highlights into a near-straight line, and
 *    clip-path slices a *filtered* element's already-blurred drop-shadow
 *    off in a hard rectangle right at the clip boundary (a faint straight
 *    edge against the dark track instead of a taper). Trimming the real,
 *    already-correctly-shaped curve avoids both: it matches the visible
 *    curve exactly at any length, and its own two (round-linecap) ends are
 *    simply where the glow radiates from. Repainted cheaply on every
 *    range-index change, not every timeupdate tick. Which spans are
 *    clickable is still tracked (see below) — it's just never drawn as a
 *    block.
 *  - Every *retained* highlight renders at least HIGHLIGHT_FLOOR of the
 *    track's height, however low its real score is (buildCurvePoints) —
 *    a highlight is still a real, clickable, navigable segment even at
 *    score ~0, and a fully flat peak made it undiscoverable. Only
 *    height/shape is floored; color (buildGradientStops) still reflects
 *    the true raw score, and non-highlighted baseline/skipped stretches
 *    of the curve are never floored, so the waveform still reads as
 *    genuinely quiet there.
 *
 * Interaction: the whole track is a single pointer target (drag-anywhere,
 * not just a thin handle — a bigger, more forgiving hit area), and that
 * hit-testing (findRangeAt / snapToNearestRange) runs purely against the
 * `ranges` data, independent of anything drawn — so it wasn't affected by
 * dropping the mask/dim rects above. When `restrictToRanges` is on
 * (highlight mode is active), any point resolves to the nearest retained
 * range's start rather than landing in a gap — there's nothing to play
 * there, so it "snaps" instead of doing nothing; the hover dot/time
 * preview already reveals this implicitly (it jumps to the snapped
 * target, not your raw cursor position), which is the only "which spans
 * are special" feedback the track gives — on hover, not as a permanent
 * mark. When highlight mode is off, every point is used as-is (free
 * scrub, like a normal video seekbar) — gaps only mean something while
 * the tool is actually skipping them.
 *
 * Path-string building, the smoothing geometry, and the snap/color math
 * are pure functions (tested in tests/rangeOverlay.test.js); only the
 * mount/render functions touch the DOM. Falls back to flat single-color
 * segments when there's no raw score curve to draw from (e.g. chapters
 * mode) — those still support click/drag, just not the colored curve.
 */
(function (root, factory) {
  var RangeUtils = (root && root.YHP && root.YHP.RangeUtils)
    || (typeof require === "function" ? require("../utils/rangeUtils") : null);
  var api = factory(RangeUtils);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.RangeOverlay = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function (RangeUtils) {
  "use strict";

  var VIEW_W = 1000;
  var VIEW_H = 100;

  // Violet (low density) -> magenta (peaks). Two stops, no neutral fade —
  // every score level stays visibly colored.
  var COLOR_COLD = [123, 92, 240]; // #7B5CF0
  var COLOR_WARM = [210, 79, 200]; // #D24FC8

  // Fraction of the track's height every *retained* highlight renders at
  // minimum, however low its real score is — a highlight is still a real,
  // clickable, navigable segment even at score ~0, and a fully flat peak
  // made it undiscoverable on the timeline. Only affects height/shape:
  // color (buildGradientStops) still reflects the true raw score, so a
  // floored weak highlight reads as a small, cool-toned bump rather than
  // pretending to be as intense as a real peak. Baseline/skipped samples
  // (outside any retained range) are never floored — the curve should
  // still read as genuinely quiet there.
  var HIGHLIGHT_FLOOR = 0.18;

  function pct(value, duration) {
    if (!duration) return 0;
    return Math.min(100, Math.max(0, (value / duration) * 100));
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function lerpRgb(c1, c2, t) {
    return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
  }

  function toHexByte(n) {
    var v = Math.round(Math.min(255, Math.max(0, n)));
    var s = v.toString(16);
    return s.length === 1 ? "0" + s : s;
  }

  function rgbToHex(rgb) {
    return "#" + toHexByte(rgb[0]) + toHexByte(rgb[1]) + toHexByte(rgb[2]);
  }

  /** Maps a 0..1 replay-intensity score to a hex color on the violet(0)->magenta(1) ramp. */
  function scoreToColor(score) {
    var t = Math.min(1, Math.max(0, score || 0));
    return rgbToHex(lerpRgb(COLOR_COLD, COLOR_WARM, t));
  }

  /** Gradient stops (offset 0..1, color) sampling the full video's score curve, for a shared absolute-position gradient. */
  function buildGradientStops(rawSamples, duration) {
    if (!(duration > 0) || !rawSamples.length) return [];
    return rawSamples.map(function (s) {
      var mid = (s.startTime + s.endTime) / 2;
      return { offset: Math.min(1, Math.max(0, mid / duration)), color: scoreToColor(s.score) };
    });
  }

  /** Replay score at a given video time — used to place the hover dot at the curve's actual height. */
  function scoreAtTime(rawSamples, time) {
    for (var i = 0; i < rawSamples.length; i += 1) {
      var s = rawSamples[i];
      if (time >= s.startTime && time < s.endTime) return s.score;
    }
    if (!rawSamples.length) return 0;
    return time < rawSamples[0].startTime ? rawSamples[0].score : rawSamples[rawSamples.length - 1].score;
  }

  /**
   * Remaps a 0..1 score onto [floor, 1] — every retained highlight stays
   * visibly above the floor no matter how low its real score is, while the
   * fuller range *above* the floor still stretches across the full score
   * range, so weak highlights remain distinguishable from strong ones
   * rather than all clustering right at the floor.
   */
  function floorScore(score, floor) {
    var t = Math.min(1, Math.max(0, score || 0));
    var f = typeof floor === "number" ? floor : HIGHLIGHT_FLOOR;
    return f + (1 - f) * t;
  }

  /**
   * Builds the {time, score} series the curve's *shape* is drawn from.
   * Samples inside a retained range get floorScore()'d so every highlight
   * renders a visible bump; samples outside any range (skipped/baseline)
   * keep their real score, so the curve still reads as genuinely quiet
   * there — this is about highlight discoverability, not inflating the
   * whole waveform. (Color is separate — see buildGradientStops, which
   * intentionally still uses the raw, unfloored score.)
   */
  function buildCurvePoints(rawSamples, ranges) {
    return (rawSamples || []).map(function (s) {
      var mid = (s.startTime + s.endTime) / 2;
      var inHighlight = findRangeAt(ranges, mid) !== null;
      return { time: mid, score: inHighlight ? floorScore(s.score) : s.score };
    });
  }

  /** The same floor logic as buildCurvePoints, but for an arbitrary point in time — keeps the hover dot on the curve exactly as rendered. */
  function effectiveScoreAtTime(rawSamples, ranges, time) {
    var raw = scoreAtTime(rawSamples, time);
    var inHighlight = findRangeAt(ranges, time) !== null;
    return inHighlight ? floorScore(raw) : Math.min(1, Math.max(0, raw));
  }

  function fmt1(n) {
    return n.toFixed(1);
  }

  /**
   * Pure: the list of cubic-bezier segments {p0,c1,c2,p3} (each an [x,y]
   * pair) that smoothPathThroughPoints traces through `xy` — Catmull-Rom
   * tangents, tension 1/6. Split out from smoothPathThroughPoints (which
   * is now a thin wrapper over this + segmentsToPathD) so a sub-range of
   * the *same* curve can be extracted later — see trimCurveToXRange —
   * without re-deriving different tangents from a smaller point subset.
   */
  function buildCubicSegments(xy) {
    var segments = [];
    for (var i = 0; i < xy.length - 1; i += 1) {
      var p0 = xy[i - 1] || xy[i];
      var p1 = xy[i];
      var p2 = xy[i + 1];
      var p3 = xy[i + 2] || p2;
      var c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      var c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      segments.push({ p0: p1, c1: c1, c2: c2, p3: p2 });
    }
    return segments;
  }

  /** Stringifies a list of {p0,c1,c2,p3} cubic segments (as buildCubicSegments returns) into an SVG path `d`. */
  function segmentsToPathD(segments) {
    if (!segments.length) return "";
    var d = "M " + fmt1(segments[0].p0[0]) + "," + fmt1(segments[0].p0[1]);
    segments.forEach(function (seg) {
      d += " C " + fmt1(seg.c1[0]) + "," + fmt1(seg.c1[1])
        + " " + fmt1(seg.c2[0]) + "," + fmt1(seg.c2[1])
        + " " + fmt1(seg.p3[0]) + "," + fmt1(seg.p3[1]);
    });
    return d;
  }

  /**
   * Catmull-Rom-through-points, converted to a cubic-bezier SVG path
   * (tension 1/6, the standard conversion) — the same curve family
   * YouTube's own heat-map path uses, given points already mapped to
   * pixel/viewBox space as [x, y] pairs.
   */
  function smoothPathThroughPoints(xy) {
    if (!xy.length) return "";
    if (xy.length === 1) return "M " + fmt1(xy[0][0]) + "," + fmt1(xy[0][1]);
    return segmentsToPathD(buildCubicSegments(xy));
  }

  /** Maps chronological {time, score} points onto a 0..viewW / 0..viewH viewBox as [x, y] pairs. */
  function mapPointsToXY(points, duration, viewW, viewH) {
    var w = viewW || VIEW_W;
    var h = viewH || VIEW_H;
    function toX(t) {
      return Math.min(1, Math.max(0, t / duration)) * w;
    }
    function toY(s) {
      return h - Math.min(1, Math.max(0, s)) * h;
    }
    return points.map(function (p) { return [toX(p.time), toY(p.score)]; });
  }

  /** Evaluates a cubic-bezier segment {p0,c1,c2,p3} at parameter t (0..1), returning [x,y]. */
  function cubicPointAt(seg, t) {
    var mt = 1 - t;
    var a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
    return [
      a * seg.p0[0] + b * seg.c1[0] + c * seg.c2[0] + d * seg.p3[0],
      a * seg.p0[1] + b * seg.c1[1] + c * seg.c2[1] + d * seg.p3[1],
    ];
  }

  /** De Casteljau split of a cubic-bezier segment at parameter t: [left, right] sub-segments that together retrace the original exactly. */
  function splitCubicAt(seg, t) {
    function lerp(p, q) { return [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]; }
    var a = lerp(seg.p0, seg.c1);
    var b = lerp(seg.c1, seg.c2);
    var c = lerp(seg.c2, seg.p3);
    var d = lerp(a, b);
    var e = lerp(b, c);
    var f = lerp(d, e);
    return [
      { p0: seg.p0, c1: a, c2: d, p3: f },
      { p0: f, c1: e, c2: c, p3: seg.p3 },
    ];
  }

  /** Finds t in [0,1] where a segment's x(t) == targetX, via bisection. Assumes x(t) is non-decreasing across the segment — true here since x always tracks (non-decreasing) time by construction. Clamps to 0/1 outside the segment's own x-range. */
  function findTForX(seg, targetX) {
    if (targetX <= seg.p0[0]) return 0;
    if (targetX >= seg.p3[0]) return 1;
    var lo = 0, hi = 1;
    for (var i = 0; i < 30; i += 1) {
      var mid = (lo + hi) / 2;
      if (cubicPointAt(seg, mid)[0] < targetX) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function trimSegmentsFromLeft(segments, xStart) {
    for (var i = 0; i < segments.length; i += 1) {
      var seg = segments[i];
      if (xStart <= seg.p0[0]) return segments.slice(i);
      if (xStart < seg.p3[0]) return [splitCubicAt(seg, findTForX(seg, xStart))[1]].concat(segments.slice(i + 1));
      // else xStart >= seg.p3[0]: this whole segment is before the cut — drop it, keep looking.
    }
    return [];
  }

  function trimSegmentsFromRight(segments, xEnd) {
    for (var i = segments.length - 1; i >= 0; i -= 1) {
      var seg = segments[i];
      if (xEnd >= seg.p3[0]) return segments.slice(0, i + 1);
      if (xEnd > seg.p0[0]) return segments.slice(0, i).concat([splitCubicAt(seg, findTForX(seg, xEnd))[0]]);
      // else xEnd <= seg.p0[0]: this whole segment is after the cut — drop it, keep looking.
    }
    return [];
  }

  /**
   * Trims the exact same piecewise curve smoothPathThroughPoints(xy) would
   * draw down to just the [xStart, xEnd] portion, by locating and
   * De-Casteljau-splitting the boundary segments at their true parameter —
   * NOT by re-fitting a fresh curve from a smaller point subset. That
   * distinction is what fixes a real bug: buildActiveGlowPathD used to
   * filter the curve's points down to just those inside the active range
   * and re-run the Catmull-Rom smoothing on that smaller set. For a short
   * highlight (only 1-2 points survive the filter), that smoothing has no
   * curvature information from the range's neighbors to work with and
   * degenerates to a near-straight line — even though the *real* curve at
   * that location isn't flat at all, which is exactly the "no curve on
   * short highlights" bug this fixes. Trimming the real, already-correctly
   * -shaped curve instead always matches it exactly, however short the
   * range, and needs zero points to literally fall inside the range (only
   * two curve points on either side of it, to know the shape to trim).
   */
  function trimCurveToXRange(xy, xStart, xEnd) {
    if (!xy || xy.length < 2 || !(xEnd > xStart)) return [];
    var left = trimSegmentsFromLeft(buildCubicSegments(xy), xStart);
    if (!left.length) return [];
    return trimSegmentsFromRight(left, xEnd);
  }

  /**
   * Builds the `d` for the active-segment glow overlay: the real timeline
   * curve, trimmed to exactly the active range's [startTime, endTime]
   * x-span (see trimCurveToXRange for why trimming beats re-fitting).
   *
   * Trimming (rather than clipping a *rendered* duplicate) also matters
   * for a second reason: clip-path is applied to an element's filter
   * output (the CSS `filter: drop-shadow(...)` glow), not before it, so
   * clipping a duplicate of the full curve down to the active range would
   * slice the blur off in a hard rectangle right where the clip boundary
   * falls — a visible straight edge against the dark track instead of a
   * taper. A path that's genuinely only as wide as the active range has no
   * such boundary: its own two ends (drawn with a round stroke-linecap in
   * CSS) are where the glow naturally radiates from and fades to nothing,
   * with real margin, exactly like any other rounded stroke's drop-shadow.
   */
  function buildActiveGlowPathD(rawSamples, ranges, range, duration) {
    if (!range || !(duration > 0)) return "";
    var points = buildCurvePoints(rawSamples, ranges);
    if (!points || points.length < 2) return "";
    var xy = mapPointsToXY(points, duration, VIEW_W, VIEW_H);
    var xStart = Math.min(1, Math.max(0, range.startTime / duration)) * VIEW_W;
    var xEnd = Math.min(1, Math.max(0, range.endTime / duration)) * VIEW_W;
    return segmentsToPathD(trimCurveToXRange(xy, xStart, xEnd));
  }

  /**
   * Builds a smooth, filled mountain-silhouette SVG path `d` string from
   * chronological {time, score} points spanning the whole video (score 0
   * -> baseline at viewH, score 1 -> peak at y=0), closed back down to the
   * baseline at both ends for filling. Pair with buildSmoothLinePathD for
   * the visible outline — this one is meant to be filled with no stroke:
   * its closing edge along the baseline is a straight line, and stroking
   * it too would draw a bright baseline running under the curve.
   */
  function buildSmoothAreaPathD(points, duration, viewW, viewH) {
    var h = viewH || VIEW_H;
    if (!points || points.length === 0 || !(duration > 0)) return "";

    var xy = mapPointsToXY(points, duration, viewW, viewH);
    var curve = smoothPathThroughPoints(xy);
    var firstX = xy[0][0].toFixed(1);
    var lastX = xy[xy.length - 1][0].toFixed(1);
    return curve + " L " + lastX + "," + h.toFixed(1) + " L " + firstX + "," + h.toFixed(1) + " Z";
  }

  /**
   * Builds the same curve as buildSmoothAreaPathD but WITHOUT the
   * baseline-closing lines — meant to be stroked with no fill, so only the
   * actual curve gets outlined, not its (fill-only) closing edge.
   */
  function buildSmoothLinePathD(points, duration, viewW, viewH) {
    if (!points || points.length === 0 || !(duration > 0)) return "";
    return smoothPathThroughPoints(mapPointsToXY(points, duration, viewW, viewH));
  }

  /** Pure: the retained range containing `time`, or null. */
  function findRangeAt(ranges, time) {
    if (RangeUtils) return RangeUtils.findCurrentInterval(ranges, time);
    for (var i = 0; i < (ranges || []).length; i += 1) {
      var r = ranges[i];
      if (time >= r.startTime && time < r.endTime) return r;
    }
    return null;
  }

  /**
   * If `time` already falls inside a retained range, returns it unchanged.
   * Otherwise snaps to whichever range's *start* is numerically closer —
   * "there's nothing to play in a gap, so land on the highlight nearest to
   * where you were aiming" rather than doing nothing.
   */
  function snapToNearestRange(time, ranges) {
    if (findRangeAt(ranges, time)) return time;
    var list = RangeUtils ? RangeUtils.sortIntervals(ranges) : (ranges || []).slice().sort(function (a, b) { return a.startTime - b.startTime; });
    if (!list.length) return time;

    var next = null;
    var prev = null;
    for (var i = 0; i < list.length; i += 1) {
      if (list[i].startTime > time) { next = list[i]; break; }
      prev = list[i];
    }
    if (next && prev) {
      return (time - prev.startTime) <= (next.startTime - time) ? prev.startTime : next.startTime;
    }
    return next ? next.startTime : prev.startTime;
  }

  /** Pure: fraction (0..1) of the way across the track -> a video time in seconds. */
  function timeFromClickFraction(fraction, duration) {
    if (!(duration > 0)) return 0;
    return Math.min(1, Math.max(0, fraction)) * duration;
  }

  function formatClockTime(totalSeconds) {
    var seconds = Math.max(0, Math.round(totalSeconds || 0));
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var mm = h > 0 ? String(m).padStart(2, "0") : String(m);
    var ss = String(s).padStart(2, "0");
    return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  // ---- DOM rendering --------------------------------------------------

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    }
    return el;
  }

  function buildScoreGradientDef(id, stops) {
    var grad = svgEl("linearGradient", {
      id: id, gradientUnits: "userSpaceOnUse", x1: "0", x2: String(VIEW_W), y1: "0", y2: "0",
    });
    stops.forEach(function (stop) {
      grad.appendChild(svgEl("stop", { offset: stop.offset, "stop-color": stop.color }));
    });
    return grad;
  }

  /**
   * (Re)draws the active-segment indicator on top of an already-rendered
   * curve — a bright, glowing duplicate of just the active range's own
   * portion of the curve, trimmed (not re-fit) from the same curve data
   * (see buildActiveGlowPathD for why that distinction matters). No
   * background fill of any kind: now that every highlight has
   * a visible floor-height peak (see HIGHLIGHT_FLOOR), the peak's own
   * outline glowing is the "you are here" signal — a filled rectangle
   * behind it read as a plain dark block wherever the underlying peak was
   * weak, which is exactly the case this is meant to highlight. Cheap to
   * call on every active-index change; not meant for every timeupdate tick.
   */
  function paintActiveOverlays(svg, ranges, duration, activeIndex, rawSamples) {
    var staleGlow = svg.querySelectorAll(".yhp-timeline-active-glow");
    for (var i = 0; i < staleGlow.length; i += 1) staleGlow[i].parentNode.removeChild(staleGlow[i]);
    if (activeIndex === null || activeIndex === undefined || activeIndex < 0) return;

    var range = (ranges || [])[activeIndex];
    var glowD = buildActiveGlowPathD(rawSamples, ranges, range, duration);
    if (!glowD) return;

    svg.appendChild(svgEl("path", { class: "yhp-timeline-active-glow", d: glowD }));
  }

  /**
   * Renders (replacing prior contents) the timeline into `container`. When
   * `rawSamples` (the full-video score curve) is available, draws one
   * continuous violet->magenta curve for the whole video; otherwise falls
   * back to flat single-color segments for just the retained ranges (e.g.
   * chapters mode, no score data). No permanent masking of skipped spans —
   * the track stays a single flat baseline color across its full width;
   * see paintActiveOverlays above for the only overlay that ever appears.
   *
   * `onSeek(time)`, if given, is called on pointerdown/pointermove with a
   * video time in seconds — click-or-drag-to-jump, anywhere on the track.
   * `options.restrictToRanges` (default true) snaps that time into the
   * nearest retained range rather than using raw gap positions; pass false
   * (highlight mode off) for a free scrub-anywhere seekbar.
   * `options.activeIndex` paints the initial active/dim overlay — pass -1
   * or omit if unknown yet.
   */
  function renderPanelTimeline(container, ranges, duration, rawSamples, onSeek, options) {
    if (!container) return;
    container.innerHTML = "";

    var opts = options || {};
    var restrictToRanges = opts.restrictToRanges !== false;
    var activeIndex = typeof opts.activeIndex === "number" ? opts.activeIndex : -1;

    var track = document.createElement("div");
    track.className = "yhp-timeline-track";
    track.setAttribute("role", "slider");
    track.setAttribute("tabindex", "0");
    track.setAttribute("aria-label", "Highlight timeline, click or drag to jump");
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", String(Math.round(duration || 0)));

    var hasCurve = Array.isArray(rawSamples) && rawSamples.length > 0 && duration > 0;

    var hoverDot = document.createElement("div");
    hoverDot.className = "yhp-timeline-dot";
    var hoverTime = document.createElement("div");
    hoverTime.className = "yhp-timeline-hover-time";

    function hideHover() {
      hoverDot.classList.remove("yhp-timeline-dot--visible");
      hoverTime.classList.remove("yhp-timeline-hover-time--visible");
    }

    function showHoverAt(time, rect) {
      var leftPct = pct(time, duration) + "%";
      hoverTime.style.left = leftPct;
      hoverTime.textContent = formatClockTime(time);
      hoverTime.classList.add("yhp-timeline-hover-time--visible");
      track.setAttribute("aria-valuenow", String(Math.round(time)));
      if (hasCurve) {
        var score = effectiveScoreAtTime(rawSamples, ranges, time);
        hoverDot.style.left = leftPct;
        hoverDot.style.top = (rect.height * (1 - score)) + "px";
        hoverDot.classList.add("yhp-timeline-dot--visible");
      }
    }

    function resolveTimeFromClientX(clientX) {
      var rect = track.getBoundingClientRect();
      if (!rect.width) return null;
      var fraction = (clientX - rect.left) / rect.width;
      var rawTime = timeFromClickFraction(fraction, duration);
      var time = restrictToRanges ? snapToNearestRange(rawTime, ranges) : rawTime;
      return { time: time, rect: rect };
    }

    if (duration > 0) {
      track.classList.add("yhp-timeline-track--interactive");

      var isDragging = false;

      track.addEventListener("mousemove", function (event) {
        if (isDragging) return;
        var resolved = resolveTimeFromClientX(event.clientX);
        if (!resolved) return;
        showHoverAt(resolved.time, resolved.rect);
      });
      track.addEventListener("mouseleave", function () {
        if (isDragging) return;
        hideHover();
      });

      track.addEventListener("pointerdown", function (event) {
        var resolved = resolveTimeFromClientX(event.clientX);
        if (!resolved) return;
        isDragging = true;
        try { track.setPointerCapture(event.pointerId); } catch (_err) { /* not critical */ }
        showHoverAt(resolved.time, resolved.rect);
        if (typeof onSeek === "function") onSeek(resolved.time);
      });
      track.addEventListener("pointermove", function (event) {
        if (!isDragging) return;
        var resolved = resolveTimeFromClientX(event.clientX);
        if (!resolved) return;
        showHoverAt(resolved.time, resolved.rect);
        if (typeof onSeek === "function") onSeek(resolved.time);
      });
      function endDrag(event) {
        if (!isDragging) return;
        isDragging = false;
        try { track.releasePointerCapture(event.pointerId); } catch (_err) { /* not critical */ }
      }
      track.addEventListener("pointerup", endDrag);
      track.addEventListener("pointercancel", endDrag);
    }

    if (hasCurve) {
      var svg = svgEl("svg", {
        class: "yhp-timeline-svg",
        viewBox: "0 0 " + VIEW_W + " " + VIEW_H,
        preserveAspectRatio: "none",
      });
      var defs = svgEl("defs");
      defs.appendChild(buildScoreGradientDef("yhp-score-gradient", buildGradientStops(rawSamples, duration)));
      svg.appendChild(defs);

      var points = buildCurvePoints(rawSamples, ranges);
      var fillD = buildSmoothAreaPathD(points, duration, VIEW_W, VIEW_H);
      if (fillD) svg.appendChild(svgEl("path", { class: "yhp-timeline-fill", d: fillD }));
      var lineD = buildSmoothLinePathD(points, duration, VIEW_W, VIEW_H);
      if (lineD) svg.appendChild(svgEl("path", { class: "yhp-timeline-line", d: lineD }));

      paintActiveOverlays(svg, ranges, duration, activeIndex, rawSamples);

      track.appendChild(svg);
    } else {
      (ranges || []).forEach(function (range, index) {
        var segment = document.createElement("div");
        segment.className = "yhp-timeline-segment" + (index === activeIndex ? " yhp-timeline-segment--active" : "");
        segment.style.left = pct(range.startTime, duration) + "%";
        segment.style.width = Math.max(0.3, pct(range.endTime, duration) - pct(range.startTime, duration)) + "%";
        track.appendChild(segment);
      });
    }

    var playhead = document.createElement("div");
    playhead.className = "yhp-timeline-playhead";
    track.appendChild(playhead);

    container.appendChild(track);
    // Siblings of `track`, not children of it — `track` clips (overflow:
    // hidden, for the curve's rounded corners), but the floating time
    // label needs to sit above the track's own top edge.
    container.appendChild(hoverDot);
    container.appendChild(hoverTime);
  }

  /** Re-paints just the active/dim overlay on an already-rendered timeline — cheap, call on every range-index change. */
  function updateActiveSegment(container, ranges, duration, activeIndex, rawSamples) {
    if (!container) return;
    var track = container.querySelector(".yhp-timeline-track");
    if (!track) return;
    var svg = track.querySelector(".yhp-timeline-svg");
    if (svg) {
      paintActiveOverlays(svg, ranges, duration, activeIndex, rawSamples);
      return;
    }
    // Flat-segment fallback (no curve): toggle the --active class instead.
    var segments = track.querySelectorAll(".yhp-timeline-segment");
    for (var i = 0; i < segments.length; i += 1) {
      segments[i].classList.toggle("yhp-timeline-segment--active", i === activeIndex);
    }
  }

  /** Moves the live playhead marker inside a panel timeline built by renderPanelTimeline. Call frequently (e.g. every timeupdate). */
  function updatePanelTimelinePlayhead(container, currentTime, duration) {
    if (!container) return;
    var track = container.querySelector(".yhp-timeline-track");
    if (!track) return;
    var playhead = track.querySelector(".yhp-timeline-playhead");
    if (!playhead) return;
    playhead.style.left = pct(currentTime, duration) + "%";
  }

  return {
    renderPanelTimeline: renderPanelTimeline,
    updateActiveSegment: updateActiveSegment,
    updatePanelTimelinePlayhead: updatePanelTimelinePlayhead,
    // exported for unit testing:
    scoreToColor: scoreToColor,
    buildGradientStops: buildGradientStops,
    smoothPathThroughPoints: smoothPathThroughPoints,
    buildSmoothAreaPathD: buildSmoothAreaPathD,
    buildSmoothLinePathD: buildSmoothLinePathD,
    timeFromClickFraction: timeFromClickFraction,
    formatClockTime: formatClockTime,
    findRangeAt: findRangeAt,
    snapToNearestRange: snapToNearestRange,
    scoreAtTime: scoreAtTime,
    floorScore: floorScore,
    buildCurvePoints: buildCurvePoints,
    effectiveScoreAtTime: effectiveScoreAtTime,
    buildActiveGlowPathD: buildActiveGlowPathD,
    buildCubicSegments: buildCubicSegments,
    segmentsToPathD: segmentsToPathD,
    cubicPointAt: cubicPointAt,
    splitCubicAt: splitCubicAt,
    findTForX: findTForX,
    trimCurveToXRange: trimCurveToXRange,
    HIGHLIGHT_FLOOR: HIGHLIGHT_FLOOR,
  };
});
