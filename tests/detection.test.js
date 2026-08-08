const test = require("node:test");
const assert = require("node:assert/strict");
const HeatmapStrategy = require("../src/detection/heatmapStrategy");
const ChapterStrategy = require("../src/detection/chapterStrategy");
const DetectionManager = require("../src/detection/detectionManager");
const { el, makeDoc } = require("./helpers/fakeDom");

// Captured verbatim from a live YouTube watch page (Aug 2026) via
// `document.querySelector('.ytp-heat-map-container')` — a real
// path.ytp-modern-heat-map `d` attribute, used here as ground truth so the
// parser is tested against what YouTube actually emits, not a guess.
const REAL_HEATMAP_PATH_D =
  "M 0.0,100.0 C 1.0,91.8 2.0,61.2 5.0,59.2 C 8.0,57.2 11.0,86.1 15.0,90.0 C 19.0,93.9 21.0,80.1 25.0,78.5 " +
  "C 29.0,76.9 31.0,79.9 35.0,82.2 C 39.0,84.5 41.0,88.4 45.0,90.0 C 49.0,91.6 51.0,90.0 55.0,90.0 C 59.0,90.0 " +
  "61.0,90.0 65.0,90.0 C 69.0,90.0 71.0,90.0 75.0,90.0 C 79.0,90.0 81.0,90.0 85.0,90.0 C 89.0,90.0 91.0,90.0 " +
  "95.0,90.0 C 99.0,90.0 101.0,90.0 105.0,90.0 C 109.0,90.0 111.0,90.0 115.0,90.0 C 119.0,90.0 121.0,90.0 " +
  "125.0,90.0 C 129.0,90.0 131.0,90.0 135.0,90.0 C 139.0,90.0 141.0,90.0 145.0,90.0 C 149.0,90.0 151.0,90.0 " +
  "155.0,90.0 C 159.0,90.0 161.0,90.0 165.0,90.0 C 169.0,90.0 171.0,90.0 175.0,90.0 C 179.0,90.0 181.0,90.0 " +
  "185.0,90.0 C 189.0,90.0 191.0,90.0 195.0,90.0 C 199.0,90.0 201.0,90.0 205.0,90.0 C 209.0,90.0 211.0,90.0 " +
  "215.0,90.0 C 219.0,90.0 221.0,90.0 225.0,90.0 C 229.0,90.0 231.0,90.4 235.0,90.0 C 239.0,89.6 241.0,88.0 " +
  "245.0,88.0 C 249.0,88.0 251.0,89.6 255.0,90.0 C 259.0,90.4 261.0,90.8 265.0,90.0 C 269.0,89.2 271.0,85.9 " +
  "275.0,85.9 C 279.0,85.9 281.0,89.2 285.0,90.0 C 289.0,90.8 291.0,90.0 295.0,90.0 C 299.0,90.0 301.0,90.0 " +
  "305.0,90.0 C 309.0,90.0 311.0,90.0 315.0,90.0 C 319.0,90.0 321.0,90.5 325.0,90.0 C 329.0,89.5 331.0,88.8 " +
  "335.0,87.7 C 339.0,86.5 341.0,83.7 345.0,84.2 C 349.0,84.6 351.0,88.8 355.0,90.0 C 359.0,91.2 361.0,90.0 " +
  "365.0,90.0 C 369.0,90.0 371.0,90.5 375.0,90.0 C 379.0,89.5 381.0,89.1 385.0,87.6 C 389.0,86.2 391.0,82.4 " +
  "395.0,82.9 C 399.0,83.4 401.0,88.6 405.0,90.0 C 409.0,91.4 411.0,90.0 415.0,90.0 C 419.0,90.0 421.0,91.9 " +
  "425.0,90.0 C 429.0,88.1 431.0,81.0 435.0,80.3 C 439.0,79.6 441.0,86.2 445.0,86.4 C 449.0,86.6 451.0,82.1 " +
  "455.0,81.2 C 459.0,80.3 461.0,82.0 465.0,82.0 C 469.0,81.9 471.0,79.6 475.0,81.2 C 479.0,82.8 481.0,88.2 " +
  "485.0,90.0 C 489.0,91.7 491.0,90.0 495.0,90.0 C 499.0,90.0 501.0,90.0 505.0,90.0 C 509.0,90.0 511.0,90.0 " +
  "515.0,90.0 C 519.0,90.0 521.0,90.4 525.0,90.0 C 529.0,89.6 531.0,88.0 535.0,88.0 C 539.0,88.0 541.0,89.6 " +
  "545.0,90.0 C 549.0,90.4 551.0,90.0 555.0,90.0 C 559.0,90.0 561.0,90.0 565.0,90.0 C 569.0,90.0 571.0,90.0 " +
  "575.0,90.0 C 579.0,90.0 581.0,90.0 585.0,90.0 C 589.0,90.0 591.0,90.0 595.0,90.0 C 599.0,90.0 601.0,90.0 " +
  "605.0,90.0 C 609.0,90.0 611.0,90.0 615.0,90.0 C 619.0,90.0 621.0,90.0 625.0,90.0 C 629.0,90.0 631.0,90.0 " +
  "635.0,90.0 C 639.0,90.0 641.0,90.0 645.0,90.0 C 649.0,90.0 651.0,90.0 655.0,90.0 C 659.0,90.0 661.0,90.0 " +
  "665.0,90.0 C 669.0,90.0 671.0,90.0 675.0,90.0 C 679.0,90.0 681.0,90.0 685.0,90.0 C 689.0,90.0 691.0,90.0 " +
  "695.0,89.9 C 699.0,89.9 701.0,92.0 705.0,89.8 C 709.0,87.7 711.0,82.5 715.0,79.2 C 719.0,75.9 721.0,75.7 " +
  "725.0,73.1 C 729.0,70.5 731.0,71.9 735.0,66.2 C 739.0,60.6 741.0,58.0 745.0,44.8 C 749.0,31.5 751.0,0.0 " +
  "755.0,0.0 C 759.0,-0.0 761.0,30.7 765.0,44.6 C 769.0,58.6 771.0,63.8 775.0,69.6 C 779.0,75.4 781.0,69.7 " +
  "785.0,73.7 C 789.0,77.8 791.0,87.6 795.0,90.0 C 799.0,92.4 801.0,86.0 805.0,86.0 C 809.0,86.0 811.0,89.4 " +
  "815.0,90.0 C 819.0,90.6 821.0,89.8 825.0,88.8 C 829.0,87.7 831.0,85.8 835.0,84.6 C 839.0,83.5 841.0,82.5 " +
  "845.0,83.2 C 849.0,83.9 851.0,86.7 855.0,88.1 C 859.0,89.5 861.0,89.6 865.0,90.0 C 869.0,90.4 871.0,90.0 " +
  "875.0,90.0 C 879.0,90.0 881.0,90.0 885.0,90.0 C 889.0,90.0 891.0,90.0 895.0,90.0 C 899.0,90.0 901.0,90.0 " +
  "905.0,90.0 C 909.0,90.0 911.0,90.0 915.0,90.0 C 919.0,90.0 921.0,90.0 925.0,90.0 C 929.0,90.0 931.0,90.0 " +
  "935.0,90.0 C 939.0,90.0 941.0,90.0 945.0,90.0 C 949.0,90.0 951.0,90.0 955.0,90.0 C 959.0,90.0 961.0,90.0 " +
  "965.0,90.0 C 969.0,90.0 971.0,90.0 975.0,90.0 C 979.0,90.0 981.0,90.0 985.0,90.0 C 989.0,90.0 992.0,90.0 " +
  "995.0,90.0 C 998.0,90.0 999.0,88.0 1000.0,90.0 C 1001.0,92.0 1000.0,98.0 1000.0,100.0";

