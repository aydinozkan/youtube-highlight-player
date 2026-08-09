/**
 * content — orchestrator. The only module that wires the other pieces
 * together and owns the per-video lifecycle:
 *
 *   navigate -> teardown previous video's listeners/UI -> wait for <video>
 *   -> mount the panel shell immediately -> fetch page data -> detect
 *   -> reveal real content -> (repeat on next navigation)
 *
 * Runs last in manifest.json's content_scripts list, after every module it
 * depends on (window.YHP.*) has already attached itself.
 *
 * The panel shell (header: nav arrows, play badge, title, toggle, collapse
 * icon; footer) mounts as soon as the `<video>` element and stored settings
 * are available — independent of chapters/heatmap detection entirely, which
 * can take anywhere from under a second (chapters) to several seconds
 * (heatmap). Panel.mount() starts in a "pending" state (a neutral skeleton
 * fills the content area) and `panelApi.reveal()` below is the one place
 * that transitions it once real detection data — or a confirmed "neither
 * exists" after giving up — is known. An earlier version built a separate,
 * reduced placeholder element here and swapped the whole panel out once
 * detection finished; that meant the real, interactive header didn't
 * appear until detection did either, which defeated the entire point of
 * showing anything early.
 *
 * Chapters and the heatmap are independent facts about a video (see
 * detectionManager.js) that usually resolve on very different timelines:
 * chapters normally come from page data already fetched in full by the
 * time detection starts (no further waiting needed — known for certain on
 * the first check), while the heatmap needs a DOM element YouTube
 * populates asynchronously, observed taking several seconds. reveal() fires
 * the instant chapters resolve (near-instantly, in practice) if there are
 * any, and again later if the heatmap arrives first (or alone). If chapters
 * were already revealed when the heatmap arrives, `panelApi.upgradeToHeatmap()`
 * reveals the tab switcher instead of a second reveal.
 *
 * The one exception: right after a same-tab SPA navigation to a second+
 * video, the page-global chapters normally come from (`ytInitialData`) can
 * describe the *previous* video instead — it's a load-once global YouTube's
 * own client-side navigation never reassigns. When that's detected (see
 * `chaptersTrustworthy` below), chapters are instead fetched fresh over the
 * network for this specific video (`fetchFreshChapters`), in parallel with
 * the heatmap poll — reveal() waits for both in that case, since neither
 * can be trusted as final until then.
 */
