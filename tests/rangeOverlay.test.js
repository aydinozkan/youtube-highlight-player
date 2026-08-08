const test = require("node:test");
const assert = require("node:assert/strict");
const RangeOverlay = require("../src/ui/rangeOverlay");

test("smoothPathThroughPoints starts with M and traces a C-command bezier through interior points", () => {
  const d = RangeOverlay.smoothPathThroughPoints([[0, 100], [50, 0], [100, 100]]);
  assert.ok(d.startsWith("M 0.0,100.0"), d);
  assert.ok(d.includes(" C "), d);
  assert.ok(d.trim().endsWith("100.0,100.0"), d); // final on-curve point
});

test("smoothPathThroughPoints handles a single point without throwing", () => {
  assert.equal(RangeOverlay.smoothPathThroughPoints([[5, 5]]), "M 5.0,5.0");
});

test("smoothPathThroughPoints handles empty input", () => {
  assert.equal(RangeOverlay.smoothPathThroughPoints([]), "");
});

test("buildSmoothAreaPathD maps the full time range and closes the silhouette to baseline at both ends", () => {
  const points = [
    { time: 0, score: 0 },
    { time: 50, score: 1 },
    { time: 100, score: 0 },
  ];
  const d = RangeOverlay.buildSmoothAreaPathD(points, 100, 1000, 100);
  assert.ok(d.startsWith("M 0.0,100.0"), d); // first point at baseline (score 0)
  assert.ok(d.includes("C "), d); // smoothed, not straight lines
  assert.ok(d.trim().endsWith("0.0,100.0 Z"), d); // closes back to baseline under the first point
});

test("buildSmoothAreaPathD returns '' for empty points or non-positive duration", () => {
  assert.equal(RangeOverlay.buildSmoothAreaPathD([], 100, 1000, 100), "");
  assert.equal(RangeOverlay.buildSmoothAreaPathD([{ time: 0, score: 1 }], 0, 1000, 100), "");
});

test("buildSmoothLinePathD traces the same curve as buildSmoothAreaPathD but without the baseline closure", () => {
  const points = [
    { time: 0, score: 0 },
    { time: 50, score: 1 },
    { time: 100, score: 0 },
  ];
  const lineD = RangeOverlay.buildSmoothLinePathD(points, 100, 1000, 100);
  assert.ok(lineD.startsWith("M 0.0,100.0"), lineD);
  assert.ok(lineD.includes("C "), lineD);
  // Ends at the curve's own last on-curve point — no extra "L ... Z" baseline segment.
  assert.ok(!lineD.includes("Z"), lineD);
  assert.ok(lineD.trim().endsWith("1000.0,100.0"), lineD);
});

test("buildSmoothLinePathD returns '' for empty points or non-positive duration", () => {
  assert.equal(RangeOverlay.buildSmoothLinePathD([], 100, 1000, 100), "");
  assert.equal(RangeOverlay.buildSmoothLinePathD([{ time: 0, score: 1 }], 0, 1000, 100), "");
});

function sample(start, end, score) {
  return { startTime: start, endTime: end, score };
}

test("floorScore remaps 0..1 onto [floor, 1], preserving relative order", () => {
  assert.equal(RangeOverlay.floorScore(0, 0.2), 0.2);
  assert.equal(RangeOverlay.floorScore(1, 0.2), 1);
  assert.ok(Math.abs(RangeOverlay.floorScore(0.5, 0.2) - 0.6) < 1e-9); // 0.2 + 0.8*0.5
  // A higher raw score still floors to a higher result than a lower one.
  assert.ok(RangeOverlay.floorScore(0.3, 0.2) > RangeOverlay.floorScore(0.1, 0.2));
});

test("floorScore defaults to HIGHLIGHT_FLOOR when no floor is given", () => {
  assert.equal(RangeOverlay.floorScore(0), RangeOverlay.HIGHLIGHT_FLOOR);
});

test("floorScore clamps out-of-range input", () => {
  assert.equal(RangeOverlay.floorScore(-5, 0.2), 0.2);
  assert.equal(RangeOverlay.floorScore(5, 0.2), 1);
});

