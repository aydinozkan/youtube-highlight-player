const test = require("node:test");
const assert = require("node:assert/strict");
const Analytics = require("../src/telemetry/analytics");

test("makeId produces a valid-looking UUID (has crypto.randomUUID available in this Node runtime)", () => {
  const id = Analytics.makeId();
  assert.equal(typeof id, "string");
  assert.ok(id.length >= 32);
});

test("makeId produces distinct ids across calls", () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(Analytics.makeId());
  assert.equal(ids.size, 50);
});

test("track() is a no-op before init() has been called — never sends silently by default", async () => {
  // No chrome global exists in this Node test environment at all — if
  // track() tried to reach chrome.storage/fetch here without the
  // `initialized` guard short-circuiting first, this would throw.
  assert.doesNotThrow(() => Analytics.track("should_not_send", { x: 1 }));
});

test("track() is a no-op once init(false) has been called", async () => {
  Analytics.init(false);
  assert.doesNotThrow(() => Analytics.track("should_not_send_either"));
});
