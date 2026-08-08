/**
 * nativeToggleButton — injects a single button into YouTube's own
 * right-hand player control cluster (alongside CC / settings / theater /
 * fullscreen) that toggles "Play Selection Only". content.js is the single
 * source of truth for that state; this and the panel's own toggle are two
 * entry points into the same `setHighlightsEnabled()` call — mirrored,
 * never independent.
 *
 * VERIFIED AGAINST A LIVE PAGE (current "Delhi" player redesign). Real
 * structure, confirmed via a console diagnostic: `.ytp-right-controls` is
 * just an outer flex wrapper around two priority-managed sub-rows —
 * `.ytp-right-controls-left` (expand-chevron, autonav, CC, settings) and
 * `.ytp-right-controls-right` (theater, remote, fullscreen) — plus a
 * couple of top-level siblings (PiP) that render 0×0 when unsupported.
 * `.ytp-settings-button` etc. are grandchildren of `.ytp-right-controls`,
 * not direct children, which is exactly what broke the first version of
 * this file: it called `rightControls.insertBefore(button, ref)` with a
 * `ref` that wasn't `rightControls`'s own child, which throws
 * `NotFoundError` — silently swallowed by the try/catch below, so the
 * button just never appeared, no error surfaced. Fixed by inserting via
 * `ref.parentNode` instead. Every DOM read here is still wrapped so a
 * future YouTube markup change degrades to "the button doesn't appear"
 * rather than breaking anything else — same fail-gracefully posture as
 * heatmapStrategy.js.
 */
(function (root) {
  "use strict";

  // Ordered by how likely each is to still exist; first match wins.
  var RIGHT_CONTROLS_SELECTORS = [".ytp-right-controls"];

  // Landing the button immediately before one of these (rather than at
  // either end of the cluster) reads as part of YouTube's own control set
  // instead of bolted onto the edge. Tried in order; first hit wins.
  var INSERT_BEFORE_SELECTORS = [
    ".ytp-settings-button",
    ".ytp-size-button",
    ".ytp-miniplayer-button",
    ".ytp-fullscreen-button",
  ];

  var SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  /**
   * A simple 4-bar waveform glyph — ties visually to the panel's own
   * timeline rather than an unrelated icon vocabulary. Reads clearly at
   * small size since it's just straight rounded bars, no fine detail.
   */
  function buildIcon() {
    var icon = svgEl("svg", { height: "24", width: "24", viewBox: "0 0 24 24", class: "yhp-native-icon" });
    [
      { x: 4, y: 9, h: 6 },
      { x: 9.5, y: 5, h: 14 },
      { x: 15, y: 7, h: 10 },
      { x: 20, y: 10, h: 4 },
    ].forEach(function (bar) {
      icon.appendChild(svgEl("rect", {
        class: "yhp-native-icon-bar",
        x: String(bar.x), y: String(bar.y), width: "2.4", height: String(bar.h), rx: "1.2",
      }));
    });
    return icon;
  }

  function findRightControls() {
    for (var i = 0; i < RIGHT_CONTROLS_SELECTORS.length; i += 1) {
      var el = document.querySelector(RIGHT_CONTROLS_SELECTORS[i]);
      if (el) return el;
    }
    return null;
  }

  function findInsertionReference(rightControls) {
    for (var i = 0; i < INSERT_BEFORE_SELECTORS.length; i += 1) {
      var el = rightControls.querySelector(INSERT_BEFORE_SELECTORS[i]);
      if (el) return el;
    }
    return null; // caller appends at the end instead
  }

  /**
   * @param {{enabled: boolean, onToggle: (nextEnabled: boolean) => void}} opts
   * @returns {{setEnabled(enabled), destroy()} | null} null if the
   *   right-controls cluster couldn't be found this session — callers
   *   should treat that as "no native button today", not an error.
   */
  function mount(opts) {
    var rightControls;
    try {
      rightControls = findRightControls();
    } catch (_err) {
      rightControls = null;
    }
    if (!rightControls) return null;

    var enabled = !!(opts && opts.enabled);
    var onToggle = (opts && opts.onToggle) || function () {};

    var button = document.createElement("button");
    button.type = "button";
    // Reuses YouTube's own .ytp-button class for the 48px hit area and
    // circular hover/focus highlight — free, consistent styling, as long
    // as that class still means what it currently does.
    button.className = "ytp-button yhp-native-toggle-button";
    button.title = "Play Selection Only";
    button.setAttribute("aria-label", "Play Selection Only");
    button.setAttribute("aria-pressed", enabled ? "true" : "false");
    button.appendChild(buildIcon());

    button.addEventListener("click", function () {
      enabled = !enabled;
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      button.classList.toggle("yhp-native-toggle-button--active", enabled);
      onToggle(enabled);
    });
    button.classList.toggle("yhp-native-toggle-button--active", enabled);

    try {
      var ref = findInsertionReference(rightControls);
      // `ref` can be nested a level or two below `rightControls` (e.g. inside
      // a `.ytp-right-controls-left` sub-row on newer "Delhi" layouts) —
      // insertBefore() requires the reference node's *actual* parent, not
      // whatever ancestor we started searching from.
      if (ref) ref.parentNode.insertBefore(button, ref);
      else rightControls.appendChild(button);
    } catch (_err) {
      return null; // insertion failed — don't leave a half-mounted button around
    }

    function setEnabled(next) {
      enabled = !!next;
      button.setAttribute("aria-pressed", enabled ? "true" : "false");
      button.classList.toggle("yhp-native-toggle-button--active", enabled);
    }

    function destroy() {
      if (button.parentNode) button.parentNode.removeChild(button);
    }

    return { setEnabled: setEnabled, destroy: destroy };
  }

  root.YHP = root.YHP || {};
  root.YHP.NativeToggleButton = { mount: mount };
})(typeof window !== "undefined" ? window : globalThis);