(function () {
  "use strict";

  var YHP = window.YHP;
  var VideoWatcher = YHP.VideoWatcher;
  var DataBridge = YHP.DataBridge;
  var DetectionManager = YHP.DetectionManager;
  var ChapterStrategy = YHP.ChapterStrategy;
  var ExtractYtInitialData = YHP.ExtractYtInitialData;
  var RangeUtils = YHP.RangeUtils;
  var PlayerController = YHP.PlayerController;
  var Panel = YHP.Panel;
  var SkipIndicator = YHP.SkipIndicator;
  var NativeToggleButton = YHP.NativeToggleButton;
  var Store = YHP.Store;
  var ErrorReporter = YHP.ErrorReporter;
  var Analytics = YHP.Analytics;

  // Installed once, at module load — catches genuinely uncaught exceptions
  // and unhandled promise rejections anywhere in this content script's
  // isolated world (including e.g. init() itself throwing past all its own
  // guards, which surfaces as an unhandled rejection since neither call
  // site below awaits or catches it). See errorReporter.js for what this
  // does and, just as importantly, doesn't report.
  ErrorReporter.installGlobalHandlers(window, "content");

  var VIDEO_SELECTOR = "video.html5-main-video, #movie_player video";
  var PANEL_ANCHOR_SELECTORS = ["#below", "#bottom-row", "#player-container"];
  var PLAYER_CONTAINER_SELECTOR = "#movie_player";
  // How long to keep re-checking for real heatmap data after the (often
  // initially-empty) container appears — see the polling loop's comment
  // below for the live evidence behind this number: the real path data was
  // observed landing ~3s after the empty container on videos that do have
  // one, so 4s still leaves a real margin above that. This budget no
  // longer needs shortening when chapters are already available (an
  // earlier version did that) — now that chapters render immediately and
  // this keeps polling quietly in the background, there's no user-facing
  // cost to giving the heatmap this window every time, whether or not
  // chapters exist too.
  var HEATMAP_POLL_INTERVAL_MS = 400;
  var HEATMAP_POLL_BUDGET_MS = 4000;
  var MIN_SKIP_TO_SHOW = 0.75; // seconds; ignore sub-tolerance corrections, not real "skips"
  // On SPA navigation, pageBridge.js's own videoId (URL-derived —
  // window.location.search's "v" param) updates essentially immediately,
  // but playerResponse (getPlayerResponse(), a live call into the actual
  // player instance) is refreshed by YouTube's own internal async process
  // shortly after — landing in that gap meant a fresh video's pageData
  // snapshot could still describe the *previous* video's duration/id.
  // Guarded by retrying until playerResponse.videoDetails.videoId — a
  // field genuinely inside the response, not just the URL — actually
  // matches, or this budget runs out (fails open immediately if the
  // field's just unavailable for this video/embed, rather than retrying
  // forever on an unreliable check).
  var PAGE_DATA_FRESHNESS_RETRY_MS = 250;
  var PAGE_DATA_FRESHNESS_BUDGET_MS = 1500;
  // Unlike playerResponse above, pageData.ytInitialData (chapters' one real
  // source — see chapterStrategy.js) turned out NOT to be a "lags behind,
  // retry until it catches up" case at all: it's a load-once global
  // YouTube's own client-side navigation never reassigns, so it can't
  // become fresh no matter how long this retries (confirmed live — see
  // fetchFreshChapters' own comment below). pageData.ytInitialDataVideoId
  // (see pageBridge.js) is checked once, with no retry loop, purely to
  // decide whether to trust it or route around it entirely.
  var FRESH_CHAPTERS_FETCH_TIMEOUT_MS = 4000;

  // Troubleshooting aid, off by default so the console stays quiet in
  // normal use. Enable from DevTools without needing a new build:
  //   localStorage.setItem("yhp_debug", "1")   (then refresh the page)
  // Logs unconditionally to the normal console — isolated-world
  // console.log output shows up there without switching DevTools'
  // execution-context dropdown, unlike evaluated expressions.
  function isDebugEnabled() {
    try { return localStorage.getItem("yhp_debug") === "1"; } catch (_err) { return false; }
  }
  function debugLog() {
    if (!isDebugEnabled()) return;
    var args = Array.prototype.slice.call(arguments);
    args.unshift("[YHP]");
    console.log.apply(console, args);
  }

  var teardownFns = [];
  var initToken = 0; // guards against a stale async init() finishing after a newer one started

  function teardown() {
    while (teardownFns.length) {
      var fn = teardownFns.pop();
      try { fn(); } catch (_err) { /* one bad cleanup shouldn't block the rest */ }
    }
  }

  function findPanelAnchor() {
    for (var i = 0; i < PANEL_ANCHOR_SELECTORS.length; i += 1) {
      var el = document.querySelector(PANEL_ANCHOR_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function mountPanelInPage(panelRoot) {
    var anchor = findPanelAnchor();
    if (!anchor) return false;
    anchor.insertBefore(panelRoot, anchor.firstChild);
    return true;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function init(videoId) {
    var myToken = ++initToken;
    teardown();
    if (!videoId) return;

    debugLog("init() starting for videoId", videoId, "— extension v" + chrome.runtime.getManifest().version);

    var video;
    try {
      video = await VideoWatcher.waitForElement(VIDEO_SELECTOR, { timeout: 15000 });
    } catch (_err) {
      debugLog("no <video> element found; giving up for this navigation");
      return; // No player on this page (e.g. non-watch route); nothing to do.
    }
    if (myToken !== initToken) return; // a newer navigation superseded this one
    debugLog("video element found", video);

    var settings = await Store.load();
    if (myToken !== initToken) return;
    // Re-initialized on every navigation with the current setting, so a
    // mid-session settings-popover toggle (see the "analyticsToggle" case
    // below) and a real navigation both keep this in sync — there's no
    // stale "enabled at the time this tab first loaded" state to worry about.
    Analytics.init(settings.analyticsEnabled);

    // ---- Mount the shell immediately — the header (nav arrows, play
    // badge, title, toggle, collapse icon) and footer are fully real and
    // interactive from this point on, independent of whether anything is
    // known yet about this video's highlights/chapters. The content area
    // starts as a neutral skeleton (Panel.mount always starts pending) and
    // gets replaced once reveal() below actually has something to show. ----
    var duration = 0;
    var controller = null;
    var currentSignals = { heatmapSamples: [], chapters: [] };

    function applyRanges() {
      if (!controller) return;
      var state = panelApi.getState();
      var activeSource = panelApi.getActiveSource();
      var ranges = [];

      if (activeSource === "heatmap") {
        ranges = DetectionManager.computeHeatmapRanges(currentSignals.heatmapSamples, {
          mode: state.mode,
          percentage: state.percentage,
          paddingBefore: state.paddingBefore,
          paddingAfter: state.paddingAfter,
          mergeGap: state.mergeGap,
          duration: duration,
        });
      } else if (activeSource === "chapters") {
        ranges = DetectionManager.rangesFromChapterSelection(panelApi.getSelectedChapters(), {
          paddingBefore: 0,
          paddingAfter: 0,
          mergeGap: 0,
          duration: duration,
        });
      }

      debugLog("computed ranges (" + ranges.length + ") for", activeSource + ":", ranges.map(function (r) {
        return r.startTime.toFixed(1) + "-" + r.endTime.toFixed(1) + " (score " + (r.score || 0).toFixed(2) + ")";
      }));

      controller.setRanges(ranges);
      panelApi.updateRanges(ranges, duration);
    }

    var playerContainer = document.querySelector(PLAYER_CONTAINER_SELECTOR) || video.parentElement;
    debugLog("player container for skip indicator:", playerContainer);
    var skipIndicator = SkipIndicator.mount(playerContainer);
    teardownFns.push(function () { skipIndicator.destroy(); });

    controller = PlayerController.createPlayerController({
      video: video,
      rangeUtils: RangeUtils,
      onStatusChange: function (status, reason, skippedSeconds) {
        panelApi.updateStatus(status, reason);
        // "advance"/"gap" are genuine auto-skips during ongoing playback;
        // other reasons (activate, finished, deactivated, tick) aren't —
        // flashing the indicator on every tick would be noise, and flashing
        // it on activation would just be restating what the status line
        // already says the instant highlight mode turns on.
        if (reason === "advance" || reason === "gap") {
          debugLog("seek reason:", reason, "skippedSeconds:", skippedSeconds,
            "will show indicator:", skippedSeconds >= MIN_SKIP_TO_SHOW);
        }
        if ((reason === "advance" || reason === "gap") && skippedSeconds >= MIN_SKIP_TO_SHOW) {
          skipIndicator.show(skippedSeconds);
        }
      },
    });

    // Single source of truth for "is highlight mode on", shared by the
    // panel's own toggle and the native control-bar button below — both
    // are just entry points into this, never independent state.
    var highlightsEnabled = !!settings.highlightsEnabled;
    function setHighlightsEnabled(enabled) {
      highlightsEnabled = enabled;
      Store.save({ highlightsEnabled: enabled });
      if (enabled) controller.activate(); else controller.deactivate();
      panelApi.setEnabled(enabled);
      if (nativeButton) nativeButton.setEnabled(enabled);
      // The only two callers of this function are the panel's own toggle
      // and the native control-bar button — both real user actions, never
      // a programmatic set — so this is always a genuine "the viewer just
      // did something" event, not initial-mount noise.
      Analytics.track("highlights_toggled", { enabled: enabled });
    }

    var panelApi = Panel.mount({
      settings: settings,
      duration: duration,
      onChange: function (event) {
        if (event.type === "toggle") { setHighlightsEnabled(event.enabled); return; }
        if (event.type === "seek") {
          // Jump directly to the clicked point. If highlight mode is active,
          // playerController's own timeupdate handling takes it from here —
          // landing inside a skipped span gets auto-corrected to the next
          // retained range on the very next tick, same as any other seek.
          try { video.currentTime = event.time; } catch (_err) { /* transient seek errors are harmless */ }
          return;
        }
        if (event.type === "playPause") {
          try { if (video.paused) video.play(); else video.pause(); } catch (_err) { /* ignore */ }
          return;
        }
        if (event.type === "previous") { controller.jumpToPrevious(); return; }
        if (event.type === "next") { controller.jumpToNext(); return; }
        if (event.type === "collapsedChange") { Store.save({ panelCollapsed: event.collapsed }); return; }
        if (event.type === "introSeen") { Store.save({ introSeen: true }); return; }
        if (event.type === "onboardingShown") { Analytics.track("onboarding_shown"); return; }
        if (event.type === "onboardingDismissed") { Analytics.track("onboarding_dismissed"); return; }
        if (event.type === "sourceTabClicked") { Analytics.track("source_tab_clicked", { to: event.to }); return; }
        if (event.type === "supportLinkClicked") { Analytics.track("support_link_clicked", { platform: event.platform }); return; }
        if (event.type === "retryDetection") {
          Analytics.track("check_again_clicked");
          // "No data yet" (the empty-state panel) most often means
          // YouTube's own "most replayed" data hasn't populated for a
          // new upload yet — re-run the whole per-video pipeline from
          // scratch, same teardown-and-rebuild path a real navigation or
          // a corrected duration already uses, so a second attempt gets
          // a fully consistent state if data has since shown up.
          init(videoId);
          return;
        }
        if (event.type === "analyticsToggle") {
          // Takes effect immediately in this tab (not just on next
          // navigation) — Analytics.init() is otherwise only called at
          // the top of init(), which a mid-session toggle click doesn't
          // go through.
          Store.save({ analyticsEnabled: event.enabled });
          Analytics.init(event.enabled);
          return;
        }
        // Unhandled types (chapterSelection, tabChange) all mean the same
        // thing here: something that affects which ranges are retained
        // changed — recompute.
        applyRanges();
      },
    });

    // The play badge reflects the video's *real* play/pause state — driven
    // by these events rather than only our own button, so it stays correct
    // if the viewer uses YouTube's native controls or the spacebar instead.
    function handlePlayStateChange() { panelApi.setPlaying(!video.paused); }
    video.addEventListener("play", handlePlayStateChange);
    video.addEventListener("pause", handlePlayStateChange);
    teardownFns.push(function () {
      video.removeEventListener("play", handlePlayStateChange);
      video.removeEventListener("pause", handlePlayStateChange);
    });

    // The live playhead tracks real playback position regardless of
    // whether highlight mode is on — unlike playerController's own
    // timeupdate listener, which only runs while active.
    function handlePlayheadTick() { panelApi.updatePlayhead(video.currentTime); }
    video.addEventListener("timeupdate", handlePlayheadTick);
    teardownFns.push(function () { video.removeEventListener("timeupdate", handlePlayheadTick); });

    var mounted = mountPanelInPage(panelApi.root);
    panelApi.setPlaying(!video.paused); // sync the play badge with whatever state the video is already in

    teardownFns.push(function () { controller.destroy(); });
    teardownFns.push(function () { panelApi.destroy(); });

    // Some YouTube videos report an initial/estimated duration that gets
    // refined once more of the manifest has loaded — if that happens after
    // our one-time capture below, everything computed from it (range
    // boundaries, the timeline's x-axis mapping) quietly drifts out of
    // sync with the real, current video length. Rather than patch each
    // symptom individually, just reinitialize from scratch on a real
    // duration change — same teardown-and-rebuild path navigation already
    // uses, so everything (signals, ranges, panel) ends up consistent
    // with the corrected duration.
    function handleDurationChange() {
      if (myToken !== initToken) return;
      var newDuration = video.duration;
      if (!(newDuration > 0) || Math.abs(newDuration - duration) < 1) return; // ignore jitter
      debugLog("video duration changed:", duration.toFixed(1), "->", newDuration.toFixed(1), "— reinitializing");
      init(videoId);
    }
    video.addEventListener("durationchange", handleDurationChange);
    teardownFns.push(function () { video.removeEventListener("durationchange", handleDurationChange); });

    // The anchor element YouTube renders "#below" into can itself get
    // replaced during some navigations without a video-id change (rare,
    // but has been observed). If our panel silently vanished, try once
    // to remount it against the current DOM.
    if (!mounted) {
      var retryTimer = setTimeout(function () {
        if (myToken !== initToken) return;
        mountPanelInPage(panelApi.root);
      }, 1500);
      teardownFns.push(function () { clearTimeout(retryTimer); });
    }

    // Re-fetches page data until it actually describes *this* video (see
    // PAGE_DATA_FRESHNESS_BUDGET_MS's comment above) or the budget runs out.
    async function fetchFreshPageData() {
      var elapsed = 0;
      var data = null;
      while (elapsed <= PAGE_DATA_FRESHNESS_BUDGET_MS) {
        if (myToken !== initToken) return null;
        data = await DataBridge.requestPageData();
        if (myToken !== initToken) return null;
        var seenId = data && data.playerResponse && data.playerResponse.videoDetails
          && data.playerResponse.videoDetails.videoId;
        if (!seenId || seenId === videoId) {
          debugLog("pageData fresh — videoDetails.videoId:", seenId || "(unavailable, trusting as-is)", "elapsed:", elapsed + "ms");
          return data;
        }
        debugLog("pageData stale — expected", videoId, "got", seenId, "retrying in", PAGE_DATA_FRESHNESS_RETRY_MS + "ms");
        if (elapsed >= PAGE_DATA_FRESHNESS_BUDGET_MS) break;
        await delay(PAGE_DATA_FRESHNESS_RETRY_MS);
        elapsed += PAGE_DATA_FRESHNESS_RETRY_MS;
      }
      return data;
    }

    // ---- Now fetch page data + real duration, then detect. The shell
    // above is already live and interactive while this runs. ----
    var results = await Promise.all([
      fetchFreshPageData(),
      VideoWatcher.waitForDuration(video, { timeout: 8000 }),
    ]);
    if (myToken !== initToken) return;

    var pageData = results[0];
    duration = results[1] || (pageData && pageData.duration) || 0;
    debugLog("duration resolved:", duration, "pageData:", pageData);

    // Independent of detection/reveal() below — the panel's header
    // mounted immediately at init() with the extension's own name as a
    // placeholder (see panel.js's setVideoTitle comment); this swaps in
    // the real video title as soon as it's known, which is normally much
    // sooner than detection finishes. Reusing the exact same pageData
    // object duration/videoId already trusted above, not a new fetch —
    // no separate freshness question to answer for it.
    var videoTitle = pageData && pageData.playerResponse
      && pageData.playerResponse.videoDetails && pageData.playerResponse.videoDetails.title;
    if (videoTitle) panelApi.setVideoTitle(videoTitle);

    var revealed = false;
    function reveal(signals) {
      if (revealed) return;
      revealed = true;
      currentSignals = signals;
      panelApi.revealSignals(signals, duration);
      maybeMountNativeButton(signals);
      applyRanges();
      if (settings.highlightsEnabled && (signals.heatmapSamples.length > 0 || signals.chapters.length > 0)) {
        controller.activate();
      }
      // One event per video, once detection has actually finished (not per
      // poll tick) — tells us how often each strategy earns its keep in
      // the wild, without ever naming which video it was.
      Analytics.track("detection_result", {
        has_heatmap: signals.heatmapSamples.length > 0,
        has_chapters: signals.chapters.length > 0,
      });
    }

    // Fetches this exact video's own watch page over the network and
    // re-parses chapters out of THAT, instead of the live page's
    // (untrustworthy — see pageData.ytInitialDataVideoId's check below)
    // ytInitialData. Correct by construction: scoped to `videoId` by the
    // URL itself, not dependent on any shared page-global state that may
    // or may not describe the video actually being initialized.
    //
    // Ground-truth finding (live debug log, Aug 2026): a video with neither
    // chapters nor a heatmap kept showing the *previous* video's chapters
    // after navigating to it in the same tab — the chapter start times
    // matched exactly, even ~600ms after playerResponse, duration, and the
    // <video> element itself had all already moved on to the new video.
    // Root cause: pageBridge.js's `getYtInitialData()` reads
    // `window.ytInitialData`, which YouTube's own client-side navigation
    // never reassigns — it's set once, at the very first full page load,
    // and simply never updates again for the lifetime of the tab. Unlike
    // playerResponse (see PAGE_DATA_FRESHNESS_BUDGET_MS above), there is no
    // "retry until it catches up" fix here — it can't catch up. Confirmed
    // against real fetched YouTube HTML during development: same technique
    // (and same `currentVideoEndpoint.watchEndpoint.videoId` field) used by
    // other established YouTube-chapter-reading extensions.
    async function fetchFreshChapters() {
      try {
        var controllerAbort = new AbortController();
        var timer = setTimeout(function () { controllerAbort.abort(); }, FRESH_CHAPTERS_FETCH_TIMEOUT_MS);
        var res = await fetch("https://www.youtube.com/watch?v=" + encodeURIComponent(videoId), {
          signal: controllerAbort.signal,
        });
        clearTimeout(timer);
        if (myToken !== initToken) return [];
        if (!res || !res.ok) {
          debugLog("fresh chapters fetch failed — HTTP", res && res.status);
          return [];
        }
        var html = await res.text();
        if (myToken !== initToken) return [];
        var freshYtInitialData = ExtractYtInitialData.extractYtInitialData(html);
        var chapters = ChapterStrategy.parseChapters(
          { ytInitialData: freshYtInitialData, playerResponse: pageData && pageData.playerResponse },
          duration
        );
        debugLog("fresh chapters fetched for", videoId, "— count:", chapters.length);
        return chapters;
      } catch (err) {
        debugLog("fresh chapters fetch failed:", err && err.message);
        return [];
      }
    }

    // Ground-truth finding (live debug log, Aug 2026): `.ytp-heat-map-container`
    // reliably appears in the DOM almost immediately, but as an EMPTY shell —
    // YouTube populates the actual `<path d="...">` curve data inside it
    // asynchronously, observed taking a few seconds longer. A version of this
    // loop that only waited for the *container* to exist (once, or via a
    // single fixed retry) was racy: it sometimes won and sometimes didn't,
    // depending on exactly how long that inner population happened to take.
    // Fixed by polling `fetchRawSignals` directly (the same trusted parsing
    // logic used everywhere else) on a short interval, rather than trying to
    // catch the exact DOM mutation that fills in the path — deliberately
    // sidesteps needing to know *how* YouTube updates that node (setting an
    // attribute in place vs. replacing it), since `waitForElement`'s
    // MutationObserver only watches for nodes being added/removed, not
    // attribute changes, and could otherwise miss it.
    async function pollForHeatmap(initialSamples) {
      if (initialSamples.length > 0) return initialSamples;
      try {
        await VideoWatcher.waitForElement(".ytp-heat-map-container", { timeout: 4000 });
        debugLog("heat-map container appeared");
      } catch (_err) {
        debugLog("heat-map container not found within 4000ms");
      }
      if (myToken !== initToken) return initialSamples;

      var samples = initialSamples;
      var elapsed = 0;
      while (elapsed <= HEATMAP_POLL_BUDGET_MS) {
        if (myToken !== initToken) return samples;
        samples = DetectionManager.fetchRawSignals(pageData, duration).heatmapSamples;
        debugLog("heatmap poll — heatmapSamples:", samples.length, "elapsed:", elapsed + "ms");
        if (samples.length > 0) break;
        if (elapsed >= HEATMAP_POLL_BUDGET_MS) break;
        await delay(HEATMAP_POLL_INTERVAL_MS);
        elapsed += HEATMAP_POLL_INTERVAL_MS;
      }
      return samples;
    }

    // Second entry point for the same toggle, living in YouTube's own
    // control bar. Best-effort — a short wait in case that cluster
    // renders late, same as the heatmap SVG; if it never appears, this
    // silently does nothing rather than breaking anything else. Deferred
    // until reveal() (not attempted for a still-pending panel) since
    // there's nothing meaningful to toggle until then — mirrors the
    // panel's own toggle staying disabled until reveal.
    var nativeButton = null;
    function maybeMountNativeButton(signals) {
      if (nativeButton) return;
      if (!(signals.heatmapSamples.length > 0 || signals.chapters.length > 0)) return;
      (async function mountNativeButton() {
        try {
          await VideoWatcher.waitForElement(".ytp-right-controls", { timeout: 4000 });
        } catch (_err) {
          debugLog("native control-bar right-controls cluster not found — skipping native toggle button");
          return;
        }
        if (myToken !== initToken) return;
        nativeButton = NativeToggleButton.mount({ enabled: highlightsEnabled, onToggle: setHighlightsEnabled });
        debugLog("native toggle button mounted:", !!nativeButton);
        if (nativeButton) teardownFns.push(function () { nativeButton.destroy(); });
      })();
    }

    // ---- Chapters: normally known for certain on the very first check —
    // straight out of pageData, already fetched in full above, no DOM wait
    // needed. EXCEPT right after a same-tab SPA navigation to a second+
    // video: pageData.ytInitialData's one real source (window.ytInitialData
    // — see chapterStrategy.js / fetchFreshChapters above) is a load-once
    // global that never gets reassigned, so it can describe the *previous*
    // video instead. pageData.ytInitialDataVideoId (set by pageBridge.js)
    // catches this: if it doesn't match the video actually being
    // initialized, pageData.ytInitialData isn't just "not yet fresh" —
    // retrying wouldn't help, it never becomes fresh — so it's not used for
    // chapters at all; fetchFreshChapters() re-fetches this exact video's
    // chapters over the network instead. ----
    var chaptersTrustworthy = !pageData || !pageData.ytInitialDataVideoId || pageData.ytInitialDataVideoId === videoId;
    if (!chaptersTrustworthy) {
      debugLog("ytInitialData stale — expected", videoId, "got", pageData.ytInitialDataVideoId, "— fetching chapters fresh over the network instead");
    }

    var initial = DetectionManager.fetchRawSignals(pageData, duration);
    if (!chaptersTrustworthy) initial.chapters = []; // never show even one frame of the wrong video's chapters
    debugLog("initial detection — heatmapSamples:", initial.heatmapSamples.length, "chapters:", initial.chapters.length);
    if (myToken !== initToken) return;

    if (chaptersTrustworthy) {
      // ---- Common path (unchanged): chapters are known for certain right
      // now, so reveal immediately if there's anything to show; the
      // heatmap (which always needs the DOM poll below) keeps going in the
      // background regardless, upgrading the panel if/when it lands. ----
      if (initial.chapters.length > 0 || initial.heatmapSamples.length > 0) {
        reveal(initial);
      }
      if (initial.heatmapSamples.length > 0) return;

      var heatmapSamples = await pollForHeatmap(initial.heatmapSamples);
      if (myToken !== initToken) return;

      if (heatmapSamples.length > 0) {
        if (!revealed) {
          reveal({ heatmapSamples: heatmapSamples, chapters: initial.chapters });
        } else {
          // Chapters were already showing — reveal the tab switcher rather
          // than a second reveal. upgradeToHeatmap decides for itself
          // whether to auto-switch to Highlights or just surface a "new"
          // indicator, depending on whether the viewer already interacted
          // with the chapters view.
          currentSignals = { heatmapSamples: heatmapSamples, chapters: currentSignals.chapters };
          panelApi.upgradeToHeatmap(heatmapSamples, duration);
          applyRanges();
        }
      } else if (!revealed) {
        // Neither chapters nor a heatmap ever showed up — the existing
        // empty state, just reached through reveal() like everything else.
        reveal({ heatmapSamples: [], chapters: initial.chapters });
      }
      // else: chapters were already the final view and the heatmap never
      // arrived — no change needed, chapters stays.
    } else {
      // ---- Post-navigation, chapters-untrustworthy path: nothing is known
      // for certain yet, so there's no early reveal here — both the fresh
      // chapters fetch and the heatmap poll are kicked off together and run
      // in parallel (the fetch starts now, before awaiting the poll below,
      // so it isn't stacked behind it), and whatever's true of both once
      // they've settled is what gets revealed. Bounded at
      // max(FRESH_CHAPTERS_FETCH_TIMEOUT_MS, HEATMAP_POLL_BUDGET_MS) — both
      // currently 4s — not their sum. ----
      var chaptersFetchPromise = fetchFreshChapters();
      var polledHeatmapSamples = await pollForHeatmap(initial.heatmapSamples);
      if (myToken !== initToken) return;
      var freshChapters = await chaptersFetchPromise;
      if (myToken !== initToken) return;
      reveal({ heatmapSamples: polledHeatmapSamples, chapters: freshChapters });
    }
  }

  var unsubscribeNav = VideoWatcher.onNavigate(function (videoId) {
    init(videoId);
  });

  init(VideoWatcher.getCurrentVideoId());

  window.addEventListener("pagehide", function () {
    teardown();
    unsubscribeNav();
  });
})();