test("buildCurvePoints floors the score only for samples inside a retained range", () => {
  const rawSamples = [sample(0, 10, 0), sample(10, 20, 0), sample(20, 30, 0.9)];
  const ranges = [{ startTime: 10, endTime: 20 }]; // only the middle sample is "retained"
  const points = RangeOverlay.buildCurvePoints(rawSamples, ranges);

  assert.equal(points[0].score, 0, "outside any range: real score (0) is left alone");
  assert.equal(points[1].score, RangeOverlay.HIGHLIGHT_FLOOR, "inside the retained range: floored even at score 0");
  assert.equal(points[2].score, 0.9, "outside any range: real score is left alone even though it's high");
});

test("buildCurvePoints never lowers a score that's already above the floor", () => {
  const rawSamples = [sample(0, 10, 0.9)];
  const ranges = [{ startTime: 0, endTime: 10 }];
  const points = RangeOverlay.buildCurvePoints(rawSamples, ranges);
  assert.ok(points[0].score > 0.9, "flooring should only ever raise low scores, never cap high ones");
});

test("effectiveScoreAtTime matches buildCurvePoints' floor behavior for the same time", () => {
  const rawSamples = [sample(0, 10, 0.05)];
  const ranges = [{ startTime: 0, endTime: 10 }];
  assert.equal(RangeOverlay.effectiveScoreAtTime(rawSamples, ranges, 5), RangeOverlay.floorScore(0.05));
  assert.equal(RangeOverlay.effectiveScoreAtTime(rawSamples, [], 5), 0.05, "no ranges at all: real score, unfloored");
});

test("buildActiveGlowPathD's endpoints land exactly at the range's own time bounds", () => {
  // Four 5s-wide samples over a 20s video; midpoints 2.5, 7.5, 12.5, 17.5.
  const rawSamples = [sample(0, 5, 0.1), sample(5, 10, 0.9), sample(10, 15, 0.8), sample(15, 20, 0.2)];
  const range = { startTime: 5, endTime: 15 };
  const d = RangeOverlay.buildActiveGlowPathD(rawSamples, [range], range, 20);
  const tokens = d.trim().split(/\s+/);
  const [startX] = tokens[1].split(",");
  const [endX] = tokens[tokens.length - 1].split(",");
  // x = time/duration*1000: 5/20*1000=250.0, 15/20*1000=750.0 — the
  // range's own boundaries, not wherever the nearest raw sample midpoint
  // happened to land (the old, less precise behavior).
  assert.equal(startX, "250.0", d);
  assert.equal(endX, "750.0", d);
});

test("buildActiveGlowPathD still traces a real curve for a short range containing zero raw sample midpoints", () => {
  // Regression test for the reported bug: a highlight short enough that no
  // sample's own midpoint falls inside it used to make buildActiveGlowPathD
  // return '' outright (nothing drawn at all) — or, for a range with just
  // one interior point, silently degenerate into a near-straight line
  // instead of following the curve. Both were symptoms of re-fitting a
  // fresh Catmull-Rom curve from whatever few points survived filtering,
  // instead of trimming the real (already correctly-shaped) curve.
  const rawSamples = [sample(0, 10, 0.1), sample(10, 20, 0.5), sample(20, 30, 0.9), sample(30, 40, 0.5), sample(40, 50, 0.1)];
  // Midpoints: 5, 15, 25, 35, 45. This window (21-24) sits entirely inside
  // the 20-30 sample's span, strictly between the 15 and 25 midpoints —
  // no raw sample midpoint falls inside it at all.
  const range = { startTime: 21, endTime: 24 };
  const d = RangeOverlay.buildActiveGlowPathD(rawSamples, [range], range, 50);
  assert.notEqual(d, "", "a short, sample-midpoint-free range must still trace the surrounding curve");
  assert.ok(d.includes(" C "), d);
});

test("buildActiveGlowPathD returns '' for a missing range or non-positive duration", () => {
  const rawSamples = [sample(0, 10, 0.5), sample(10, 20, 0.5)];
  assert.equal(RangeOverlay.buildActiveGlowPathD(rawSamples, [], null, 20), "");
  assert.equal(RangeOverlay.buildActiveGlowPathD(rawSamples, [], { startTime: 0, endTime: 20 }, 0), "");
});

test("trimCurveToXRange preserves a real internal peak, not a flattened line, for a short window straddling it", () => {
  const xy = [[0, 100], [100, 20], [200, 100]]; // symmetric peak, apex at (100, 20)
  const trimmed = RangeOverlay.trimCurveToXRange(xy, 90, 110); // a short window straddling the apex
  assert.ok(trimmed.length >= 1, JSON.stringify(trimmed));
  // The apex is a key point of the original curve (not mid-segment), so it
  // must survive the trim exactly, at the shared boundary between the two
  // trimmed sub-segments.
  const hasApex = trimmed.some((seg) =>
    (Math.abs(seg.p3[0] - 100) < 0.01 && Math.abs(seg.p3[1] - 20) < 0.01) ||
    (Math.abs(seg.p0[0] - 100) < 0.01 && Math.abs(seg.p0[1] - 20) < 0.01));
  assert.ok(hasApex, JSON.stringify(trimmed));
});

