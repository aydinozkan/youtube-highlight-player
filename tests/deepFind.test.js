const test = require("node:test");
const assert = require("node:assert/strict");
const { deepFind } = require("../src/utils/deepFind");

test("deepFind locates matching nodes at arbitrary depth", () => {
  const tree = { a: { b: { c: { target: true, value: 1 } } }, d: [{ target: true, value: 2 }] };
  const found = deepFind(tree, (n) => n.target === true);
  assert.equal(found.length, 2);
  assert.deepEqual(found.map((n) => n.value).sort(), [1, 2]);
});

test("deepFind returns [] for non-object roots and non-function predicates", () => {
  assert.deepEqual(deepFind(null, () => true), []);
  assert.deepEqual(deepFind("string", () => true), []);
  assert.deepEqual(deepFind({ a: 1 }, null), []);
});

test("deepFind does not loop forever on cyclic structures", () => {
  const node = { name: "self-referencing" };
  node.self = node;
  const found = deepFind(node, (n) => n.name === "self-referencing");
  assert.equal(found.length, 1);
});

test("deepFind respects maxDepth", () => {
  const tree = { l1: { l2: { l3: { target: true } } } };
  const shallow = deepFind(tree, (n) => n.target === true, { maxDepth: 1 });
  assert.equal(shallow.length, 0);
  const deep = deepFind(tree, (n) => n.target === true, { maxDepth: 5 });
  assert.equal(deep.length, 1);
});

test("deepFind survives a throwing predicate on some nodes", () => {
  const tree = { ok: { target: true }, weird: { get target() { throw new Error("boom"); } } };
  const found = deepFind(tree, (n) => n.target === true);
  assert.equal(found.length, 1);
});
