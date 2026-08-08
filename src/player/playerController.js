/**
 * playerController — the "virtual trim" engine.
 *
 * This never touches the video source: it only reads video.currentTime and
 * occasionally writes it. Given a chronologically-sorted list of retained
 * ranges, it listens to the native `timeupdate` event and, whenever
 * playback is about to leave (or has already left) a retained range, seeks
 * to the start of the next one. Turning highlight mode off simply removes
 * the listener — the video keeps playing wherever it is, full timeline
 * restored.
 *
 * Two things keep this from misbehaving:
 *  - SEEK_TOLERANCE: `timeupdate` fires in small, irregular steps (not on
 *    exact frame boundaries), so "am I at the end of this range" is a `<=`
 *    check against a tolerance, not an exact equality check.
 *  - MIN_SEEK_INTERVAL_MS + a remembered last-seek target: after
 *    video.currentTime is written, the browser's own subsequent
 *    `timeupdate` events can still report values a few frames behind the
 *    seek target for a moment. Without a cooldown, that reads as "we're
 *    still outside every range" and triggers another seek, which can
 *    repeat indefinitely (a seek loop / stutter). The cooldown plus
 *    "don't repeat a seek to basically the same target" check prevents it.
 */
(function (root) {
  "use strict";

  var SEEK_TOLERANCE = 0.35; // seconds
  var MIN_SEEK_INTERVAL_MS = 400;

  /**
   * @param {{video: HTMLVideoElement, rangeUtils: object,
   *   onStatusChange?: (status:object, reason:string, skippedSeconds:number)=>void}} deps
   *   `skippedSeconds` is only meaningful (>0) on the "advance"/"gap" reasons
   *   — the amount of video this particular auto-skip jumped over.
   */
  function createPlayerController(deps) {
    var video = deps.video;
    var rangeUtils = deps.rangeUtils;
    var onStatusChange = deps.onStatusChange || function () {};

    var ranges = [];
    var active = false;
    var finished = false;
    var lastSeekAt = 0;
    var lastSeekTarget = null;

    function emit(reason, skippedSeconds) {
      onStatusChange(status(), reason, skippedSeconds || 0);
    }

    function status() {
      if (!active) {
        return { active: false, index: -1, total: ranges.length, finished: finished };
      }
      var current = ranges.length ? rangeUtils.findCurrentInterval(ranges, video.currentTime) : null;
      var index = current ? ranges.indexOf(current) : -1;
      return {
        active: true,
        index: index,
        total: ranges.length,
        finished: finished,
        timeSaved: rangeUtils.calcTimeSaved(ranges, video.duration || 0),
        selectedDuration: rangeUtils.calcSelectedDuration(ranges),
      };
    }

    /** Replace the retained ranges (e.g. user changed mode/percentage). Safe to call while active. */
    function setRanges(newRanges) {
      ranges = rangeUtils.sortIntervals(newRanges || []);
      finished = false;
      if (active) {
        // The old position may no longer sit inside any range under the new set.
        reconcilePosition("ranges-changed");
      }
    }

    function withinCooldown() {
      return Date.now() - lastSeekAt < MIN_SEEK_INTERVAL_MS;
    }

    function seekTo(time, reason) {
      var isRedundant = withinCooldown() &&
        lastSeekTarget !== null &&
        Math.abs(time - lastSeekTarget) < SEEK_TOLERANCE;
      if (isRedundant) return;

      var fromTime = video.currentTime;
      lastSeekAt = Date.now();
      lastSeekTarget = time;
      try {
        video.currentTime = time;
      } catch (_err) {
        // Seeking can transiently fail (e.g. mid-buffering); the next
        // timeupdate tick will simply try again.
      }
      // How much of the video this particular seek jumped over — only
      // meaningful for forward jumps (an "advance"/"gap" skip); callers
      // decide which reasons are worth surfacing to the viewer.
      emit(reason, Math.max(0, time - fromTime));
    }

    function markFinished(reason) {
      if (finished) return;
      finished = true;
      if (!video.paused) {
        try { video.pause(); } catch (_err) { /* ignore */ }
      }
      emit(reason);
    }

    function reconcilePosition(reason) {
      if (!ranges.length) return;
      var t = video.currentTime;
      var current = rangeUtils.findCurrentInterval(ranges, t);
      if (current) return;

      var next = rangeUtils.findNextInterval(ranges, t);
      if (next) {
        seekTo(next.startTime, reason);
      } else if (t < ranges[0].startTime) {
        seekTo(ranges[0].startTime, reason);
      } else {
        markFinished("finished");
      }
    }

    function handleTimeUpdate() {
      if (!active || !ranges.length) return;
      var t = video.currentTime;
      var current = rangeUtils.findCurrentInterval(ranges, t);

      if (!current) {
        reconcilePosition("gap");
        return;
      }

      var atRangeEnd = current.endTime - t <= SEEK_TOLERANCE;
      if (!atRangeEnd) {
        emit("tick");
        return;
      }

      var index = ranges.indexOf(current);
      var next = ranges[index + 1];
      if (next) {
        seekTo(next.startTime, "advance");
      } else {
        markFinished("finished");
      }
    }

    /**
     * Jump directly to the next/previous retained range's start, by index
     * — for the panel's prev/next-highlight buttons and arrow-key nav.
     * Independent of `active`: works whether highlight mode is on or off,
     * same as any other manual seek (see content.js's "seek" handling).
     * If currentTime isn't inside any range, jumps to the nearest one in
     * the requested direction; at either end of the list, clamps rather
     * than wrapping.
     */
    function jumpBy(offset, reason) {
      if (!ranges.length) return;
      var t = video.currentTime;
      var current = rangeUtils.findCurrentInterval(ranges, t);
      var target;
      if (current) {
        var idx = ranges.indexOf(current) + offset;
        idx = Math.max(0, Math.min(ranges.length - 1, idx));
        target = ranges[idx];
      } else if (offset > 0) {
        target = rangeUtils.findNextInterval(ranges, t) || ranges[ranges.length - 1];
      } else {
        target = rangeUtils.findPreviousInterval(ranges, t) || ranges[0];
      }
      seekTo(target.startTime, reason);
    }

    function jumpToNext() { jumpBy(1, "next"); }
    function jumpToPrevious() { jumpBy(-1, "previous"); }

    /** Turn highlight mode on. Preserves whatever play/pause state the video is already in. */
    function activate() {
      if (active) return;
      active = true;
      finished = false;
      video.addEventListener("timeupdate", handleTimeUpdate);
      reconcilePosition("activate");
      emit("activated");
    }

    /** Turn highlight mode off. Stops skipping immediately; leaves playback position/state untouched. */
    function deactivate() {
      if (!active) return;
      active = false;
      video.removeEventListener("timeupdate", handleTimeUpdate);
      emit("deactivated");
    }

    function destroy() {
      deactivate();
      ranges = [];
    }

    return {
      setRanges: setRanges,
      activate: activate,
      deactivate: deactivate,
      destroy: destroy,
      status: status,
      isActive: function () { return active; },
      jumpToNext: jumpToNext,
      jumpToPrevious: jumpToPrevious,
    };
  }

  var api = {
    createPlayerController: createPlayerController,
    SEEK_TOLERANCE: SEEK_TOLERANCE,
    MIN_SEEK_INTERVAL_MS: MIN_SEEK_INTERVAL_MS,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.PlayerController = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