// Wraps a heat-map `d` string in the fake-DOM shape heatmapStrategy expects.
function heatmapDoc(chapters) {
  // chapters: [{ widthPx, d, viewBox }]
  const chapterEls = chapters.map((c) =>
    el(
      "div",
      { class: "ytp-heat-map-chapter" },
      { width: c.widthPx + "px" },
      [
        el("svg", { class: "ytp-heat-map-svg", viewBox: c.viewBox || "0 0 1000 100" }, {}, [
          el("path", { class: "ytp-modern-heat-map", d: c.d }, {}, []),
        ]),
      ]
    )
  );
  const container = el("div", { class: "ytp-heat-map-container" }, {}, chapterEls);
  return makeDoc(el("body", {}, {}, [container]));
}

test("HeatmapStrategy.parseHeatmapPathPoints extracts on-curve endpoints from a real captured path", () => {
  const points = HeatmapStrategy.parseHeatmapPathPoints(REAL_HEATMAP_PATH_D);
  assert.ok(points.length > 100, `expected many points, got ${points.length}`);
  assert.deepEqual(points[0], { x: 0, y: 100 });
  // the video's peak "most replayed" moment, per the captured curve
  const peak = points.find((p) => p.x === 755);
  assert.deepEqual(peak, { x: 755, y: 0 });
});

