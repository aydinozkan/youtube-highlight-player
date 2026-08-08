/**
 * videoWatcher — DOM/SPA plumbing: waiting for elements to exist, and
 * detecting video changes on YouTube's single-page-app navigation.
 *
 * YouTube swaps videos without a full page reload, so `document.location`
 * changes but nothing else about the page tears down automatically. It
 * fires a `yt-navigate-finish` custom event on `document` when a navigation
 * completes — that's the primary signal here. Because that event name is an
 * internal implementation detail YouTube could rename or drop, a low-
 * frequency URL-polling fallback runs alongside it so navigation is still
 * detected (just a little later) even if the event ever goes away.
 */
(function (root) {
  "use strict";

  /**
   * Resolve once `selector` matches an element under `root` (default:
   * document), or reject after `timeout` ms. Uses a MutationObserver rather
   * than polling so it responds the instant YouTube renders the element.
   */
  function waitForElement(selector, options) {
    var opts = options || {};
    var timeout = typeof opts.timeout === "number" ? opts.timeout : 15000;
    var searchRoot = opts.root || document;

    return new Promise(function (resolve, reject) {
      var existing = searchRoot.querySelector(selector);
      if (existing) {
        resolve(existing);
        return;
      }

      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        observer.disconnect();
        reject(new Error('Timed out waiting for "' + selector + '"'));
      }, timeout);

      var observer = new MutationObserver(function () {
        var el = searchRoot.querySelector(selector);
        if (el && !settled) {
          settled = true;
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });

      var observeTarget = searchRoot === document ? document.documentElement : searchRoot;
      observer.observe(observeTarget, { childList: true, subtree: true });
    });
  }

  /**
   * Resolves once `video.duration` is a positive finite number, or after
   * `timeout` ms (resolving with whatever `video.duration` is then, even if
   * that's 0/NaN — callers already treat "unknown duration" as "no ranges
   * yet" rather than an error).
   */
  function waitForDuration(video, options) {
    var opts = options || {};
    var timeout = typeof opts.timeout === "number" ? opts.timeout : 8000;

    return new Promise(function (resolve) {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        resolve(video.duration);
        return;
      }

      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        video.removeEventListener("loadedmetadata", onChange);
        video.removeEventListener("durationchange", onChange);
        clearTimeout(timer);
        resolve(value);
      }
      function onChange() {
        if (Number.isFinite(video.duration) && video.duration > 0) finish(video.duration);
      }

      video.addEventListener("loadedmetadata", onChange);
      video.addEventListener("durationchange", onChange);
      var timer = setTimeout(function () { finish(video.duration || 0); }, timeout);
    });
  }

  function getCurrentVideoId() {
    try {
      return new URLSearchParams(window.location.search).get("v");
    } catch (_err) {
      return null;
    }
  }

  /**
   * Calls `callback(videoId)` whenever the current watch-page video id
   * changes. Returns an unsubscribe function.
   */
  function onNavigate(callback) {
    var lastVideoId = getCurrentVideoId();

    function handleEvent() {
      var current = getCurrentVideoId();
      if (current === lastVideoId) return;
      lastVideoId = current;
      callback(current);
    }

    document.addEventListener("yt-navigate-finish", handleEvent);

    // Fallback in case YouTube ever renames/removes yt-navigate-finish.
    // 1s is frequent enough to feel instant to a user but cheap enough to
    // run indefinitely in a background tab.
    var pollHandle = setInterval(handleEvent, 1000);

    return function unsubscribe() {
      document.removeEventListener("yt-navigate-finish", handleEvent);
      clearInterval(pollHandle);
    };
  }

  root.YHP = root.YHP || {};
  root.YHP.VideoWatcher = {
    waitForElement: waitForElement,
    waitForDuration: waitForDuration,
    getCurrentVideoId: getCurrentVideoId,
    onNavigate: onNavigate,
  };
})(typeof window !== "undefined" ? window : globalThis);
