const test = require("node:test");
const assert = require("node:assert/strict");
const RangeUtils = require("../src/utils/rangeUtils");
const { createPlayerController } = require("../src/player/playerController");

/** Minimal fake <video> good enough to drive playerController's timeupdate logic. */
function createFakeVideo({ duration = 100 } = {}) {
  const target = new EventTarget();
  const video = {
    currentTime: 0,
    duration,
    paused: false,
    pause() { this.paused = true; },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    tick(time) {
      this.currentTime = time;
      target.dispatchEvent(new Event("timeupdate"));
    },
  };
  return video;
}

test("playerController seeks to the next range once the current one ends", () => {
  const video = createFakeVideo({ duration: 100 });
  const events = [];
  const controller = createPlayerController({
    video,
    rangeUtils: RangeUtils,
    onStatusChange: (status, reason) => events.push(reason),
  });

  controller.setRanges([
    { startTime: 0, endTime: 10 },
    { startTime: 20, endTime: 30 },
  ]);
  controller.activate();

  video.tick(9.8); // within tolerance of range end
  assert.equal(video.currentTime, 20, "should have jumped to the start of the next range");
  assert.ok(events.includes("advance"));
});

test("playerController pauses and reports finished after the last range", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({
    video,
    rangeUtils: RangeUtils,
    onStatusChange: () => {},
  });

  controller.setRanges([{ startTime: 0, endTime: 10 }]);
  controller.activate();
  video.tick(9.9);

  assert.equal(video.paused, true);
  assert.equal(controller.status().finished, true);
});

test("playerController jumps forward when the user seeks into a gap", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({
    video,
    rangeUtils: RangeUtils,
    onStatusChange: () => {},
  });

  controller.setRanges([
    { startTime: 0, endTime: 10 },
    { startTime: 50, endTime: 60 },
  ]);
  controller.activate();

  // User drags the scrubber into the middle of the skipped-over gap.
  video.tick(30);
  assert.equal(video.currentTime, 50);
});

test("playerController does not seek-loop: rapid ticks near a boundary only seek once within the cooldown", () => {
  const video = createFakeVideo({ duration: 100 });
  let seekCount = 0;
  const controller = createPlayerController({
    video,
    rangeUtils: RangeUtils,
    onStatusChange: (status, reason) => {
      if (reason === "advance" || reason === "gap") seekCount += 1;
    },
  });

  controller.setRanges([
    { startTime: 0, endTime: 10 },
    { startTime: 20, endTime: 30 },
  ]);
  controller.activate();

  // Simulate several timeupdate ticks firing in quick succession right at
  // the boundary, as can happen with real <video> elements.
  video.tick(9.9);
  video.tick(9.95); // fake video doesn't auto-advance after currentTime write; still "stale" near boundary
  video.tick(20.01); // browser's own subsequent tick after the seek landed

  assert.equal(seekCount, 1, "should not have re-triggered a seek loop");
  // 20.01 is already inside the next retained range, so no further seek was needed.
  assert.equal(video.currentTime, 20.01);
});

test("playerController.deactivate stops skipping immediately and leaves position untouched", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({
    video,
    rangeUtils: RangeUtils,
    onStatusChange: () => {},
  });

  controller.setRanges([{ startTime: 0, endTime: 10 }, { startTime: 50, endTime: 60 }]);
  controller.activate();
  controller.deactivate();

  video.tick(11); // would have triggered a gap-jump if still active
  assert.equal(video.currentTime, 11, "position should be left alone once deactivated");
});

test("playerController.activate preserves the video's play/pause state", () => {
  const video = createFakeVideo({ duration: 100 });
  video.paused = true;
  const controller = createPlayerController({ video, rangeUtils: RangeUtils, onStatusChange: () => {} });
  controller.setRanges([{ startTime: 0, endTime: 10 }]);
  controller.activate();
  assert.equal(video.paused, true, "activate() must not force playback to start");
});