test("HeatmapStrategy.parseHeatmapPathPoints handles empty/malformed input gracefully", () => {
  assert.deepEqual(HeatmapStrategy.parseHeatmapPathPoints(""), []);
  assert.deepEqual(HeatmapStrategy.parseHeatmapPathPoints(null), []);
  assert.deepEqual(HeatmapStrategy.parseHeatmapPathPoints("M not,numbers C also,bad,data,here"), []);
});

test("HeatmapStrategy.pointsToSamples maps viewBox coordinates onto a time range and inverts y into score", () => {
  const points = [
    { x: 0, y: 100 }, // baseline
    { x: 500, y: 0 }, // peak
    { x: 1000, y: 100 }, // baseline
  ];
  const samples = HeatmapStrategy.pointsToSamples(points, 0, 100, 1000, 100);
  assert.deepEqual(samples, [
    { startTime: 0, endTime: 50, score: 0.5 },
    { startTime: 50, endTime: 100, score: 0.5 },
  ]);
});

test("HeatmapStrategy.pointsToSamples returns [] for degenerate input", () => {
  assert.deepEqual(HeatmapStrategy.pointsToSamples([{ x: 0, y: 0 }], 0, 100, 1000, 100), []);
  assert.deepEqual(HeatmapStrategy.pointsToSamples([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10, 10, 1000, 100), []);
});

test("HeatmapStrategy.parseHeatmap reads a single-chapter heatmap from the DOM end to end", () => {
  const duration = 973; // 16:13, matching the video this path was captured from
  const doc = heatmapDoc([{ widthPx: 895, d: REAL_HEATMAP_PATH_D }]);

  const samples = HeatmapStrategy.parseHeatmap({ doc, duration });
  assert.ok(HeatmapStrategy.isAvailable({ doc, duration }));
  assert.ok(samples.length > 50);

  // Continuous coverage from ~0 to ~duration.
  assert.ok(samples[0].startTime < 1);
  assert.ok(samples[samples.length - 1].endTime > duration - 5);

  // The peak (x=755 -> 75.5% through) should land near 734.6s. It's a
  // single-frame-sharp spike (y=0 at exactly one on-curve point, climbing
  // back to ~45 just 10 curve-units to either side), so segment-averaging
  // smooths it to well under a "perfect" 1.0 score — what matters is that
  // it clearly and correctly outranks the flat baseline elsewhere.
  const peakSample = samples.reduce((best, s) => (s.score > best.score ? s : best), samples[0]);
  assert.ok(Math.abs(peakSample.startTime - 734.6) < 10, `peak at ${peakSample.startTime}, expected ~734.6`);
  assert.ok(peakSample.score > 0.7, `expected a strong peak score, got ${peakSample.score}`);
  const baselineSample = samples.find((s) => s.startTime > 10 && s.startTime < 200);
  assert.ok(peakSample.score > baselineSample.score * 3, "peak should clearly outrank the flat baseline");
});

test("HeatmapStrategy.parseHeatmap splits time proportionally across multiple chapters", () => {
  const flatBump = "M 0.0,100.0 C 250.0,0.0 500.0,0.0 1000.0,100.0"; // one endpoint at x=500,y=0
  const duration = 200;
  // Two equal-width chapters -> each covers 100s of the 200s video.
  const doc = heatmapDoc([
    { widthPx: 500, d: flatBump },
    { widthPx: 500, d: flatBump },
  ]);

  const samples = HeatmapStrategy.parseHeatmap({ doc, duration });
  const firstChapterSamples = samples.filter((s) => s.startTime < 100);
  const secondChapterSamples = samples.filter((s) => s.startTime >= 100);
  assert.ok(firstChapterSamples.length > 0);
  assert.ok(secondChapterSamples.length > 0);
  assert.ok(secondChapterSamples[0].startTime >= 100);
});

test("HeatmapStrategy.parseHeatmap returns [] when there's no heatmap container, no duration, or no path data", () => {
  const emptyDoc = makeDoc(el("body", {}, {}, []));
  assert.deepEqual(HeatmapStrategy.parseHeatmap({ doc: emptyDoc, duration: 100 }), []);
  assert.deepEqual(HeatmapStrategy.parseHeatmap({ doc: heatmapDoc([{ widthPx: 895, d: REAL_HEATMAP_PATH_D }]), duration: 0 }), []);
  assert.deepEqual(HeatmapStrategy.parseHeatmap({ doc: heatmapDoc([{ widthPx: 895, d: "" }]), duration: 100 }), []);
});

test("ChapterStrategy.parseChapters normalizes chapters and infers end times from the next chapter / duration", () => {
  const pageData = {
    ytInitialData: {
      markersMap: [
        {
          key: "DESCRIPTION_CHAPTERS",
          value: {
            chapters: [
              { chapterRenderer: { title: { simpleText: "Intro" }, timeRangeStartMillis: 0 } },
              { chapterRenderer: { title: { runs: [{ text: "Main " }, { text: "topic" }] }, timeRangeStartMillis: 30000 } },
            ],
          },
        },
      ],
    },
  };

  const chapters = ChapterStrategy.parseChapters(pageData, 90);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "Intro");
  assert.equal(chapters[0].startTime, 0);
  assert.equal(chapters[0].endTime, 30);
  assert.equal(chapters[1].title, "Main topic");
  assert.equal(chapters[1].startTime, 30);
  assert.equal(chapters[1].endTime, 90, "last chapter should extend to video duration");
});

