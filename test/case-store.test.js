/**
 * Case store layout and the v1 -> v2 conversion.
 *
 * Runs the real modules against a fake `chrome.storage.local`, because what is
 * worth testing here is exactly the storage choreography: which keys are written
 * together, in what order, and what a profile looks like after a conversion is
 * interrupted partway through.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

/** Minimal chrome.storage.local: same get/set/remove semantics, plus a log. */
function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  let failNextSetMatching = null;

  function get(keys) {
    if (keys === null || keys === undefined) return Promise.resolve(structuredClone(data));
    const names = Array.isArray(keys) ? keys : [keys];
    const result = {};
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(data, name)) result[name] = structuredClone(data[name]);
    }
    return Promise.resolve(result);
  }

  function set(values) {
    const keys = Object.keys(values);
    if (failNextSetMatching && keys.some(failNextSetMatching)) {
      failNextSetMatching = null;
      return Promise.reject(new Error("simulated storage failure"));
    }
    writes.push(keys);
    // `set` stores null; only `remove` deletes. The difference is how "absent"
    // and "cleared" are told apart when deciding whether to convert a profile.
    for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
    return Promise.resolve();
  }

  function remove(keys) {
    const names = Array.isArray(keys) ? keys : [keys];
    writes.push(names.map(name => `-${name}`));
    for (const name of names) delete data[name];
    return Promise.resolve();
  }

  return {
    data,
    writes,
    failNextSet(predicate) {
      failNextSetMatching = predicate;
    },
    local: { get, set, remove }
  };
}

function installFakeChrome(initial) {
  const storage = createFakeStorage(initial);
  globalThis.chrome = {
    storage,
    i18n: { getUILanguage: () => "en-US" }
  };
  return storage;
}

function legacyCase(id, stepCount, screenshotKeys = []) {
  const actions = Array.from({ length: stepCount }, (_, index) => ({
    id: `${id}_step_${index + 1}`,
    type: "click",
    pageName: "page1",
    screenshotKey: screenshotKeys[index]
  }));
  return {
    id,
    name: `case ${id}`,
    createdAt: 1000 + Number(id.replace(/\D/g, "") || 0),
    stepCount,
    schemaVersion: 1,
    actions,
    pages: [{ name: "page1", url: "https://example.test/", title: "Example" }]
  };
}

async function loadModules() {
  const suffix = `?t=${Math.random()}`;
  const caseStore = await import(`../background/store/case-store.js${suffix}`);
  const migration = await import(`../background/store/case-migration.js${suffix}`);
  const schema = await import(`../background/store/schema.js${suffix}`);
  return { caseStore, migration, schema };
}

test("a v1 profile converts to the split layout and drops the old array", async () => {
  const storage = installFakeChrome({
    schemaVersion: 1,
    cases: [legacyCase("case_a", 2, ["screenshot:a1", "screenshot:a2"]), legacyCase("case_b", 1, ["screenshot:b1"])]
  });
  const { caseStore, migration } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.ok, true);
  assert.equal(state.writable, true);
  assert.equal(state.migrated, 2);

  assert.equal(storage.data.cases, undefined);
  assert.equal(storage.data.schemaVersion, 2);
  assert.deepEqual(storage.data.caseIndex.map(entry => entry.id), ["case_b", "case_a"]);
  // Metadata only: the index must not carry steps or media keys.
  for (const entry of storage.data.caseIndex) {
    assert.deepEqual(Object.keys(entry).sort(), ["createdAt", "id", "name", "readable", "stepCount"]);
  }
  assert.equal(storage.data["case:case_a"].actions.length, 2);
  assert.deepEqual(storage.data["caseMedia:case_a"], ["screenshot:a1", "screenshot:a2"]);
  assert.deepEqual([...(await caseStore.readReferencedScreenshotKeys())].sort(), [
    "screenshot:a1",
    "screenshot:a2",
    "screenshot:b1"
  ]);
});

test("a profile with no saved cases initializes an empty index", async () => {
  const storage = installFakeChrome({ schemaVersion: 1 });
  const { migration } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.initialized, true);
  assert.deepEqual(storage.data.caseIndex, []);
  assert.equal(storage.data.schemaVersion, 2);
});

test("data written before versioning existed is treated as v1", async () => {
  const storage = installFakeChrome({ cases: [legacyCase("case_a", 1, ["screenshot:a1"])] });
  const { migration } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.migrated, 1);
  assert.equal(storage.data.schemaVersion, 2);
});

test("a profile from a newer build is readable but not writable", async () => {
  const storage = installFakeChrome({ schemaVersion: 99, caseIndex: [] });
  const { migration } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.ok, false);
  assert.equal(state.writable, false);
  assert.equal(state.reason, "newer");
  // Nothing was touched: the newer build still owns this data.
  assert.equal(storage.data.schemaVersion, 99);
});

