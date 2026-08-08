/**
 * errorReporter — minimal, dependency-free crash/error reporting.
 *
 * Sends genuinely unexpected errors (uncaught exceptions, unhandled promise
 * rejections) to Sentry's plain HTTP "store" ingest API directly — no SDK,
 * no build step, consistent with how the rest of this project is built.
 * Verified against a real Sentry project during development: the store
 * endpoint URL, the `X-Sentry-Auth` header format, CORS (a browser
 * `fetch()` with a JSON body triggers a preflight — confirmed Sentry's
 * ingest responds to it correctly), and the exception/stacktrace shape
 * were all confirmed working with real curl requests before this was
 * wired into the extension.
 *
 * Deliberately narrow in *what* it reports: YouTube's DOM/data being
 * unstable (missing heatmap container, no chapters, a bridge timeout) is
 * expected and already handled with graceful fallbacks throughout the
 * codebase (see detection/*.js, content.js's poll loops) — none of that
 * should ever reach here. This only catches things that indicate an
 * actual bug: uncaught exceptions and unhandled promise rejections, via
 * `installGlobalHandlers`, plus anything explicitly passed to `report()`.
 *
 * Privacy: never sends video IDs, titles, URLs, or any page content —
 * only the error's own message/stack, the extension version, and which
 * context (content script vs. background) it came from. `scrubText`
 * strips anything that looks like a YouTube video id or a youtube.com URL
 * from error text/stacks as a defensive second layer, in case an error
 * message ever happens to include one (none currently do).
 *
 * Loaded in two different JS worlds — a content script's `window` and the
 * background service worker's `self` — so this attaches to `self` rather
 * than `window` specifically; in a browser, `window === self` anyway, so
 * nothing changes for the content-script case.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.ErrorReporter = api;
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Public DSN for the YouTube Highlight Player Sentry project — a
  // write-only ingest key, safe to ship in client code (this is exactly
  // how Sentry's own official SDKs embed it; it can only submit events,
  // never read anything back).
  var DSN = "https://b7d162e9393cf44a0f14dc40b58c75e4@o4511870240620544.ingest.de.sentry.io/4511870254252112";
  var MAX_REPORTS_PER_SESSION = 10; // hard cap so one repeating bug can't blow through the free-tier quota
  var CLIENT_NAME = "yhp-error-reporter/1.0";
  var MAX_STACK_FRAMES = 15;

  var reportedFingerprints = {};
  var reportCount = 0;

  function parseDsn(dsn) {
    try {
      var match = /^https:\/\/([^@]+)@([^/]+)\/(.+)$/.exec(dsn);
      if (!match) return null;
      return { key: match[1], host: match[2], projectId: match[3] };
    } catch (_err) {
      return null;
    }
  }

  var parsedDsn = parseDsn(DSN);
  var STORE_URL = parsedDsn ? "https://" + parsedDsn.host + "/api/" + parsedDsn.projectId + "/store/" : null;

  function scrubText(text) {
    if (typeof text !== "string") return text;
    return text
      .replace(/https?:\/\/(www\.)?youtube\.com\S*/gi, "[youtube-url]")
      .replace(/\b[A-Za-z0-9_-]{11}\b/g, function (token) {
        // Only scrub tokens that plausibly look like a video id (a mix of
        // letters and digits) — avoids mangling ordinary 11-character
        // words/identifiers that show up in real stack traces.
        return /[0-9]/.test(token) && /[A-Za-z]/.test(token) ? "[id]" : token;
      });
  }

  function extractFirstFrame(stack) {
    if (typeof stack !== "string" || !stack) return "";
    var lines = stack.split("\n");
    return (lines[1] || lines[0] || "").trim().slice(0, 120);
  }

  function parseStackFrames(stack) {
    if (typeof stack !== "string" || !stack) return [];
    return stack.split("\n").slice(0, MAX_STACK_FRAMES).map(function (line) {
      return { function: scrubText(line.trim()) };
    });
  }

  function makeEventId() {
    // 32 lowercase hex chars, no dashes — Sentry's required event_id shape.
    var bytes = new Uint8Array(16);
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      crypto.getRandomValues(bytes);
    } else {
      for (var i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.prototype.map.call(bytes, function (b) {
      return (b < 16 ? "0" : "") + b.toString(16);
    }).join("");
  }

  function safeManifestVersion() {
    try {
      return chrome.runtime.getManifest().version;
    } catch (_err) {
      return "unknown";
    }
  }

  /**
   * @param {Error|{message?:string,stack?:string,name?:string}|*} error
   * @param {{context?: string, extra?: object}} [opts] - `context` names
   *   which part of the extension this came from (e.g. "content",
   *   "background"); `extra` is small, non-content debugging detail (e.g.
   *   {module:"content.js", phase:"init"}) — never video ids/titles/URLs.
   */
  function report(error, opts) {
    if (!STORE_URL) return; // malformed DSN — fail silently, never break the extension over telemetry
    if (reportCount >= MAX_REPORTS_PER_SESSION) return;

    var message = scrubText((error && error.message) || String(error) || "Unknown error");
    var type = (error && error.name) || "Error";
    var stack = scrubText((error && error.stack) || "");
    var firstFrame = extractFirstFrame(stack);

    var fingerprint = type + "|" + message.slice(0, 120) + "|" + firstFrame;
    if (reportedFingerprints[fingerprint]) return; // same error already reported once this session
    reportedFingerprints[fingerprint] = true;
    reportCount += 1;

    var options = opts || {};
    var manifestVersion = safeManifestVersion();

    var event = {
      event_id: makeEventId(),
      timestamp: new Date().toISOString(),
      platform: "javascript",
      level: "error",
      logger: "yhp",
      release: "youtube-highlight-player@" + manifestVersion,
      environment: "production",
      exception: {
        values: [{
          type: type,
          value: message,
          stacktrace: stack ? { frames: parseStackFrames(stack) } : undefined,
        }],
      },
      tags: {
        extension_version: manifestVersion,
        context: options.context || "unknown",
      },
      extra: options.extra || undefined,
    };

    try {
      fetch(STORE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Sentry-Auth": "Sentry sentry_version=7, sentry_key=" + parsedDsn.key + ", sentry_client=" + CLIENT_NAME,
        },
        body: JSON.stringify(event),
        keepalive: true, // lets the request survive a page/tab teardown mid-flight (e.g. a fast SPA navigation)
      }).catch(function () { /* best-effort — a failed report must never surface to the user */ });
    } catch (_err) {
      // fetch() itself can throw synchronously in rare cases; telemetry
      // failing must never be allowed to break the extension it's watching.
    }
  }

  /**
   * Installs `error`/`unhandledrejection` listeners on the given global —
   * content.js passes `window`, background.js passes `self` — catching
   * genuinely uncaught failures without needing to instrument every
   * try/catch in the codebase individually (most of which are deliberate,
   * expected fallbacks, not bugs — see file header). `context` tags which
   * JS world the listener is running in.
   */
  function installGlobalHandlers(target, context) {
    target.addEventListener("error", function (event) {
      report(event.error || { message: event.message, name: "Error" }, { context: context });
    });
    target.addEventListener("unhandledrejection", function (event) {
      var reason = event.reason;
      var err = reason instanceof Error ? reason : { message: String(reason), name: "UnhandledRejection" };
      report(err, { context: context });
    });
  }

  return {
    report: report,
    installGlobalHandlers: installGlobalHandlers,
    // Pure helpers, exposed mainly so they're directly unit-testable —
    // report() and installGlobalHandlers() above are the real public API.
    scrubText: scrubText,
    parseDsn: parseDsn,
    extractFirstFrame: extractFirstFrame,
    parseStackFrames: parseStackFrames,
    makeEventId: makeEventId,
  };
});