test("ChapterStrategy.parseChapters returns [] when no chapter data is present", () => {
  assert.deepEqual(ChapterStrategy.parseChapters({ ytInitialData: {} }, 90), []);
});

const CHAPTERS_ONLY_PAGE_DATA = {
  ytInitialData: {
    markersMap: [
      { value: { chapters: [{ chapterRenderer: { title: "Ch 1", timeRangeStartMillis: 0 } }] } },
    ],
  },
};

test("DetectionManager.fetchRawSignals returns heatmap and chapters independently, never picking one over the other", () => {
  const emptyDoc = makeDoc(el("body", {}, {}, []));

  // Heatmap only.
  const heatmapDocInstance = heatmapDoc([{ widthPx: 895, d: REAL_HEATMAP_PATH_D }]);
  const heatmapOnly = DetectionManager.fetchRawSignals({}, 973, { doc: heatmapDocInstance });
  assert.ok(heatmapOnly.heatmapSamples.length > 0);
  assert.equal(heatmapOnly.chapters.length, 0);

  // Chapters only.
  const chaptersOnly = DetectionManager.fetchRawSignals(CHAPTERS_ONLY_PAGE_DATA, 100, { doc: emptyDoc });
  assert.equal(chaptersOnly.heatmapSamples.length, 0);
  assert.ok(chaptersOnly.chapters.length > 0);

  // Both at once — the whole point of this contract: a video with both a
  // heatmap and chapters must expose both, not silently drop one in favor
  // of the other (an earlier version of this function did exactly that).
  const both = DetectionManager.fetchRawSignals(CHAPTERS_ONLY_PAGE_DATA, 973, { doc: heatmapDocInstance });
  assert.ok(both.heatmapSamples.length > 0, "heatmap should still be present");
  assert.ok(both.chapters.length > 0, "chapters should still be present");

  // Neither.
  const neither = DetectionManager.fetchRawSignals({ ytInitialData: {} }, 100, { doc: emptyDoc });
  assert.equal(neither.heatmapSamples.length, 0);
  assert.equal(neither.chapters.length, 0);
});