test("a failed conversion keeps the v1 array and refuses writes", async () => {
  const storage = installFakeChrome({
    schemaVersion: 1,
    cases: [legacyCase("case_a", 1, ["screenshot:a1"])]
  });
  const { caseStore, migration } = await loadModules();
  storage.failNextSet(key => key.startsWith("case:"));

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.ok, false);
  assert.equal(state.writable, false);
  assert.equal(state.reason, "migration-failed");
  assert.equal(storage.data.schemaVersion, 1);
  assert.equal(storage.data.cases.length, 1);
  assert.equal(storage.data.caseIndex, undefined);
  assert.equal(storage.data.caseStoreMigration.status, "failed");

  // Reads still work, from the old layout, so the history stays visible.
  assert.deepEqual((await caseStore.readIndex()).map(entry => entry.id), ["case_a"]);
  assert.equal((await caseStore.readDetail("case_a")).actions.length, 1);
  assert.deepEqual([...(await caseStore.readReferencedScreenshotKeys())], ["screenshot:a1"]);
});

test("a conversion interrupted after the commit is not repeated", async () => {
  const storage = installFakeChrome({
    schemaVersion: 1,
    cases: [legacyCase("case_a", 1, ["screenshot:a1"])]
  });
  const { migration } = await loadModules();
  await migration.createCaseStoreCoordinator().ready();

  // A second worker start sees a committed store and leaves it alone.
  storage.writes.length = 0;
  const second = await migration.createCaseStoreCoordinator().ready();
  assert.deepEqual(second, { ok: true, writable: true, version: 2 });
  assert.deepEqual(storage.writes, []);
});

test("a conversion resumes from its recorded progress", async () => {
  const storage = installFakeChrome({
    schemaVersion: 1,
    cases: [legacyCase("case_a", 1, ["screenshot:a1"]), legacyCase("case_b", 1, ["screenshot:b1"])],
    // Left behind by a worker that was terminated mid-run.
    caseStoreMigration: { from: 1, to: 2, status: "running", nextIndex: 1, total: 2 },
    "case:case_a": { id: "case_a", actions: [{ id: "case_a_step_1" }], pages: [] },
    "caseMedia:case_a": ["screenshot:a1"]
  });
  const { migration } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.ok, true);
  // case_a was already written, so this run only had to write case_b.
  const detailWrites = storage.writes.filter(keys => keys.some(key => key.startsWith("case:")));
  assert.equal(detailWrites.length, 1);
  assert.ok(detailWrites[0].includes("case:case_b"));
  assert.equal(storage.data.caseIndex.length, 2);
});

test("an unreadable v1 record is carried over and flagged instead of failing the conversion", async () => {
  const storage = installFakeChrome({
    schemaVersion: 1,
    cases: [{ id: "case_bad", name: "broken", createdAt: 5, stepCount: 3, actions: null, pages: null }]
  });
  const { caseStore, migration } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.ok, true);
  assert.equal(storage.data.caseIndex[0].readable, false);
  // No steps to count, so the claim the v1 record made is kept: the history list
  // shows what it showed before, and the entry is flagged unloadable instead.
  assert.equal(storage.data.caseIndex[0].stepCount, 3);
  assert.notEqual(await caseStore.readDetail("case_bad"), null);
});

test("saving writes index, steps and media keys in one storage write", async () => {
  const storage = installFakeChrome({ schemaVersion: 2, caseIndex: [] });
  const { caseStore } = await loadModules();

  storage.writes.length = 0;
  await caseStore.writeCase(
    {
      id: "case_a",
      name: "A",
      createdAt: 10,
      actions: [
        { id: "s1", screenshotBeforeKey: "screenshot:a0", screenshotKey: "screenshot:a1" },
        { id: "s2", screenshotBeforeKey: "screenshot:a0", screenshotKey: "screenshot:a1" }
      ],
      pages: []
    },
    { activeCaseId: "case_a" }
  );

  assert.equal(storage.writes.length, 1);
  assert.deepEqual(storage.writes[0].sort(), ["activeCaseId", "caseIndex", "caseMedia:case_a", "case:case_a"].sort());
  // Both frames are retained, and duplicate references across steps occur once.
  assert.deepEqual(storage.data["caseMedia:case_a"], ["screenshot:a1", "screenshot:a0"]);
  assert.equal(storage.data.activeCaseId, "case_a");
});

test("deleting a case writes the index before removing its records", async () => {
  const storage = installFakeChrome({ schemaVersion: 2, caseIndex: [] });
  const { caseStore } = await loadModules();
  await caseStore.writeCase({
    id: "case_a",
    name: "A",
    createdAt: 10,
    actions: [{ id: "s1", screenshotKey: "screenshot:a1" }],
    pages: []
  });

  storage.writes.length = 0;
  const result = await caseStore.removeCase("case_a");
  assert.deepEqual(result.screenshotKeys, ["screenshot:a1"]);

  const indexWrite = storage.writes.findIndex(keys => keys.includes("caseIndex"));
  const recordRemoval = storage.writes.findIndex(keys => keys.includes("-case:case_a"));
  assert.ok(indexWrite >= 0 && recordRemoval > indexWrite, "index must be committed before the records are removed");
  assert.deepEqual(storage.data.caseIndex, []);
  assert.equal(storage.data["case:case_a"], undefined);
  assert.deepEqual(storage.data.pendingCaseRecordRemovalIds, []);
});

