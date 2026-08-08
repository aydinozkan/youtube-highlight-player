/**
 * panel — the control panel UI mounted next to the YouTube player.
 *
 * Glassmorphic HUD redesign: circular play/pause badge (synced to the
 * real video, not just decorative), prev/next-highlight chevrons, a
 * violet->magenta timeline with a live draggable playhead and an
 * active-segment glow, and a compact stat footer (highlight-index pill +
 * time-saved chip) in place of the old plain status text. Collapses to a
 * small pill on click (not full corner-drag positioning — a deliberately
 * lighter v1; see README).
 *
 * Owns all UI-local state (which chapters are checked, whether highlight
 * mode is toggled on, collapsed/expanded, which of the two content views
 * is currently active when a video has both, the last-known playing/
 * active-index state used to paint the timeline's live bits cheaply) and
 * renders it. It does NOT talk to the video, chrome.storage, or the
 * detection strategies directly — it reports user actions upward through a
 * single `onChange` callback and lets content.js (the orchestrator) decide
 * what to do about them (play/pause the real video, jump ranges, persist
 * settings). That keeps this file swappable/testable independent of the
 * rest of the extension.
 *
 * Mode and highlight amount are intentionally not user-configurable: always
 * "most replayed", always the top 30% — see FIXED_MODE/FIXED_PERCENTAGE.
 * No settings (gear) affordance exists for the same reason — there's
 * nothing behind it to configure right now.
 *
 * Loading: `mount()` always starts in a pending state — the full, real,
 * interactive shell (nav arrows, play badge, title, toggle, collapse
 * icon, footer) renders immediately, with a neutral shimmer skeleton
 * filling the content area below it, independent of whether anything is
 * known yet about this video's highlights/chapters. `revealSignals()` is
 * the one way out of pending, called by content.js exactly once, whenever
 * it first has something to show — real data, or a confirmed "neither
 * exists" after giving up. An earlier version built a separate, reduced
 * placeholder element in content.js and swapped the whole panel out once
 * detection finished; that meant the *real* header didn't appear until
 * detection did either, defeating the point of showing anything early.
 *
 * Highlights + chapters together: `signals` is `{heatmapSamples, chapters}`
 * — both are independent facts about the video (see detectionManager.js),
 * not an exclusive `source`. When a video has both, a small tab switcher
 * replaces the plain "Chapters" label and swaps visibility between the
 * existing timeline and chapter-list elements — neither is ever rebuilt,
 * only shown/hidden. `signals.chapters` is fully known the moment
 * `revealSignals` is called (parsed synchronously from already-fetched
 * page data — see content.js), so there's no "chapters arrive later" case
 * to support. The heatmap can genuinely arrive after that, though (it
 * needs a DOM element YouTube populates asynchronously) — `upgradeToHeatmap`
 * is the API for that: reveals the tab switcher if it didn't already
 * exist, and auto-switches to the Highlights tab UNLESS the viewer has
 * already interacted with the chapters view (checked/unchecked something,
 * played, navigated, or clicked a chapter to seek) — in which case it just
 * surfaces a small "new" indicator on the Highlights tab instead of
 * yanking away something actively in use.
 *
 * Security note: chapter titles and other YouTube-supplied strings are
 * always inserted with `textContent`, never `innerHTML` — they're arbitrary
 * creator-controlled text, not trusted markup.
 */
