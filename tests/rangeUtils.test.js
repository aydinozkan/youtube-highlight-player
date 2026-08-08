const test = require("node:test");
const assert = require("node:assert/strict");
const RangeUtils = require("../src/utils/rangeUtils");

test("sortIntervals returns chronological order without mutating input", () => {
  const input = [{ startTime: 10, endTime: 20 }, { startTime: 0, endTime: 5 }];
  const sorted = RangeUtils.sortIntervals(input);
  assert.deepEqual(sorted.map((i) => i.startTime), [0, 10]);
  assert.deepEqual(input.map((i) => i.startTime), [10, 0], "input must not be mutated");
});

test("clampIntervals clips to [0, duration] and drops collapsed intervals", () => {
  const out = RangeUtils.clampIntervals(
    [
      { startTime: -5, endTime: 10 },
      { startTime: 90, endTime: 120 },
      { startTime: 200, endTime: 250 }, // fully outside duration -> dropped
    ],
    100
  );
  assert.deepEqual(out, [
    { startTime: 0, endTime: 10 },
    { startTime: 90, endTime: 100 },
  ]);
});

test("clampIntervals rejects non-finite or non-positive duration", () => {
  assert.deepEqual(RangeUtils.clampIntervals([{ startTime: 0, endTime: 5 }], 0), []);
  assert.deepEqual(RangeUtils.clampIntervals([{ startTime: 0, endTime: 5 }], NaN), []);
});

test("mergeIntervals merges overlapping intervals", () => {
  const merged = RangeUtils.mergeIntervals([
    { startTime: 0, endTime: 10, score: 1 },
    { startTime: 5, endTime: 15, score: 0.5 },
  ], 0);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].startTime, 0);
  assert.equal(merged[0].endTime, 15);
});

test("mergeIntervals merges near intervals within gapThreshold but not beyond it", () => {
  const withinGap = RangeUtils.mergeIntervals([
    { startTime: 0, endTime: 10 },
    { startTime: 11, endTime: 20 },
  ], 2);
  assert.equal(withinGap.length, 1);

  const beyondGap = RangeUtils.mergeIntervals([
    { startTime: 0, endTime: 10 },
    { startTime: 15, endTime: 20 },
  ], 2);
  assert.equal(beyondGap.length, 2);
});

test("mergeIntervals duration-weights the merged score", () => {
  const merged = RangeUtils.mergeIntervals([
    { startTime: 0, endTime: 10, score: 1 }, // 10s @ score 1
    { startTime: 10, endTime: 30, score: 0 }, // 20s @ score 0
  ], 0);
  assert.equal(merged.length, 1);
  // weighted average: (1*10 + 0*20) / 30 = 0.333...
  assert.ok(Math.abs(merged[0].score - 1 / 3) < 1e-9);
});

test("selectTopIntervals('top') greedily picks highest-scoring samples up to the target duration", () => {
  const samples = [
    { startTime: 0, endTime: 10, score: 0.1 },
    { startTime: 10, endTime: 20, score: 0.9 },
    { startTime: 20, endTime: 30, score: 0.5 },
  ];
  // duration 30, 30% target -> 9s: the top scorer's 10s alone already meets
  // the target, so the greedy walk stops before considering a second sample.
  const top = RangeUtils.selectTopIntervals(samples, 0.3, 30, "top");
  assert.deepEqual(top, [samples[1]]);

  // 60% target -> 18s: top scorer (10s) isn't enough alone, so the
  // next-highest is pulled in too, but the lowest scorer still isn't needed.
  const wider = RangeUtils.selectTopIntervals(samples, 0.6, 30, "top");
  assert.equal(wider.length, 2);
  assert.ok(wider.includes(samples[1]));
  assert.ok(wider.includes(samples[2]));
});

test("selectTopIntervals('bottom') picks lowest-scoring samples first", () => {
  const samples = [
    { startTime: 0, endTime: 10, score: 0.1 },
    { startTime: 10, endTime: 20, score: 0.9 },
  ];
  const bottom = RangeUtils.selectTopIntervals(samples, 0.34, 20, "bottom");
  assert.deepEqual(bottom, [samples[0]]);
});

