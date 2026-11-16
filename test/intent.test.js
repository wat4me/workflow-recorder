/**
 * The live annotation draft.
 *
 * What matters here is the storage contract the panel and the save path rely
 * on: values are normalised on the way in, an empty annotation removes the key
 * instead of storing null, and a boundary can never point past the recorded
 * steps.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    local: {
      get: keys => {
        const names = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const name of names) {
          if (Object.prototype.hasOwnProperty.call(data, name)) result[name] = structuredClone(data[name]);
        }
        return Promise.resolve(result);
      },
      set: values => {
        for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
        return Promise.resolve();
      },
      remove: keys => {
        for (const name of (Array.isArray(keys) ? keys : [keys])) delete data[name];
        return Promise.resolve();
      }
    }
  };
}

async function loadIntent(initial) {
  const storage = createFakeStorage(initial);
  globalThis.chrome = { storage, i18n: { getUILanguage: () => "en-US" } };
  const intent = await import(`../background/store/intent.js?t=${Math.random()}`);
  return { intent, storage };
}

test("an annotation round-trips through storage and is clamped to the steps", async () => {
  const { intent, storage } = await loadIntent({});

  assert.equal(await intent.readIntent(5), null);

  const saved = await intent.writeIntent({
    steps: [{ id: "s1", title: "上传", afterStep: 99, goal: "  上传本地文件  ", checks: ["附件出现", "  "] }]
  }, 5);

  assert.equal(saved.goal, undefined);
  assert.equal(saved.steps[0].goal, "上传本地文件");
  // afterStep 99 is converted (start 100) and clamped to one past the last step.
  assert.equal(saved.steps[0].start, 6);
  assert.deepEqual(saved.steps[0].checks, ["附件出现"]);
  assert.deepEqual(storage.data[intent.INTENT_KEY], saved);
  assert.deepEqual(await intent.readIntent(5), saved);
});

test("clearing an annotation removes the key rather than storing an empty one", async () => {
  const { intent, storage } = await loadIntent({
    workspaceIntent: { goal: "旧标注", steps: [] }
  });

  assert.equal(await intent.writeIntent({ goal: "", steps: [] }, 3), null);
  assert.equal(storage.data[intent.INTENT_KEY], undefined);
  assert.equal(await intent.readIntent(3), null);

});

test("a record written by another build is normalised on read", async () => {
  const { intent } = await loadIntent({
    workspaceIntent: { goal: "x", steps: [{ afterStep: -4 }, { afterStep: 2.7 }, "junk", null] }
  });
  const read = await intent.readIntent(4);
  assert.equal(read.goal, undefined);
  assert.equal(read.steps[0].goal, "x");
  // The negative boundary clamps to the first step, the non-integer one to the
  // same start (so it is the duplicate and drops), and junk entries are skipped.
  assert.deepEqual(read.steps.map(step => step.start), [1]);
});

test("deleting actions shifts both boundaries and preserves the surviving annotation", async () => {
  const { intent, storage } = await loadIntent({
    actionOrder: ["a", "b", "c", "d"],
    ...Object.fromEntries(["a", "b", "c", "d"].map(id => [`action:${id}`, { id }])),
    workspaceIntent: { steps: [
      { id: "first", start: 1, end: 2 },
      { id: "second", start: 3, end: 4, goal: "Keep this goal" },
      { id: "pending", start: 5, end: 4, open: true }
    ] }
  });
  const actions = await import("../background/store/actions.js");
  const ranges = value => value.steps.map(step => [step.id, step.start, step.end]);

  await actions.removeActionAt(0);
  assert.deepEqual(ranges(await intent.readIntent(3)), [["first", 1, 1], ["second", 2, 3], ["pending", 4, 3]]);

  await actions.removeActions(["b", "d"]);
  const remaining = await intent.readIntent(1);
  assert.deepEqual(ranges(remaining), [["second", 1, 1], ["pending", 2, 1]]);
  assert.equal(remaining.steps[0].goal, "Keep this goal");
  assert.deepEqual(storage.data.actionOrder, ["c"]);

  await actions.clearActions();
  assert.equal(await intent.readIntent(0), null);
});
