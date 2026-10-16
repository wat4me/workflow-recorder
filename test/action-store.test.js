const assert = require("node:assert/strict");
const test = require("node:test");

function createStorage(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data,
    writes,
    local: {
      get(keys) {
        if (keys === null || keys === undefined) return Promise.resolve(structuredClone(data));
        const names = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const name of names) {
          if (Object.prototype.hasOwnProperty.call(data, name)) result[name] = structuredClone(data[name]);
        }
        return Promise.resolve(result);
      },
      set(values) {
        writes.push(Object.keys(values));
        Object.assign(data, structuredClone(values));
        return Promise.resolve();
      },
      remove(keys) {
        const names = Array.isArray(keys) ? keys : [keys];
        writes.push(names.map(name => `-${name}`));
        for (const name of names) delete data[name];
        return Promise.resolve();
      }
    }
  };
}

test("batch step deletion updates order once and removes only selected records", async () => {
  const storage = createStorage({
    actionOrder: ["s1", "s2", "s3"],
    "action:s1": { id: "s1", type: "click" },
    "action:s2": { id: "s2", type: "type" },
    "action:s3": { id: "s3", type: "click" }
  });
  globalThis.chrome = { storage };
  const actions = await import(`../background/store/actions.js?t=${Math.random()}`);

  const removed = await actions.removeActions(["s1", "s3", "s1"]);

  assert.deepEqual(removed.map(action => action.id), ["s1", "s3"]);
  assert.deepEqual(storage.data.actionOrder, ["s2"]);
  assert.equal(storage.data["action:s1"], undefined);
  assert.ok(storage.data["action:s2"]);
  assert.equal(storage.data["action:s3"], undefined);
  assert.deepEqual(storage.writes, [
    ["actionOrder"],
    ["-action:s1", "-action:s3"]
  ]);
});

test("orphan cleanup enumerates keys without reading saved case payloads", async () => {
  const storage = createStorage({ actionOrder: ["live"], "action:live": { id: "live" },
    "action:orphan": { id: "orphan" }, "case:large": { actions: ["large payload"] } });
  const get = storage.local.get;
  storage.local.get = keys => {
    assert.equal(keys, "actionOrder", "only the order should be deserialized");
    return get(keys);
  };
  storage.local.getKeys = async () => Object.keys(storage.data);
  globalThis.chrome = { storage };
  const actions = await import("../background/store/actions.js");
  assert.equal(await actions.removeOrphanActions(), 1);
  assert.ok(storage.data["case:large"]);
  assert.ok(storage.data["action:live"]);
  assert.equal(storage.data["action:orphan"], undefined);
});