test("computeBaselineScore finds the dominant repeated score, ignoring small/varied inputs", () => {
  // 15 of 20 samples tied at 0.1 -> a real, dominant baseline.
  const flatWithPeak = Array.from({ length: 20 }, (_, i) => ({
    startTime: i * 10,
    endTime: i * 10 + 10,
    score: i === 5 ? 0.8 : 0.1,
  }));
  assert.equal(RangeUtils.computeBaselineScore(flatWithPeak), 0.1);

  // Too few samples for "baseline" to mean anything.
  assert.equal(RangeUtils.computeBaselineScore([{ score: 0.1 }, { score: 0.1 }, { score: 0.9 }]), null);

  // No value repeats enough (each score distinct, well under the 30% floor).
  const varied = Array.from({ length: 12 }, (_, i) => ({ score: i / 12 }));
  assert.equal(RangeUtils.computeBaselineScore(varied), null);
});

test("selectTopIntervals('top') ignores baseline-tied filler once a real spike is found, even short of the target duration", () => {
  // A realistic shape: mostly flat at 0.1 (matching a real captured heatmap's
  // baseline), one genuine ~20s spike. Even asking for a large percentage,
  // selection should stick to the spike rather than padding out with filler.
  const samples = Array.from({ length: 100 }, (_, i) => ({
    startTime: i * 10,
    endTime: i * 10 + 10,
    score: i === 50 || i === 51 ? 0.8 : 0.1,
  }));
  const selected = RangeUtils.selectTopIntervals(samples, 0.3, 1000, "top"); // 30% of 1000s = 300s target
  assert.equal(selected.length, 2, "should only pick the two above-baseline samples, not pad with filler");
  assert.ok(selected.every((s) => s.score === 0.8));
});

test("selectTopIntervals('top') falls back to using everything when the whole input is uniformly flat", () => {
  const flat = Array.from({ length: 20 }, (_, i) => ({ startTime: i * 10, endTime: i * 10 + 10, score: 0.1 }));
  const selected = RangeUtils.selectTopIntervals(flat, 0.2, 200, "top"); // 20% of 200s = 40s target
  assert.ok(selected.length > 0, "with no signal at all, should still select something rather than nothing");
});

test("selectTopIntervals('bottom') is unaffected by baseline filtering — filler is what skip-filler wants", () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({
    startTime: i * 10,
    endTime: i * 10 + 10,
    score: i === 5 ? 0.8 : 0.1,
  }));
  const selected = RangeUtils.selectTopIntervals(samples, 0.5, 200, "bottom"); // wants the baseline-tied filler
  assert.ok(selected.length > 1, "skip-filler should still be able to select multiple baseline-tied samples");
  assert.ok(selected.every((s) => s.score === 0.1));
});

test("selectTopIntervals handles empty input and zero percentage", () => {
  assert.deepEqual(RangeUtils.selectTopIntervals([], 0.5, 100), []);
  assert.deepEqual(RangeUtils.selectTopIntervals([{ startTime: 0, endTime: 10, score: 1 }], 0, 100), []);
});

test("addPadding expands bounds without clamping", () => {
  const padded = RangeUtils.addPadding([{ startTime: 10, endTime: 20, score: 0.5 }], 3, 5);
  assert.deepEqual(padded, [{ startTime: 7, endTime: 25, score: 0.5 }]);
});

test("calcSelectedDuration sums interval lengths", () => {
  const sum = RangeUtils.calcSelectedDuration([
    { startTime: 0, endTime: 10 },
    { startTime: 20, endTime: 25 },
  ]);
  assert.equal(sum, 15);
});

test("calcTimeSaved is totalDuration minus selected duration, floored at 0", () => {
  const intervals = [{ startTime: 0, endTime: 10 }];
  assert.equal(RangeUtils.calcTimeSaved(intervals, 100), 90);
  assert.equal(RangeUtils.calcTimeSaved(intervals, 5), 0, "must not go negative");
});