test("playerController reports the skipped duration on an 'advance' seek", () => {
  const video = createFakeVideo({ duration: 100 });
  const reports = [];
  const controller = createPlayerController({
    video,
    rangeUtils: RangeUtils,
    onStatusChange: (status, reason, skippedSeconds) => reports.push({ reason, skippedSeconds }),
  });

  controller.setRanges([{ startTime: 0, endTime: 10 }, { startTime: 30, endTime: 40 }]);
  controller.activate();
  video.tick(9.9); // ends the first range -> jumps to 30: a 20.1s skip

  const advance = reports.find((r) => r.reason === "advance");
  assert.ok(advance, `expected an "advance" report, got ${JSON.stringify(reports)}`);
  assert.ok(Math.abs(advance.skippedSeconds - 20.1) < 0.01, `expected ~20.1s skipped, got ${advance.skippedSeconds}`);
});

test("playerController reports 0 skipped seconds for non-skip events (activate, tick)", () => {
  const video = createFakeVideo({ duration: 100 });
  const reports = [];
  const controller = createPlayerController({
    video,
    rangeUtils: RangeUtils,
    onStatusChange: (status, reason, skippedSeconds) => reports.push({ reason, skippedSeconds }),
  });

  controller.setRanges([{ startTime: 0, endTime: 10 }]);
  controller.activate(); // already inside the first range: no seek needed
  video.tick(5); // mid-range tick, no skip

  reports.forEach((r) => assert.equal(r.skippedSeconds, 0, `expected 0 for reason "${r.reason}"`));
});

test("jumpToNext/jumpToPrevious navigate between ranges by index", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({ video, rangeUtils: RangeUtils, onStatusChange: () => {} });
  controller.setRanges([{ startTime: 0, endTime: 10 }, { startTime: 20, endTime: 30 }, { startTime: 40, endTime: 50 }]);

  video.currentTime = 25; // inside the middle range
  controller.jumpToNext();
  assert.equal(video.currentTime, 40);

  video.currentTime = 25;
  controller.jumpToPrevious();
  assert.equal(video.currentTime, 0);
});

test("jumpToNext clamps at the last range instead of wrapping (restarts it)", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({ video, rangeUtils: RangeUtils, onStatusChange: () => {} });
  controller.setRanges([{ startTime: 0, endTime: 10 }, { startTime: 40, endTime: 50 }]);

  video.currentTime = 45; // inside the last range
  controller.jumpToNext();
  assert.equal(video.currentTime, 40, "should restart the last range rather than go past it");
});

test("jumpToPrevious clamps at the first range instead of wrapping", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({ video, rangeUtils: RangeUtils, onStatusChange: () => {} });
  controller.setRanges([{ startTime: 0, endTime: 10 }, { startTime: 40, endTime: 50 }]);

  video.currentTime = 5; // inside the first range
  controller.jumpToPrevious();
  assert.equal(video.currentTime, 0, "should restart the first range rather than go before it");
});

test("jumpToNext/jumpToPrevious from a gap (not inside any range) jump to the nearest range", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({ video, rangeUtils: RangeUtils, onStatusChange: () => {} });
  controller.setRanges([{ startTime: 0, endTime: 10 }, { startTime: 40, endTime: 50 }]);

  video.currentTime = 25; // in the gap between ranges
  controller.jumpToNext();
  assert.equal(video.currentTime, 40);

  video.currentTime = 25;
  controller.jumpToPrevious();
  assert.equal(video.currentTime, 0);
});

test("jumpToNext/jumpToPrevious work even when highlight mode is not active", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({ video, rangeUtils: RangeUtils, onStatusChange: () => {} });
  controller.setRanges([{ startTime: 0, endTime: 10 }, { startTime: 40, endTime: 50 }]);
  // controller.activate() deliberately not called

  video.currentTime = 5;
  controller.jumpToNext();
  assert.equal(video.currentTime, 40);
});

test("jumpToNext/jumpToPrevious are no-ops with no ranges set", () => {
  const video = createFakeVideo({ duration: 100 });
  const controller = createPlayerController({ video, rangeUtils: RangeUtils, onStatusChange: () => {} });
  video.currentTime = 5;
  controller.jumpToNext();
  controller.jumpToPrevious();
  assert.equal(video.currentTime, 5);
});