test("records stranded by an interrupted delete are reclaimed on the next start", async () => {
  const storage = installFakeChrome({
    schemaVersion: 2,
    caseIndex: [{ id: "case_b", name: "B", createdAt: 20, stepCount: 1, readable: true }],
    // The index write landed; the worker died before the records were removed.
    pendingCaseRecordRemovalIds: ["case_a", "case_b"],
    "case:case_a": { id: "case_a", actions: [], pages: [] },
    "caseMedia:case_a": ["screenshot:a1"],
    "case:case_b": { id: "case_b", actions: [{ id: "s1" }], pages: [] },
    "caseMedia:case_b": ["screenshot:b1"]
  });
  const { caseStore } = await loadModules();

  assert.equal(await caseStore.flushPendingRemovals(), 1);
  assert.equal(storage.data["case:case_a"], undefined);
  // case_b came back into the index, so its records must survive.
  assert.ok(storage.data["case:case_b"]);
  assert.deepEqual(storage.data.pendingCaseRecordRemovalIds, []);
});

test("renaming touches the index only", async () => {
  const storage = installFakeChrome({ schemaVersion: 2, caseIndex: [] });
  const { caseStore } = await loadModules();
  await caseStore.writeCase({ id: "case_a", name: "A", createdAt: 10, actions: [], pages: [] });

  storage.writes.length = 0;
  assert.equal(await caseStore.renameCase("case_a", "renamed"), true);
  assert.deepEqual(storage.writes, [["caseIndex"]]);
  assert.equal(storage.data.caseIndex[0].name, "renamed");
  assert.equal(storage.data["case:case_a"].id, "case_a");
});

test("folders organize cases and non-empty trees cannot be deleted", async () => {
  const storage = installFakeChrome({ schemaVersion: 2, caseIndex: [] });
  const { caseStore } = await loadModules();
  await caseStore.writeCase({ id: "case_a", name: "A", createdAt: 10, actions: [], pages: [] });
  await caseStore.writeCase({ id: "case_b", name: "B", createdAt: 20, actions: [], pages: [] });

  const folder = { id: "folder_smoke", name: "Smoke", createdAt: 30, parentId: null };
  const child = { id: "folder_child", name: "Child", createdAt: 31, parentId: folder.id };
  await caseStore.writeFolder(folder);
  await caseStore.writeFolder(child);
  assert.deepEqual(await caseStore.readFolders(), [folder, child]);

  storage.writes.length = 0;
  assert.equal(await caseStore.moveCasesToFolder(["case_a", "case_b"], child.id), 2);
  assert.deepEqual(storage.writes, [["caseIndex"]]);
  assert.equal(storage.data.caseIndex.every(entry => entry.folderId === child.id), true);
  assert.ok(storage.data["case:case_a"], "moving must not rewrite or remove case details");

  storage.writes.length = 0;
  const blocked = await caseStore.removeFolder(folder.id);
  assert.equal(blocked.caseCount, 2);
  assert.equal(blocked.removedCount, 0);
  assert.deepEqual(storage.writes, []);

  await caseStore.moveCasesToFolder(["case_a", "case_b"], null);
  storage.writes.length = 0;
  const removed = await caseStore.removeFolder(folder.id);
  assert.equal(removed.removedCount, 2);
  assert.deepEqual(storage.writes, [["caseFolders"]]);
  assert.deepEqual(storage.data.caseFolders, []);
});

test("batch deletion removes one index slice and all case records", async () => {
  const storage = installFakeChrome({ schemaVersion: 2, caseIndex: [] });
  const { caseStore } = await loadModules();
  await caseStore.writeCase({
    id: "case_a", name: "A", createdAt: 10,
    actions: [{ id: "a1", screenshotKey: "screenshot:shared" }], pages: []
  });
  await caseStore.writeCase({
    id: "case_b", name: "B", createdAt: 20,
    actions: [{ id: "b1", screenshotKey: "screenshot:shared" }], pages: []
  });

  storage.writes.length = 0;
  const result = await caseStore.removeCases(["case_a", "case_b"]);
  assert.equal(result.removed.length, 2);
  assert.deepEqual(result.screenshotKeys, ["screenshot:shared"]);
  assert.deepEqual(storage.data.caseIndex, []);
  assert.equal(storage.data["case:case_a"], undefined);
  assert.equal(storage.data["case:case_b"], undefined);
});

test("the index orders newest first and breaks ties on id", async () => {
  installFakeChrome({});
  const { caseStore } = await loadModules();
  const sorted = caseStore.sortIndex([
    { id: "b", createdAt: 100 },
    { id: "c", createdAt: 200 },
    { id: "a", createdAt: 100 }
  ]);
  assert.deepEqual(sorted.map(entry => entry.id), ["c", "b", "a"]);
});
