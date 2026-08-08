const test = require("node:test");
const assert = require("node:assert/strict");
const ErrorReporter = require("../src/telemetry/errorReporter");

test("parseDsn extracts key, host, and project id from a real-shaped DSN", () => {
  const parsed = ErrorReporter.parseDsn(
    "https://b7d162e9393cf44a0f14dc40b58c75e4@o4511870240620544.ingest.de.sentry.io/4511870254252112"
  );
  assert.deepEqual(parsed, {
    key: "b7d162e9393cf44a0f14dc40b58c75e4",
    host: "o4511870240620544.ingest.de.sentry.io",
    projectId: "4511870254252112",
  });
});

test("parseDsn returns null for a malformed DSN", () => {
  assert.equal(ErrorReporter.parseDsn("not-a-dsn"), null);
  assert.equal(ErrorReporter.parseDsn(""), null);
  assert.equal(ErrorReporter.parseDsn(null), null);
  assert.equal(ErrorReporter.parseDsn("https://missing-project-id@host.sentry.io/"), null);
});

test("scrubText redacts youtube.com URLs", () => {
  const text = "failed while fetching https://www.youtube.com/watch?v=abcDEF12345 for details";
  assert.equal(
    ErrorReporter.scrubText(text),
    "failed while fetching [youtube-url] for details"
  );
});

test("scrubText redacts alphanumeric 11-char tokens (video-id shaped) but leaves plain words alone", () => {
  // "dQw4w9WgXcQ" is a real, video-id-shaped token: mixed letters+digits, 11 chars.
  assert.equal(ErrorReporter.scrubText("videoId dQw4w9WgXcQ not found"), "videoId [id] not found");
  // An 11-letter plain English word should NOT be treated as a video id.
  assert.equal(ErrorReporter.scrubText("the word extraordinary appears here"), "the word extraordinary appears here");
});

test("scrubText passes through non-string input unchanged", () => {
  assert.equal(ErrorReporter.scrubText(null), null);
  assert.equal(ErrorReporter.scrubText(undefined), undefined);
  assert.equal(ErrorReporter.scrubText(42), 42);
});

test("extractFirstFrame prefers the second stack line (first real frame, skipping the message line)", () => {
  const stack = "TypeError: boom\n    at reveal (content.js:354:10)\n    at init (content.js:126:5)";
  assert.equal(ErrorReporter.extractFirstFrame(stack), "at reveal (content.js:354:10)");
});

test("extractFirstFrame falls back to the only line when there's no second one", () => {
  assert.equal(ErrorReporter.extractFirstFrame("just one line"), "just one line");
});

test("extractFirstFrame returns '' for empty/non-string input", () => {
  assert.equal(ErrorReporter.extractFirstFrame(""), "");
  assert.equal(ErrorReporter.extractFirstFrame(null), "");
  assert.equal(ErrorReporter.extractFirstFrame(undefined), "");
});

test("parseStackFrames caps at 15 frames and scrubs each one", () => {
  const lines = [];
  for (let i = 0; i < 20; i += 1) lines.push("    at fn" + i + " (content.js:" + i + ":1)");
  const frames = ErrorReporter.parseStackFrames(lines.join("\n"));
  assert.equal(frames.length, 15);
  assert.equal(frames[0].function, "at fn0 (content.js:0:1)");
});

test("parseStackFrames scrubs a youtube URL embedded in a stack line", () => {
  const stack = "    at fetchFreshChapters (content.js:410:5) https://www.youtube.com/watch?v=abcDEF12345";
  const frames = ErrorReporter.parseStackFrames(stack);
  assert.ok(frames[0].function.includes("[youtube-url]"));
  assert.ok(!frames[0].function.includes("watch?v="));
});

test("parseStackFrames returns [] for empty/non-string input", () => {
  assert.deepEqual(ErrorReporter.parseStackFrames(""), []);
  assert.deepEqual(ErrorReporter.parseStackFrames(null), []);
});

test("makeEventId produces a 32-char lowercase hex string", () => {
  const id = ErrorReporter.makeEventId();
  assert.equal(id.length, 32);
  assert.match(id, /^[0-9a-f]{32}$/);
});

test("makeEventId produces distinct ids across calls", () => {
  const ids = new Set();
  for (let i = 0; i < 50; i += 1) ids.add(ErrorReporter.makeEventId());
  assert.equal(ids.size, 50);
});