test("DetectionManager.computeHeatmapRanges 'most-replayed' keeps the top-scoring slice", () => {
  const samples = [
    { startTime: 0, endTime: 10, score: 0.1 },
    { startTime: 50, endTime: 60, score: 0.9 },
  ];
  const ranges = DetectionManager.computeHeatmapRanges(samples, {
    mode: "most-replayed",
    percentage: 0.05, // 5s target: the top scorer's 10s segment alone covers it
    paddingBefore: 0,
    paddingAfter: 0,
    mergeGap: 0,
    duration: 100,
  });
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].startTime, 50);
});

test("DetectionManager.computeHeatmapRanges 'skip-filler' keeps everything except the lowest-scoring slice", () => {
  const samples = [
    { startTime: 0, endTime: 10, score: 0.05 }, // filler -> cut
    { startTime: 50, endTime: 60, score: 0.9 },
  ];
  const ranges = DetectionManager.computeHeatmapRanges(samples, {
    mode: "skip-filler",
    percentage: 0.1, // ~10s of a 100s video is filler
    paddingBefore: 0,
    paddingAfter: 0,
    mergeGap: 0,
    duration: 100,
  });
  // The 0-10 filler segment should be excluded; everything else retained.
  assert.ok(!ranges.some((r) => r.startTime === 0 && r.endTime === 10));
  const totalKept = ranges.reduce((sum, r) => sum + (r.endTime - r.startTime), 0);
  assert.ok(totalKept > 80, `expected most of the video retained, got ${totalKept}s of ${JSON.stringify(ranges)}`);
});

test("DetectionManager.rangesFromChapterSelection pads, merges and clamps selected chapters", () => {
  const chapters = [
    { startTime: 0, endTime: 10 },
    { startTime: 20, endTime: 30 },
  ];
  const ranges = DetectionManager.rangesFromChapterSelection(chapters, {
    duration: 30,
    paddingBefore: 0,
    paddingAfter: 0,
    mergeGap: 0,
  });
  assert.equal(ranges.length, 2);
  assert.equal(ranges[1].endTime, 30);
});

test("DetectionManager.rangesFromChapterSelection keeps touching-but-selected chapters as separate ranges", () => {
  // Adjacent chapters routinely share a boundary (one's endTime === the
  // next one's startTime) — that must not fuse them into a single range,
  // or "next/previous chapter" nav and the "Chapter X of Y" count would
  // silently undercount by one for every pair of consecutive picks.
  const chapters = [
    { startTime: 0, endTime: 10 },
    { startTime: 10, endTime: 20 },
    { startTime: 20, endTime: 30 },
  ];
  const ranges = DetectionManager.rangesFromChapterSelection(chapters, {
    duration: 30,
    paddingBefore: 0,
    paddingAfter: 0,
    mergeGap: 0,
  });
  assert.equal(ranges.length, 3, `expected 3 distinct chapter ranges, got ${JSON.stringify(ranges)}`);
});

test("DetectionManager.rangesFromChapterSelection still merges genuine overlap introduced by padding", () => {
  const chapters = [
    { startTime: 0, endTime: 10 },
    { startTime: 10, endTime: 20 },
  ];
  const ranges = DetectionManager.rangesFromChapterSelection(chapters, {
    duration: 20,
    paddingBefore: 0,
    paddingAfter: 2, // pushes the first chapter's end to 12, past the second's start (10) — real overlap
    mergeGap: 0,
  });
  assert.equal(ranges.length, 1, `expected padding-induced overlap to still merge, got ${JSON.stringify(ranges)}`);
});
