/**
 * deepFind — bounded, cycle-safe object-graph search.
 *
 * YouTube's internal data structures (ytInitialData, player responses, etc.)
 * are unstable: field names and nesting change without notice. Rather than
 * hardcoding brittle paths everywhere, detection strategies use this to
 * search for nodes matching a shape predicate, wherever they happen to live.
 *
 * Bounded by maxDepth/maxNodes and guarded against cycles so a malformed or
 * unexpectedly huge object can never hang or crash the content script.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (typeof root !== "undefined") {
    root.YHP = root.YHP || {};
    root.YHP.DeepFind = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  /**
   * @param {*} rootNode - object/array to search (search is a no-op for primitives)
   * @param {(node: object) => boolean} predicate - called with every object/array node visited
   * @param {{maxDepth?: number, maxNodes?: number}} [options]
   * @returns {object[]} every node for which predicate returned true
   */
  function deepFind(rootNode, predicate, options) {
    var maxDepth = (options && options.maxDepth) || 14;
    var maxNodes = (options && options.maxNodes) || 25000;

    var results = [];
    if (!rootNode || typeof rootNode !== "object") return results;
    if (typeof predicate !== "function") return results;

    var seen = typeof WeakSet !== "undefined" ? new WeakSet() : null;
    var stack = [{ node: rootNode, depth: 0 }];
    var visited = 0;

    while (stack.length && visited < maxNodes) {
      var entry = stack.pop();
      var node = entry.node;
      var depth = entry.depth;
      visited += 1;

      if (!node || typeof node !== "object") continue;
      if (seen) {
        if (seen.has(node)) continue;
        seen.add(node);
      }

      try {
        if (predicate(node)) {
          results.push(node);
        }
      } catch (_err) {
        // A malformed node shouldn't abort the whole search.
      }

      if (depth >= maxDepth) continue;

      var childKeys = Array.isArray(node) ? null : Object.keys(node);
      var childCount = Array.isArray(node) ? node.length : childKeys.length;

      for (var i = 0; i < childCount; i += 1) {
        var child;
        try {
          child = Array.isArray(node) ? node[i] : node[childKeys[i]];
        } catch (_readErr) {
          // A getter that throws (or a hostile proxy) shouldn't abort the search.
          continue;
        }
        if (child && typeof child === "object") {
          stack.push({ node: child, depth: depth + 1 });
        }
      }
    }

    return results;
  }

  return { deepFind: deepFind };
});