test("trimCurveToXRange's result starts and ends exactly at the requested x bounds", () => {
  const xy = [[0, 0], [50, 80], [100, 10], [150, 90], [200, 0]];
  const trimmed = RangeOverlay.trimCurveToXRange(xy, 30, 170);
  assert.ok(trimmed.length > 0);
  assert.ok(Math.abs(trimmed[0].p0[0] - 30) < 0.001, trimmed[0].p0[0]);
  assert.ok(Math.abs(trimmed[trimmed.length - 1].p3[0] - 170) < 0.001, trimmed[trimmed.length - 1].p3[0]);
});

test("trimCurveToXRange returns [] for a degenerate range or too few points", () => {
  assert.deepEqual(RangeOverlay.trimCurveToXRange([[0, 0], [10, 10]], 5, 5), []);
  assert.deepEqual(RangeOverlay.trimCurveToXRange([[0, 0]], 0, 10), []);
  assert.deepEqual(RangeOverlay.trimCurveToXRange([], 0, 10), []);
});

test("cubicPointAt returns the segment's own endpoints at t=0 and t=1", () => {
  const seg = { p0: [0, 0], c1: [10, 20], c2: [30, 20], p3: [40, 0] };
  assert.deepEqual(RangeOverlay.cubicPointAt(seg, 0), [0, 0]);
  assert.deepEqual(RangeOverlay.cubicPointAt(seg, 1), [40, 0]);
});

test("splitCubicAt produces two segments that together retrace the original, meeting exactly at t", () => {
  const seg = { p0: [0, 0], c1: [10, 20], c2: [30, 20], p3: [40, 0] };
  const [left, right] = RangeOverlay.splitCubicAt(seg, 0.4);
  assert.deepEqual(left.p0, seg.p0);
  assert.deepEqual(right.p3, seg.p3);
  assert.deepEqual(left.p3, right.p0); // the split point is shared
  const expected = RangeOverlay.cubicPointAt(seg, 0.4);
  assert.ok(Math.abs(left.p3[0] - expected[0]) < 1e-9);
  assert.ok(Math.abs(left.p3[1] - expected[1]) < 1e-9);
});

test("findTForX finds the parameter matching a target x, clamping outside the segment's own range", () => {
  const seg = { p0: [0, 0], c1: [10, 20], c2: [30, 20], p3: [40, 0] };
  assert.equal(RangeOverlay.findTForX(seg, -5), 0);
  assert.equal(RangeOverlay.findTForX(seg, 45), 1);
  const t = RangeOverlay.findTForX(seg, 20);
  assert.ok(Math.abs(RangeOverlay.cubicPointAt(seg, t)[0] - 20) < 0.01);
});

test("buildActiveGlowPathD returns '' for a missing range or non-positive duration", () => {
  const rawSamples = [sample(0, 10, 0.5), sample(10, 20, 0.5)];
  assert.equal(RangeOverlay.buildActiveGlowPathD(rawSamples, [], null, 20), "");
  assert.equal(RangeOverlay.buildActiveGlowPathD(rawSamples, [], { startTime: 0, endTime: 20 }, 0), "");
});

test("timeFromClickFraction maps a 0..1 click position onto the video's duration", () => {
  assert.equal(RangeOverlay.timeFromClickFraction(0, 100), 0);
  assert.equal(RangeOverlay.timeFromClickFraction(0.5, 100), 50);
  assert.equal(RangeOverlay.timeFromClickFraction(1, 100), 100);
});

test("timeFromClickFraction clamps out-of-bounds fractions and non-positive duration", () => {
  assert.equal(RangeOverlay.timeFromClickFraction(-0.5, 100), 0);
  assert.equal(RangeOverlay.timeFromClickFraction(1.5, 100), 100);
  assert.equal(RangeOverlay.timeFromClickFraction(0.5, 0), 0);
});

test("formatClockTime matches the panel's own mm:ss / h:mm:ss format", () => {
  assert.equal(RangeOverlay.formatClockTime(0), "0:00");
  assert.equal(RangeOverlay.formatClockTime(65), "1:05");
  assert.equal(RangeOverlay.formatClockTime(3725), "1:02:05");
});