test("findCurrentInterval finds the half-open interval containing time", () => {
  const intervals = [{ startTime: 0, endTime: 10 }, { startTime: 20, endTime: 30 }];
  assert.equal(RangeUtils.findCurrentInterval(intervals, 5), intervals[0]);
  assert.equal(RangeUtils.findCurrentInterval(intervals, 10), null, "endTime is exclusive");
  assert.equal(RangeUtils.findCurrentInterval(intervals, 15), null);
});

test("findNextInterval returns the chronologically-next interval after time", () => {
  const intervals = [{ startTime: 20, endTime: 30 }, { startTime: 0, endTime: 10 }];
  assert.deepEqual(RangeUtils.findNextInterval(intervals, 12), { startTime: 20, endTime: 30 });
  assert.equal(RangeUtils.findNextInterval(intervals, 25), null);
});

test("findPreviousInterval returns the chronologically-previous interval before time", () => {
  const intervals = [{ startTime: 20, endTime: 30 }, { startTime: 0, endTime: 10 }];
  assert.deepEqual(RangeUtils.findPreviousInterval(intervals, 15), { startTime: 0, endTime: 10 });
  assert.equal(RangeUtils.findPreviousInterval(intervals, 0), null, "nothing precedes the very first interval");
});

test("findPreviousInterval picks the closest preceding interval when several qualify", () => {
  const intervals = [{ startTime: 0, endTime: 5 }, { startTime: 10, endTime: 15 }, { startTime: 20, endTime: 25 }];
  assert.deepEqual(RangeUtils.findPreviousInterval(intervals, 22), intervals[2]);
  assert.deepEqual(RangeUtils.findPreviousInterval(intervals, 18), intervals[1]);
});

test("complementIntervals returns the gaps between cut intervals over [0, duration]", () => {
  const cuts = [{ startTime: 10, endTime: 20 }, { startTime: 40, endTime: 50 }];
  const kept = RangeUtils.complementIntervals(cuts, 60);
  assert.deepEqual(kept, [
    { startTime: 0, endTime: 10, score: 0 },
    { startTime: 20, endTime: 40, score: 0 },
    { startTime: 50, endTime: 60, score: 0 },
  ]);
});

test("complementIntervals with no cuts returns the whole duration", () => {
  assert.deepEqual(RangeUtils.complementIntervals([], 60), [{ startTime: 0, endTime: 60, score: 0 }]);
});

test("complementIntervals with a cut spanning the whole video returns nothing", () => {
  assert.deepEqual(RangeUtils.complementIntervals([{ startTime: 0, endTime: 60 }], 60), []);
});

test("buildHighlightRanges: full pipeline is chronological, padded, merged and clamped", () => {
  const samples = [
    { startTime: 5, endTime: 10, score: 0.9 },
    { startTime: 50, endTime: 55, score: 0.2 },
    { startTime: 12, endTime: 16, score: 0.8 }, // close to the first sample after padding -> should merge
  ];
  const ranges = RangeUtils.buildHighlightRanges(samples, {
    percentage: 0.5,
    paddingBefore: 2,
    paddingAfter: 2,
    duration: 60,
    mergeGap: 1,
  });

  // Chronological
  for (let i = 1; i < ranges.length; i += 1) {
    assert.ok(ranges[i].startTime >= ranges[i - 1].startTime);
  }
  // Clamped
  for (const r of ranges) {
    assert.ok(r.startTime >= 0 && r.endTime <= 60);
  }
  // The two nearby, high-score samples (5-10 and 12-16) should have merged
  // into one padded range once padding closes the 2s gap between them.
  const merged = ranges.find((r) => r.startTime <= 3 && r.endTime >= 18);
  assert.ok(merged, `expected a merged range covering ~3-18, got ${JSON.stringify(ranges)}`);
});

test("buildHighlightRanges never produces intervals outside the video duration", () => {
  const samples = [{ startTime: 95, endTime: 105, score: 1 }]; // extends past a 100s video
  const ranges = RangeUtils.buildHighlightRanges(samples, {
    percentage: 1,
    paddingBefore: 10,
    paddingAfter: 10,
    duration: 100,
    mergeGap: 1,
  });
  for (const r of ranges) {
    assert.ok(r.startTime >= 0);
    assert.ok(r.endTime <= 100);
  }
});
