/**
 * skipIndicator — a transient "+N ›" overlay centered on the video player
 * (not the panel), shown for about a second whenever playerController
 * performs an automatic skip. Deliberately mirrors YouTube's own
 * double-tap seek indicator (big plain number + a forward chevron,
 * centered, no background box) rather than a small corner badge — same
 * idea (you skipped forward N seconds), same place viewers already expect
 * to see it.
 *
 * DOM-only; the decision of *when* to call show() (which seek reasons
 * count as a "skip" worth flagging) lives in content.js, matching this
 * project's pattern of keeping UI modules dumb renderers.
 */
(function (root) {
  "use strict";

  var HOLD_MS = 1000;
  var SVG_NS = "http://www.w3.org/2000/svg";

  function buildChevron() {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "yhp-skip-indicator-icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    var path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", "M8 5 L16 12 L8 19");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "3");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  /**
   * Mounts the (initially hidden) indicator into `playerRoot` and returns
   * `{ show(seconds), destroy() }`. `playerRoot` should be positioned
   * (YouTube's `#movie_player` already is) so it can center within it.
   */
  function mount(playerRoot) {
    var el = document.createElement("div");
    el.className = "yhp-skip-indicator";
    el.setAttribute("aria-live", "polite");

    var text = document.createElement("span");
    text.className = "yhp-skip-indicator-text";
    el.appendChild(text);
    el.appendChild(buildChevron());

    playerRoot.appendChild(el);

    var hideTimer = null;

    function show(seconds) {
      var rounded = Math.round(seconds || 0);
      if (!(rounded > 0)) return;
      text.textContent = "+" + rounded;
      el.classList.add("yhp-skip-indicator--visible");
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(function () {
        el.classList.remove("yhp-skip-indicator--visible");
        hideTimer = null;
      }, HOLD_MS);
    }

    function destroy() {
      if (hideTimer) clearTimeout(hideTimer);
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    return { show: show, destroy: destroy };
  }

  var api = { mount: mount, HOLD_MS: HOLD_MS };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.SkipIndicator = api;
  }
})(typeof window !== "undefined" ? window : globalThis);