(function (root) {
  "use strict";

  // Mode/amount are fixed rather than user-configurable: always "most
  // replayed", always the top 30% of the heatmap's score.
  var FIXED_MODE = "most-replayed";
  var FIXED_PERCENTAGE = 0.3;
  var MAX_PROGRESS_DOTS = 12; // beyond this many highlights, dots get too cramped — fall back to text only

  var SVG_NS = "http://www.w3.org/2000/svg";

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (key === "className") el.className = attrs[key];
        else if (key === "text") el.textContent = attrs[key];
        else if (key.indexOf("on") === 0 && typeof attrs[key] === "function") {
          el.addEventListener(key.slice(2).toLowerCase(), attrs[key]);
        } else {
          el.setAttribute(key, attrs[key]);
        }
      });
    }
    (children || []).forEach(function (child) {
      if (child) el.appendChild(child);
    });
    return el;
  }

  function svg(tag, attrs, children) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    }
    (children || []).forEach(function (child) { if (child) el.appendChild(child); });
    return el;
  }

  function formatTime(totalSeconds) {
    var seconds = Math.max(0, Math.round(totalSeconds || 0));
    var h_ = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    var mm = h_ > 0 ? String(m).padStart(2, "0") : String(m);
    var ss = String(s).padStart(2, "0");
    return h_ > 0 ? h_ + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  // ---- Small inline icons (avoid an icon-font/sprite dependency) --------

  function iconPlay() {
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-icon" }, [
      svg("path", { d: "M8 5.5 V18.5 L18 12 Z", fill: "currentColor" }),
    ]);
  }
  function iconPause() {
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-icon" }, [
      svg("rect", { x: "7", y: "5.5", width: "3.5", height: "13", rx: "1", fill: "currentColor" }),
      svg("rect", { x: "13.5", y: "5.5", width: "3.5", height: "13", rx: "1", fill: "currentColor" }),
    ]);
  }
  function iconChevron(direction) {
    var d = direction === "left" ? "M15 5 L8 12 L15 19" : "M9 5 L16 12 L9 19";
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-icon" }, [
      svg("path", { d: d, fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ]);
  }
  function iconMinimize() {
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-icon" }, [
      svg("path", { d: "M6 12 H18", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round" }),
    ]);
  }
  function iconExpand() {
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-icon" }, [
      svg("path", { d: "M6 9 L12 15 L18 9", fill: "none", stroke: "currentColor", "stroke-width": "2.5", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ]);
  }
  function iconClock() {
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-icon" }, [
      svg("circle", { cx: "12", cy: "12", r: "8.5", fill: "none", stroke: "currentColor", "stroke-width": "2" }),
      svg("path", { d: "M12 7.5 V12 L15.5 14", fill: "none", stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ]);
  }
  function iconCheck() {
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-chapter-checkbox-check" }, [
      svg("path", { d: "M5 12.5 L10 17.5 L19 7", fill: "none", stroke: "currentColor", "stroke-width": "2.75", "stroke-linecap": "round", "stroke-linejoin": "round" }),
    ]);
  }
  /** A small 4-point sparkle, marking the onboarding card as transient tip-style guidance rather than a permanent panel section. */
  function iconSparkle() {
    return svg("svg", { viewBox: "0 0 24 24", class: "yhp-icon yhp-onboarding-sparkle" }, [
      svg("path", { d: "M12 3 L13.8 9.2 L20 11 L13.8 12.8 L12 19 L10.2 12.8 L4 11 L10.2 9.2 Z", fill: "currentColor" }),
    ]);
  }

  /** A small circular progress ring; call .set(fraction) to update the arc. */
  function buildProgressRing(radius) {
    var r = radius || 9;
    var circumference = 2 * Math.PI * r;
    var track = svg("circle", { cx: "12", cy: "12", r: String(r), fill: "none", stroke: "currentColor", "stroke-opacity": "0.25", "stroke-width": "2.5" });
    var arc = svg("circle", {
      cx: "12", cy: "12", r: String(r), fill: "none", stroke: "currentColor", "stroke-width": "2.5",
      "stroke-linecap": "round", "stroke-dasharray": circumference.toFixed(2), "stroke-dashoffset": circumference.toFixed(2),
      transform: "rotate(-90 12 12)",
    });
    var el = svg("svg", { viewBox: "0 0 24 24", class: "yhp-progress-ring" }, [track, arc]);
    return {
      el: el,
      set: function (fraction) {
        var clamped = Math.min(1, Math.max(0, fraction || 0));
        arc.setAttribute("stroke-dashoffset", (circumference * (1 - clamped)).toFixed(2));
      },
    };
  }

  /** Three thin, varied-width shimmer lines — deliberately not shaped like a timeline or a chapter list (see revealSignals). */
  function buildSkeletonContent() {
    var content = h("div", { className: "yhp-skeleton-content", "aria-hidden": "true" });
    ["yhp-skeleton-bar--a", "yhp-skeleton-bar--b", "yhp-skeleton-bar--c"].forEach(function (modifier) {
      content.appendChild(h("div", { className: "yhp-skeleton-bar " + modifier }));
    });
    return content;
  }

  /**
   * @param {{
   *   settings: object,
   *   duration: number,
   *   onChange: (event: object) => void,
   * }} opts
   */
  function mount(opts) {
    var settings = Object.assign({}, opts.settings);
    var duration = opts.duration || 0;
    var onChange = opts.onChange || function () {};

    // Always starts pending — see file header comment. `signals` stays
    // this shape (mutated in place, never reassigned) so closures that
    // captured a reference to it — rerenderTimeline, updateActiveChapterRow
    // — keep seeing updates made by revealSignals/upgradeToHeatmap without
    // needing to be re-wired.
    var signals = { heatmapSamples: [], chapters: [] };
    var pending = true;
    var hasHeatmap = false;
    var hasChapters = false;
    // Which content view currently governs the toggle/nav/footer.
    var activeSource = "none";
    // Whether the viewer has done anything with the chapters view while it
    // was the (only) one showing — checked/unchecked a chapter, pressed
    // play/pause, navigated prev/next, toggled "Play Selection Only", or
    // clicked a chapter to seek. Read exactly once, by upgradeToHeatmap,
    // to decide whether it's safe to auto-switch to Highlights or whether
    // that would yank away something actively in use.
    var chaptersInteracted = false;
    function noteChaptersInteraction() {
      if (activeSource === "chapters") chaptersInteracted = true;
    }

    var selectedChapterIds = {};

    var els = {};
    var lastRanges = [];
    var lastActiveIndex = -1;
    var collapsed = !!settings.panelCollapsed;

    function emit(type, extra) {
      onChange(Object.assign({ type: type }, extra || {}));
    }

    // ---- Play/pause badge ------------------------------------------------
    var playIcon = iconPlay();
    var pauseIcon = iconPause();
    pauseIcon.style.display = "none";
    els.playBadge = h("button", {
      type: "button",
      className: "yhp-play-badge",
      "aria-label": "Play",
      onclick: function () { noteChaptersInteraction(); emit("playPause"); },
    }, [playIcon, pauseIcon]);

    function setPlaying(isPlaying) {
      playIcon.style.display = isPlaying ? "none" : "";
      pauseIcon.style.display = isPlaying ? "" : "none";
      els.playBadge.classList.toggle("yhp-play-badge--playing", !!isPlaying);
      els.playBadge.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    }

    // ---- Prev/next nav ------------------------------------------------------
    // What the arrows step through is whatever's actually on screen: chapters
    // when the chapters view is active, highlights otherwise. The seek
    // logic itself doesn't need a branch for this — content.js's controller
    // already jumps by whatever `ranges` currently holds, and `ranges` is
    // already chapter- or heatmap-derived per the active source — this only
    // needs to say the right word, which can change after mount (reveal,
    // tab switch, heatmap upgrade).
    var navPrev = h("button", {
      type: "button", className: "yhp-nav-btn",
      onclick: function () { noteChaptersInteraction(); emit("previous"); },
    }, [iconChevron("left")]);
    var navNext = h("button", {
      type: "button", className: "yhp-nav-btn",
      onclick: function () { noteChaptersInteraction(); emit("next"); },
    }, [iconChevron("right")]);
    function updateNavLabels() {
      var unit = activeSource === "chapters" ? "chapter" : "highlight";
      navPrev.setAttribute("aria-label", "Previous " + unit);
      navNext.setAttribute("aria-label", "Next " + unit);
    }
    updateNavLabels();

    // ---- Toggle -----------------------------------------------------------
    els.toggleInput = h("input", {
      type: "checkbox",
      className: "yhp-toggle-input",
      "aria-label": "Play selection only",
      onchange: function (e) {
        settings.highlightsEnabled = e.target.checked;
        emit("toggle", { enabled: e.target.checked });
        rerenderActiveView();
        acknowledgeOnboarding(); // interacting with the toggle is itself the taught action — counts as "got it"
        noteChaptersInteraction();
      },
    });
    els.toggleInput.checked = !!settings.highlightsEnabled;
    function updateToggleAvailability() {
      els.toggleInput.disabled = !hasHeatmap && !hasChapters;
    }
    updateToggleAvailability();

    var headerLeft = h("div", { className: "yhp-header-left" }, [
      navPrev,
      els.playBadge,
      navNext,
      h("span", { className: "yhp-title", text: "YouTube Highlight Player" }),
    ]);

    var minimizeBtn = h("button", {
      type: "button", className: "yhp-minimize-btn", "aria-label": "Collapse panel",
      onclick: function () { setCollapsed(!collapsed); },
    }, [iconMinimize()]);

    var toggleWrap = h("label", { className: "yhp-toggle" }, [
      els.toggleInput,
      h("span", { className: "yhp-toggle-track" }, [h("span", { className: "yhp-toggle-thumb" })]),
      h("span", { className: "yhp-toggle-label", text: "Play Selection Only" }),
    ]);

    var headerRight = h("div", { className: "yhp-header-right" }, [toggleWrap, minimizeBtn]);

    var header = h("div", { className: "yhp-header" }, [headerLeft, headerRight]);

    // ---- Chapter list (built the first time chapters exist) -------------
    // Each row is a checkbox (its own small hit target, toggles inclusion)
    // plus a separate "content" hit target spanning the rest of the row
    // (title + timestamp) that seeks there — deliberately two different
    // click targets on the same row rather than one label wrapping
    // everything, so clicking the title/time doesn't *also* toggle the
    // checkbox the way a native `<label>`-wraps-everything pattern would.
    var chapterRowEls = {}; // chapter id -> row <div>, for live active-chapter highlighting
    var lastActiveChapterId = null;

    function buildChapterRow(chapter) {
      var included = !!selectedChapterIds[chapter.id];

      var checkboxInput = h("input", {
        type: "checkbox",
        className: "yhp-chapter-checkbox-input",
        "aria-label": 'Include "' + chapter.title + '" in playback selection',
        onchange: function (e) {
          var checked = e.target.checked;
          selectedChapterIds[chapter.id] = checked;
          row.classList.toggle("yhp-chapter-item--excluded", !checked);
          noteChaptersInteraction();
          emit("chapterSelection");
        },
      });
      checkboxInput.checked = included;
      var checkboxBox = h("span", { className: "yhp-chapter-checkbox-box" }, [iconCheck()]);
      var checkboxLabel = h("label", { className: "yhp-chapter-checkbox" }, [checkboxInput, checkboxBox]);

      var titleSpan = document.createElement("span");
      titleSpan.className = "yhp-chapter-title";
      titleSpan.textContent = chapter.title; // creator-controlled text: textContent only
      var timeSpan = h("span", { className: "yhp-chapter-time", text: formatTime(chapter.startTime) });

      function seekHere() { noteChaptersInteraction(); emit("seek", { time: chapter.startTime }); }
      var content = h("div", {
        className: "yhp-chapter-content",
        tabindex: "0",
        role: "button",
        "aria-label": "Seek to " + chapter.title + " at " + formatTime(chapter.startTime),
        onclick: seekHere,
        onkeydown: function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); seekHere(); }
        },
      }, [titleSpan, timeSpan]);

      var row = h("div", {
        className: "yhp-chapter-item" + (included ? "" : " yhp-chapter-item--excluded"),
      }, [checkboxLabel, content]);
      chapterRowEls[chapter.id] = row;
      return row;
    }

    var chapterListEl = null;
    function ensureChapterListEl() {
      if (!chapterListEl && hasChapters) {
        chapterListEl = h("div", { className: "yhp-chapter-list" }, signals.chapters.map(buildChapterRow));
      }
    }

    // ---- Timeline (built the first time a heatmap exists) ---------------
    var timeStartLabel = null;
    var timeEndLabel = null;
    var timelineContainer = null;
    var timelineRowEl = null;
    function buildTimelineRowEl() {
      timeStartLabel = h("span", { className: "yhp-time-label", text: "0:00" });
      timeEndLabel = h("span", { className: "yhp-time-label", text: formatTime(duration) });
      timelineContainer = h("div", { className: "yhp-timeline" });
      return h("div", { className: "yhp-timeline-row" }, [timeStartLabel, timelineContainer, timeEndLabel]);
    }
    function ensureTimelineRowEl() {
      if (!timelineRowEl && hasHeatmap) timelineRowEl = buildTimelineRowEl();
    }

    // ---- Source tabs (only when both heatmap and chapters exist) --------
    // Replaces the plain "Chapters" section label. A compact segmented
    // control sized to its own text content — deliberately NOT stretched
    // to the panel's full width, so it reads as a small control sitting
    // under the header rather than a second header row of its own.
    var sourceTabs = null;
    var tabHighlightsBtn = null;
    var tabChaptersBtn = null;
    var highlightsNewBadge = null;
    var chaptersLabelEl = null; // the plain-label version, kept only so a later reveal can swap it out
    var contentSectionEl = null; // the "both" wrapper — label/tabs + whichever view(s)

    function updateTabsUI() {
      if (!sourceTabs) return;
      tabHighlightsBtn.classList.toggle("yhp-source-tab--active", activeSource === "heatmap");
      tabHighlightsBtn.setAttribute("aria-selected", activeSource === "heatmap" ? "true" : "false");
      tabChaptersBtn.classList.toggle("yhp-source-tab--active", activeSource === "chapters");
      tabChaptersBtn.setAttribute("aria-selected", activeSource === "chapters" ? "true" : "false");
    }

    function showHighlightsNewBadge() {
      if (highlightsNewBadge) highlightsNewBadge.style.display = "";
    }
    function clearHighlightsNewBadge() {
      if (highlightsNewBadge) highlightsNewBadge.style.display = "none";
    }

    function switchToSource(nextSource) {
      if (activeSource === nextSource || nextSource === "none") return;
      activeSource = nextSource;
      if (chapterListEl) chapterListEl.style.display = nextSource === "chapters" ? "" : "none";
      if (timelineRowEl) timelineRowEl.style.display = nextSource === "heatmap" ? "" : "none";
      if (nextSource === "heatmap") clearHighlightsNewBadge();
      // updateStatus only repaints the active-segment highlight when the
      // *index* changes — reset it here so switching sources always forces
      // a repaint on the next status update, even if the new source's
      // current index happens to numerically match whatever the old one
      // was (a real coincidence, not a hypothetical: e.g. both were "0").
      lastActiveIndex = -1;
      updateTabsUI();
      updateNavLabels();
      // Paints whatever view just became visible — necessary here (not just
      // left to content.js's applyRanges->updateRanges round trip) because
      // a view revealed via a *manual* tab click (as opposed to the
      // auto-upgrade path, which always gets a fresh applyRanges() right
      // after) may never have been painted with real ranges before now.
      rerenderActiveView();
      emit("tabChange"); // no dedicated content.js handler needed — falls through to applyRanges(), same as chapterSelection
    }

    function buildSourceTabs() {
      tabHighlightsBtn = h("button", {
        type: "button", className: "yhp-source-tab", role: "tab",
        text: "Highlights",
        onclick: function () { switchToSource("heatmap"); },
      });
      highlightsNewBadge = h("span", { className: "yhp-source-tab-badge", "aria-hidden": "true" });
      highlightsNewBadge.style.display = "none";
      tabHighlightsBtn.appendChild(highlightsNewBadge);

      var chaptersLabelSpan = document.createElement("span");
      chaptersLabelSpan.textContent = "Chapters";
      tabChaptersBtn = h("button", {
        type: "button", className: "yhp-source-tab", role: "tab",
        onclick: function () { switchToSource("chapters"); },
      }, [chaptersLabelSpan]);

      var tabs = h("div", { className: "yhp-source-tabs", role: "tablist" }, [tabHighlightsBtn, tabChaptersBtn]);
      updateTabsUI();
      return tabs;
    }

    /**
     * Called by content.js once real heatmap data shows up after the panel
     * already revealed chapters alone (the heatmap needs a DOM element
     * YouTube populates asynchronously — see content.js's poll loop —
     * chapters don't, so this direction is the only one that's ever real).
     * No-op if a heatmap was already known (revealed with both already
     * present, or already upgraded once).
     */
    function upgradeToHeatmap(newHeatmapSamples, videoDuration) {
      if (hasHeatmap) return;
      if (typeof videoDuration === "number") duration = videoDuration;
      hasHeatmap = true;
      signals.heatmapSamples = newHeatmapSamples;
      ensureTimelineRowEl();

      if (!sourceTabs) {
        sourceTabs = buildSourceTabs();
        if (contentSectionEl) contentSectionEl.classList.add("yhp-section--tabs");
        if (chaptersLabelEl && chaptersLabelEl.parentNode) {
          chaptersLabelEl.parentNode.replaceChild(sourceTabs, chaptersLabelEl);
        } else if (contentSectionEl) {
          contentSectionEl.insertBefore(sourceTabs, contentSectionEl.firstChild);
        }
        if (contentSectionEl) contentSectionEl.appendChild(timelineRowEl);
      }

      if (chaptersInteracted) {
        // Don't yank away something actively in use — surface the option
        // instead of forcing it. Left unpainted for now (still hidden);
        // switchToSource paints it the moment it's actually revealed,
        // whenever the viewer gets to it manually.
        timelineRowEl.style.display = "none";
        showHighlightsNewBadge();
        updateTabsUI();
      } else {
        // switchToSource paints the newly-active timeline itself. content.js
        // always calls applyRanges() right after this returns, which repaints
        // it again with the real (not yet computed at this exact point)
        // heatmap ranges — a harmless one-frame redundancy, not a bug.
        switchToSource("heatmap");
      }
      updateToggleAvailability();
    }

    // ---- Content slot ------------------------------------------------------
    // One stable element the rest of the panel is built around — `display:
    // contents` in CSS means it doesn't affect layout at all (its children
    // behave as if they were direct children of its own parent), so
    // swapping what's inside it (skeleton -> real content) never changes
    // spacing/structure around it. Built once at the top level; everything
    // else (skeleton, empty state, chapters, timeline, tabs) is inserted
    // into or removed from it, never replaces it.
    var contentSlot = h("div", { className: "yhp-content-slot" });

    function buildContentNodes() {
      if (pending) return [buildSkeletonContent()];
      if (hasHeatmap && hasChapters) {
        sourceTabs = buildSourceTabs();
        chapterListEl.style.display = activeSource === "chapters" ? "" : "none";
        timelineRowEl.style.display = activeSource === "heatmap" ? "" : "none";
        contentSectionEl = h("div", { className: "yhp-section yhp-section--tabs" }, [sourceTabs, chapterListEl, timelineRowEl]);
        return [contentSectionEl];
      }
      if (hasChapters) {
        chaptersLabelEl = h("div", { className: "yhp-section-label", text: "Chapters" });
        contentSectionEl = h("div", { className: "yhp-section" }, [chaptersLabelEl, chapterListEl]);
        return [contentSectionEl];
      }
      if (hasHeatmap) return [timelineRowEl];
      return [h("div", { className: "yhp-empty-state" }, [
        h("span", {
          text: "No highlight data available for this video yet — no “most replayed” data or chapters were found.",
        }),
      ])];
    }

    function renderContent() {
      ensureChapterListEl();
      ensureTimelineRowEl();
      contentSlot.innerHTML = "";
      buildContentNodes().forEach(function (node) { if (node) contentSlot.appendChild(node); });
    }
    renderContent(); // initial paint: the skeleton, since `pending` starts true

    // ---- Footer: highlight pill + saved chip -------------------------------
    var dotsContainer = h("div", { className: "yhp-highlight-dots" });
    var pillLabel = h("span", { className: "yhp-highlight-pill-label", text: "" });
    var highlightPill = h("div", { className: "yhp-highlight-pill" }, [pillLabel, dotsContainer]);

    var ring = buildProgressRing(9);
    var savedText = h("span", { className: "yhp-saved-text", text: "" });
    var savedChip = h("div", { className: "yhp-saved-chip" }, [ring.el, iconClock(), savedText]);

    var plainStatus = h("div", { className: "yhp-status", text: "Highlights off" });

    // "No data" footer: replaces plainStatus (not alongside it — showing
    // both would just repeat the empty-state message above in shorter
    // form). "No data *yet*" specifically implies YouTube's own "most
    // replayed" data may simply not have populated for a new upload, so
    // the actionable option is a retry, not a second copy of the same
    // sentence; "Dismiss" is the honest alternative for "there's genuinely
    // nothing to wait for" — it collapses the panel out of the way the
    // same as the header's own minimize button, since there's no
    // timeline/chapters to interact with for this video anyway. Only ever
    // shown once detection has actually given up (`!pending`) — never
    // while still genuinely loading, see updateStatus.
    var checkAgainBtn = h("button", {
      type: "button",
      className: "yhp-status-action yhp-status-action--primary",
      text: "Check again",
      onclick: function () { emit("retryDetection"); },
    });
    var dismissBtn = h("button", {
      type: "button",
      className: "yhp-status-action",
      text: "Dismiss",
      onclick: function () { setCollapsed(true); },
    });
    var noDataActions = h("div", { className: "yhp-status-actions" }, [checkAgainBtn, dismissBtn]);

    var footer = h("div", { className: "yhp-footer" }, [plainStatus, noDataActions, highlightPill, savedChip]);

    // ---- Assemble ----------------------------------------------------------
    var panelRoot = h("div", {
      className: "yhp-panel yhp-panel--entering",
      "data-yhp-panel": "1",
      tabindex: "-1",
    }, [header, contentSlot, footer]);

    // Entrance animation: add the class after one frame so the transition
    // actually runs, then drop the marker once it's done.
    requestAnimationFrame(function () {
      panelRoot.classList.add("yhp-panel--visible");
      setTimeout(function () { panelRoot.classList.remove("yhp-panel--entering"); }, 260);
    });

    panelRoot.addEventListener("keydown", function (event) {
      var tag = event.target && event.target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (event.key === "ArrowLeft") { event.preventDefault(); emit("previous"); }
      else if (event.key === "ArrowRight") { event.preventDefault(); emit("next"); }
    });

    function setCollapsed(next) {
      collapsed = next;
      panelRoot.classList.toggle("yhp-panel--collapsed", collapsed);
      minimizeBtn.innerHTML = "";
      minimizeBtn.appendChild(collapsed ? iconExpand() : iconMinimize());
      minimizeBtn.setAttribute("aria-label", collapsed ? "Expand panel" : "Collapse panel");
      emit("collapsedChange", { collapsed: collapsed });
    }
    if (collapsed) setCollapsed(true);

    // ---- First-run onboarding: spotlight + tip card ------------------------
    // highlightsEnabled defaults to true on a fresh install (see store.js /
    // background.js) specifically so the first video someone watches
    // actually demonstrates the extension, instead of behaving identically
    // to a plain YouTube video until they happen to notice a switch below
    // the player. This is the other half of that: it makes the (otherwise
    // silent) behavior change legible — what just happened, and how to turn
    // it off — so it never reads as an unexplained surprise.
    //
    // Reuses the existing DOM (adds a class to panelRoot + the toggle
    // track) rather than building a parallel toggle-lookalike inside the
    // card — the card only ever contains the tip copy and the dismiss
    // button, never a second toggle.
    //
    // Checked from revealSignals (and upgradeToHeatmap's own auto-switch,
    // via the same code path) rather than at raw mount time, since mount
    // always starts pending now — hasHeatmap is never true yet at that
    // point. Gated on hasHeatmap specifically: chapters mode starts with
    // every chapter checked, so turning the toggle on there doesn't skip
    // anything yet; promising "skipping to the best parts" would be false
    // for that case. introSeen only flips true once this has actually been
    // shown, so a chapters-only reveal doesn't burn the one-time onboarding
    // on a video where there'd be nothing to see it do. Persisted via the
    // same `Store` (chrome.storage.sync) every other setting here already
    // goes through — not a separate localStorage flag — so it survives
    // across tabs/devices the same way "Play Selection Only" itself does.
    var onboardingCard = null;
    function acknowledgeOnboarding() {
      if (!onboardingCard) return;
      panelRoot.classList.remove("yhp-panel--onboarding");
      if (onboardingCard.parentNode) onboardingCard.parentNode.removeChild(onboardingCard);
      onboardingCard = null;
      settings.introSeen = true;
      emit("introSeen");
    }
    function maybeShowOnboarding() {
      // Also requires highlightsEnabled to actually be true: introSeen is a
      // relatively new stored key, so it defaults to false (unset) even for
      // people who already had the extension installed before it existed —
      // but their highlightsEnabled is whatever they'd already left it at,
      // not necessarily the fresh-install default. Without this check, an
      // existing user who'd explicitly left the toggle off would see "Now
      // skipping to the best parts" while nothing was actually skipping.
      if (!(hasHeatmap && activeSource === "heatmap" && settings.highlightsEnabled && !settings.introSeen && !collapsed)) return;
      if (onboardingCard) return;
      panelRoot.classList.add("yhp-panel--onboarding");
      onboardingCard = h("div", { className: "yhp-onboarding-card", role: "status" }, [
        h("div", { className: "yhp-onboarding-card-header" }, [
          iconSparkle(),
          h("span", { className: "yhp-onboarding-card-title", text: "Tip" }),
        ]),
        h("p", {
          className: "yhp-onboarding-card-body",
          text: "Now skipping to the best parts — turn off anytime.",
        }),
        h("button", {
          type: "button",
          className: "yhp-onboarding-card-cta",
          text: "Got it",
          onclick: function () { acknowledgeOnboarding(); },
        }),
      ]);
      panelRoot.appendChild(onboardingCard);
    }
    // If onboarding never showed (already seen, no heatmap, toggle off, or
    // collapsed), acknowledgeOnboarding's own `if (!onboardingCard) return;`
    // guard already makes later calls to it (toggle interaction, the
    // native control-bar button) a safe no-op.

    function rerenderTimeline() {
      if (!timelineRowEl) return; // no heatmap curve to visualize (yet)
      root.YHP.RangeOverlay.renderPanelTimeline(timelineContainer, lastRanges, duration, signals.heatmapSamples,
        function (time) { noteChaptersInteraction(); emit("seek", { time: time }); },
        { restrictToRanges: !!settings.highlightsEnabled, activeIndex: lastActiveIndex });
    }

    /** Re-renders whichever view is currently active — cheaper than always repainting both, and the hidden one repaints for free the moment it's switched to (rerenderTimeline is called again on demand). */
    function rerenderActiveView() {
      if (activeSource === "heatmap") rerenderTimeline();
    }

    function rebuildDots(total) {
      dotsContainer.innerHTML = "";
      if (total <= 0 || total > MAX_PROGRESS_DOTS) return;
      for (var i = 0; i < total; i += 1) {
        dotsContainer.appendChild(h("span", { className: "yhp-dot" }));
      }
    }

    var lastDotsTotal = -1;

    // ---- Public API ----------------------------------------------------
    function updateStatus(status, reason) {
      var newIndex = status.active && !status.finished ? status.index : -1;
      if (newIndex !== lastActiveIndex) {
        lastActiveIndex = newIndex;
        if (activeSource === "heatmap") {
          root.YHP.RangeOverlay.updateActiveSegment(timelineContainer, lastRanges, duration, lastActiveIndex, signals.heatmapSamples);
        }
      }

      var showPill = activeSource !== "none" && status.active && status.total > 0;
      // Never while still genuinely loading (`pending`) — those actions
      // mean "detection has given up," which isn't true yet.
      var showNoDataActions = !showPill && !pending && !hasHeatmap && !hasChapters;
      plainStatus.style.display = showPill || showNoDataActions ? "none" : "";
      noDataActions.style.display = showNoDataActions ? "" : "none";
      highlightPill.style.display = showPill ? "" : "none";

      if (!showPill) {
        savedChip.style.display = "none";
        // Neither source available at all: no text here — noDataActions
        // (above) replaces it, instead of repeating the empty-state
        // message already shown in the content area.
        if (!showNoDataActions) {
          plainStatus.textContent = status.active ? "No segments selected" : "Highlights off";
        }
        return;
      }

      if (status.total !== lastDotsTotal) {
        lastDotsTotal = status.total;
        rebuildDots(status.total);
      }
      var dotEls = dotsContainer.children;
      for (var i = 0; i < dotEls.length; i += 1) {
        dotEls[i].classList.toggle("yhp-dot--active", i === status.index);
        dotEls[i].classList.toggle("yhp-dot--done", i < status.index);
      }
      pillLabel.textContent = status.finished
        ? "Finished"
        : activeSource === "chapters"
          ? "Chapter " + (status.index >= 0 ? status.index + 1 : "–") + " of " + status.total
          : "Highlight " + (status.index >= 0 ? status.index + 1 : "–") + "/" + status.total;

      var saved = typeof status.timeSaved === "number" ? status.timeSaved : 0;
      var savedPct = duration > 0 ? Math.round((saved / duration) * 100) : 0;
      if (saved > 0) {
        savedChip.style.display = "";
        savedText.textContent = "~" + formatTime(saved) + " saved (" + savedPct + "%)";
        ring.set(saved / (duration || 1));
      } else {
        savedChip.style.display = "none";
      }
    }

    function updateRanges(ranges, videoDuration) {
      lastRanges = ranges;
      duration = videoDuration;
      if (timeEndLabel) timeEndLabel.textContent = formatTime(duration);
      rerenderActiveView();
    }

    function updatePlayhead(currentTime) {
      if (activeSource === "heatmap") {
        root.YHP.RangeOverlay.updatePanelTimelinePlayhead(timelineContainer, currentTime, duration);
      } else if (activeSource === "chapters") {
        updateActiveChapterRow(currentTime);
      }
    }

    // Highlights whichever chapter's own [startTime, endTime) span contains
    // the real playhead — independent of which chapters are checked/
    // unchecked, and independent of playerController's own active-range
    // index (which only covers *selected* chapters). Reuses RangeOverlay's
    // own interval hit-test since a chapter is just another {startTime,
    // endTime} span. Runs on every timeupdate tick (like the heatmap
    // playhead above), so it stays correct as playback crosses boundaries
    // during ordinary manual watching, not just on click/nav.
    function updateActiveChapterRow(currentTime) {
      var active = root.YHP.RangeOverlay.findRangeAt(signals.chapters, currentTime);
      var activeId = active ? active.id : null;
      if (activeId === lastActiveChapterId) return;
      if (lastActiveChapterId !== null && chapterRowEls[lastActiveChapterId]) {
        chapterRowEls[lastActiveChapterId].classList.remove("yhp-chapter-item--active");
      }
      if (activeId !== null && chapterRowEls[activeId]) {
        chapterRowEls[activeId].classList.add("yhp-chapter-item--active");
      }
      lastActiveChapterId = activeId;
    }

    function getState() {
      return {
        mode: FIXED_MODE,
        percentage: FIXED_PERCENTAGE,
        paddingBefore: settings.paddingBefore,
        paddingAfter: settings.paddingAfter,
        mergeGap: settings.mergeGap,
        highlightsEnabled: settings.highlightsEnabled,
      };
    }

    /** Which view — 'heatmap' | 'chapters' | 'none' — the toggle/nav/footer currently key off. content.js's applyRanges() uses this instead of a fixed signals.source. */
    function getActiveSource() {
      return activeSource;
    }

    function getSelectedChapters() {
      return signals.chapters.filter(function (c) { return selectedChapterIds[c.id]; });
    }

    /**
     * The one way out of `pending`. Called by content.js exactly once,
     * whenever it first has anything to show — real chapters and/or a
     * heatmap, or a confirmed "neither" after giving up (pass empty
     * arrays for that case; it renders the same empty state as before).
     * No-op if called again (revealSignals only ever transitions pending
     * -> resolved once; a heatmap arriving *after* this goes through
     * upgradeToHeatmap instead).
     */
    function revealSignals(newSignals, videoDuration) {
      if (!pending) return;
      pending = false;
      if (typeof videoDuration === "number") duration = videoDuration;
      signals.heatmapSamples = newSignals.heatmapSamples || [];
      signals.chapters = newSignals.chapters || [];
      signals.chapters.forEach(function (c) { selectedChapterIds[c.id] = true; });
      hasHeatmap = signals.heatmapSamples.length > 0;
      hasChapters = signals.chapters.length > 0;
      activeSource = hasHeatmap ? "heatmap" : (hasChapters ? "chapters" : "none");

      updateToggleAvailability();
      updateNavLabels();
      renderContent();
      maybeShowOnboarding();
    }

    function setEnabled(enabled) {
      settings.highlightsEnabled = enabled;
      els.toggleInput.checked = enabled;
      rerenderActiveView();
      acknowledgeOnboarding(); // also reached via the native control-bar button — same "got it" signal
      noteChaptersInteraction();
    }

    function destroy() {
      if (panelRoot.parentNode) panelRoot.parentNode.removeChild(panelRoot);
    }

    // Establish a consistent initial footer state (hides the highlight
    // pill/saved chip, shows plain status text) through the same code path
    // real updates use, rather than duplicating that logic. Needed because
    // the real first updateStatus() call only arrives once playerController
    // activates — which never happens at all if highlightsEnabled starts
    // false (the default), leaving the pill/chip visible-but-empty forever
    // if this weren't here.
    updateStatus({ active: false, index: -1, total: 0, finished: false }, "init");

    return {
      root: panelRoot,
      updateStatus: updateStatus,
      updateRanges: updateRanges,
      updatePlayhead: updatePlayhead,
      setPlaying: setPlaying,
      getState: getState,
      getActiveSource: getActiveSource,
      getSelectedChapters: getSelectedChapters,
      setEnabled: setEnabled,
      revealSignals: revealSignals,
      upgradeToHeatmap: upgradeToHeatmap,
      destroy: destroy,
    };
  }

  root.YHP = root.YHP || {};
  root.YHP.Panel = { mount: mount };
})(typeof window !== "undefined" ? window : globalThis);
