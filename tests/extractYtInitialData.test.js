const test = require("node:test");
const assert = require("node:assert/strict");
const {
  extractYtInitialData,
  extractBalancedJson,
  currentVideoIdFrom,
  currentVideoIdFromText,
} = require("../src/utils/extractYtInitialData");

function wrapAsPage(assignment) {
  return "<html><head><script>" + assignment + "</script></head><body></body></html>";
}

test("extractYtInitialData parses a simple var-assignment blob", () => {
  const html = wrapAsPage('var ytInitialData = {"a":1,"b":{"c":2}};');
  assert.deepEqual(extractYtInitialData(html), { a: 1, b: { c: 2 } });
});

test("extractYtInitialData parses the window[\"ytInitialData\"] assignment style", () => {
  const html = wrapAsPage('window["ytInitialData"] = {"a":1};');
  assert.deepEqual(extractYtInitialData(html), { a: 1 });
});

test("extractYtInitialData is not fooled by a `};` occurring before the real end (nested object)", () => {
  // A naive non-greedy `/\{.+?\};/` would stop at the first "};" — the one
  // right after the nested `inner` object — well short of the real end.
  const html = wrapAsPage('var ytInitialData = {"inner":{"x":1},"after":"still here"};');
  const result = extractYtInitialData(html);
  assert.deepEqual(result, { inner: { x: 1 }, after: "still here" });
});

test("extractYtInitialData is not fooled by a literal \"};\" inside a string value", () => {
  const html = wrapAsPage('var ytInitialData = {"description":"code sample: foo(){};","ok":true};');
  const result = extractYtInitialData(html);
  assert.deepEqual(result, { description: "code sample: foo(){};", ok: true });
});

test("extractYtInitialData handles an escaped quote inside a string without losing brace tracking", () => {
  const html = wrapAsPage('var ytInitialData = {"title":"say \\"hi\\" {not a brace}","n":1};');
  const result = extractYtInitialData(html);
  assert.equal(result.title, 'say "hi" {not a brace}');
  assert.equal(result.n, 1);
});

test("extractYtInitialData returns null when no marker is present", () => {
  assert.equal(extractYtInitialData("<html><body>nothing here</body></html>"), null);
});

test("extractYtInitialData returns null on non-string input", () => {
  assert.equal(extractYtInitialData(null), null);
  assert.equal(extractYtInitialData(undefined), null);
  assert.equal(extractYtInitialData(42), null);
});

test("extractYtInitialData skips an unrelated earlier mention and finds the real assignment", () => {
  const html = wrapAsPage(
    '// see ytInitialData docs\nvar ytInitialData = {"real":true};'
  );
  assert.deepEqual(extractYtInitialData(html), { real: true });
});

test("extractBalancedJson returns null when the braces never balance", () => {
  assert.equal(extractBalancedJson('{"a":1,', 0), null);
});

test("currentVideoIdFrom reads the nested watchEndpoint.videoId", () => {
  const data = { currentVideoEndpoint: { watchEndpoint: { videoId: "abcdefghijk" } } };
  assert.equal(currentVideoIdFrom(data), "abcdefghijk");
});

test("currentVideoIdFrom returns null when the field is missing or malformed", () => {
  assert.equal(currentVideoIdFrom(null), null);
  assert.equal(currentVideoIdFrom({}), null);
  assert.equal(currentVideoIdFrom({ currentVideoEndpoint: {} }), null);
  assert.equal(currentVideoIdFrom({ currentVideoEndpoint: { watchEndpoint: { videoId: 123 } } }), null);
});

test("currentVideoIdFromText finds the id in raw (unparsed) JSON text", () => {
  const text = '{"other":"stuff","currentVideoEndpoint":{"clickTrackingParams":"xyz","commandMetadata":{"webCommandMetadata":{"url":"/watch?v=abcdefghijk"}},"watchEndpoint":{"videoId":"abcdefghijk"}}}';
  assert.equal(currentVideoIdFromText(text), "abcdefghijk");
});

test("currentVideoIdFromText returns null when currentVideoEndpoint is absent or the window is exceeded", () => {
  assert.equal(currentVideoIdFromText(null), null);
  assert.equal(currentVideoIdFromText('{"nothing":"relevant"}'), null);
  // videoId sits far past the scan window — deliberately not found rather
  // than risk matching some unrelated later videoId.
  const padding = "x".repeat(400);
  const text = '{"currentVideoEndpoint":{"padding":"' + padding + '","watchEndpoint":{"videoId":"abcdefghijk"}}}';
  assert.equal(currentVideoIdFromText(text), null);
});

// ---- Real-world fixtures (captured from live YouTube watch pages during
// development — see the extractYtInitialData.js header comment) -----------

test("extractYtInitialData + currentVideoIdFrom round-trip a real captured watch page", () => {
  // A trimmed-but-real slice: the actual currentVideoEndpoint block copied
  // verbatim from a live `curl`'d youtube.com/watch page, wrapped in a
  // minimal but structurally realistic ytInitialData shell.
  const real = wrapAsPage(
    'var ytInitialData = {"responseContext":{"serviceTrackingParams":[]},' +
    '"currentVideoEndpoint":{"clickTrackingParams":"CAAQg2ciEwj68PKV446WAxVOKlUIHfMaFWXKAQTl5ek9",' +
    '"commandMetadata":{"webCommandMetadata":{"url":"/watch?v=dQw4w9WgXcQ","webPageType":"WEB_PAGE_TYPE_WATCH","rootVe":3832}},' +
    '"watchEndpoint":{"videoId":"dQw4w9WgXcQ"}},"trackingParams":"abc"};'
  );
  const data = extractYtInitialData(real);
  assert.ok(data);
  assert.equal(currentVideoIdFrom(data), "dQw4w9WgXcQ");
});