test("scoreAtTime returns the score of the sample containing the given time", () => {
  const rawSamples = [sample(0, 10, 0.2), sample(10, 20, 0.5), sample(20, 30, 0.8)];
  assert.equal(RangeOverlay.scoreAtTime(rawSamples, 5), 0.2);
  assert.equal(RangeOverlay.scoreAtTime(rawSamples, 15), 0.5);
  assert.equal(RangeOverlay.scoreAtTime(rawSamples, 25), 0.8);
});

test("scoreAtTime clamps to the nearest edge sample outside the covered range", () => {
  const rawSamples = [sample(10, 20, 0.3), sample(20, 30, 0.6)];
  assert.equal(RangeOverlay.scoreAtTime(rawSamples, 0), 0.3); // before first sample
  assert.equal(RangeOverlay.scoreAtTime(rawSamples, 100), 0.6); // after last sample
});

test("scoreAtTime returns 0 for an empty sample list", () => {
  assert.equal(RangeOverlay.scoreAtTime([], 5), 0);
});

test("findRangeAt returns the containing range, or null when time falls in a gap", () => {
  const ranges = [{ startTime: 10, endTime: 20 }, { startTime: 40, endTime: 50 }];
  assert.deepEqual(RangeOverlay.findRangeAt(ranges, 15), ranges[0]);
  assert.deepEqual(RangeOverlay.findRangeAt(ranges, 45), ranges[1]);
  assert.equal(RangeOverlay.findRangeAt(ranges, 25), null); // in the gap between ranges
  assert.equal(RangeOverlay.findRangeAt(ranges, 5), null); // before the first range
  assert.equal(RangeOverlay.findRangeAt([], 15), null);
});

test("scoreToColor maps 0 and 1 to the violet/magenta anchors", () => {
  assert.equal(RangeOverlay.scoreToColor(0), "#7b5cf0");
  assert.equal(RangeOverlay.scoreToColor(1), "#d24fc8");
});

test("scoreToColor clamps out-of-range scores to the endpoints", () => {
  assert.equal(RangeOverlay.scoreToColor(-5), RangeOverlay.scoreToColor(0));
  assert.equal(RangeOverlay.scoreToColor(5), RangeOverlay.scoreToColor(1));
});

test("buildGradientStops samples the full video's score curve at each sample's midpoint fraction", () => {
  const rawSamples = [sample(0, 10, 0), sample(10, 20, 1)];
  const stops = RangeOverlay.buildGradientStops(rawSamples, 20);
  assert.equal(stops.length, 2);
  assert.equal(stops[0].offset, 0.25); // midpoint 5 / duration 20
  assert.equal(stops[0].color, RangeOverlay.scoreToColor(0));
  assert.equal(stops[1].offset, 0.75); // midpoint 15 / duration 20
  assert.equal(stops[1].color, RangeOverlay.scoreToColor(1));
});

test("buildGradientStops returns [] for non-positive duration or no samples", () => {
  assert.deepEqual(RangeOverlay.buildGradientStops([], 100), []);
  assert.deepEqual(RangeOverlay.buildGradientStops([sample(0, 10, 1)], 0), []);
});

test("snapToNearestRange leaves a time already inside a range untouched", () => {
  const ranges = [{ startTime: 10, endTime: 20 }, { startTime: 40, endTime: 50 }];
  assert.equal(RangeOverlay.snapToNearestRange(15, ranges), 15);
});

test("snapToNearestRange snaps a gap position to the closer range's start", () => {
  const ranges = [{ startTime: 10, endTime: 20 }, { startTime: 40, endTime: 50 }];
  assert.equal(RangeOverlay.snapToNearestRange(22, ranges), 10, "closer to the first range's start");
  assert.equal(RangeOverlay.snapToNearestRange(35, ranges), 40, "closer to the second range's start");
});

test("snapToNearestRange clamps before the first / after the last range", () => {
  const ranges = [{ startTime: 10, endTime: 20 }, { startTime: 40, endTime: 50 }];
  assert.equal(RangeOverlay.snapToNearestRange(0, ranges), 10);
  assert.equal(RangeOverlay.snapToNearestRange(80, ranges), 40);
});

test("snapToNearestRange returns the time unchanged when there are no ranges", () => {
  assert.equal(RangeOverlay.snapToNearestRange(15, []), 15);
});
