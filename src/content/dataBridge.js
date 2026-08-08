/**
 * dataBridge — isolated-world counterpart to pageBridge.js.
 *
 * Sends a request over window.postMessage and resolves with whatever
 * pageBridge.js hands back (or null on error/timeout — the timeout matters
 * because pageBridge.js might not have loaded yet, or a future Chrome/
 * YouTube change could break "world": "MAIN" delivery entirely; callers
 * must be able to treat "no data" as a normal, non-fatal outcome and fall
 * through to the chapter strategy / "no data" UI state).
 */
(function (root) {
  "use strict";

  var NAMESPACE = "YHP";
  var REQUEST_TYPE = "YHP_REQUEST_PAGE_DATA";
  var RESPONSE_TYPE = "YHP_PAGE_DATA_RESPONSE";
  var DEFAULT_TIMEOUT_MS = 2500;

  function requestPageData(timeoutMs) {
    var timeout = typeof timeoutMs === "number" ? timeoutMs : DEFAULT_TIMEOUT_MS;

    return new Promise(function (resolve) {
      var requestId = Date.now() + "-" + Math.random().toString(36).slice(2);
      var settled = false;

      function cleanup() {
        window.removeEventListener("message", onMessage);
        clearTimeout(timer);
      }

      function onMessage(event) {
        if (event.source !== window) return;
        var msg = event.data;
        if (!msg || msg.namespace !== NAMESPACE || msg.type !== RESPONSE_TYPE) return;
        if (msg.requestId !== requestId || settled) return;
        settled = true;
        cleanup();
        resolve(msg.error ? null : msg.payload);
      }

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(null);
      }, timeout);

      window.addEventListener("message", onMessage);
      window.postMessage({ namespace: NAMESPACE, type: REQUEST_TYPE, requestId: requestId }, "*");
    });
  }

  root.YHP = root.YHP || {};
  root.YHP.DataBridge = { requestPageData: requestPageData };
})(typeof window !== "undefined" ? window : globalThis);
