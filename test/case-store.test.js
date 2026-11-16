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
  const { caseStore, migration, schema } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.ok, true);
  assert.equal(state.writable, true);
  assert.equal(state.migrated, 2);

  assert.equal(storage.data.cases, undefined);
  assert.equal(storage.data.schemaVersion, schema.SCHEMA_VERSION);
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
  const { migration, schema } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.initialized, true);
  assert.deepEqual(storage.data.caseIndex, []);
  assert.equal(storage.data.schemaVersion, schema.SCHEMA_VERSION);
});

test("data written before versioning existed is treated as v1", async () => {
  const storage = installFakeChrome({ cases: [legacyCase("case_a", 1, ["screenshot:a1"])] });
  const { migration, schema } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.migrated, 1);
  assert.equal(storage.data.schemaVersion, schema.SCHEMA_VERSION);
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
  const { migration, schema } = await loadModules();
  await migration.createCaseStoreCoordinator().ready();

  // A second worker start sees a committed store and leaves it alone.
  storage.writes.length = 0;
  const second = await migration.createCaseStoreCoordinator().ready();
  assert.deepEqual(second, { ok: true, writable: true, version: schema.SCHEMA_VERSION });
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

test("a v2 profile only bumps the version and keeps every record", async () => {
  const entry = { id: "case_a", name: "case a", createdAt: 1, stepCount: 1, readable: true };
  const detail = { id: "case_a", actions: [{ id: "a1", type: "click" }], pages: [] };
  const storage = installFakeChrome({
    schemaVersion: 2,
    caseIndex: [entry],
    "case:case_a": detail,
    "caseMedia:case_a": []
  });
  const { migration, schema } = await loadModules();

  const state = await migration.createCaseStoreCoordinator().ready();
  assert.equal(state.ok, true);
  assert.equal(state.writable, true);
  assert.equal(state.migrated, 0);
  assert.equal(storage.data.schemaVersion, schema.SCHEMA_VERSION);
  // Nothing but the version moves: this bump needs no data conversion.
  assert.deepEqual(storage.data.caseIndex, [entry]);
  assert.deepEqual(storage.data["case:case_a"], detail);
  assert.equal(storage.data.cases, undefined);
  assert.equal(storage.data.caseStoreMigration.status, "committed");
});

test("intent is normalised, clamped to the recorded steps and dropped when empty", async () => {
  installFakeChrome({});
  const { caseStore } = await loadModules();

  assert.equal(caseStore.sanitizeIntent(null), null);
  assert.equal(caseStore.sanitizeIntent({}), null);
  // An inserted test step may carry nothing yet: it is a placeholder the steps
  // recorded next belong to, so it must survive a save.
  assert.deepEqual(caseStore.sanitizeIntent({ steps: [{ start: 2 }] }, 4).steps.map(step => step.start), [2]);

  const intent = caseStore.sanitizeIntent({
    steps: [
      { id: "s2", title: "上传", start: 9, goal: "  整份用例在测上传  ", note: "先小图", checks: ["附件出现", "  "] },
      { id: "s1", start: 3, checks: ["进入工作台"] },
      { id: "dup", start: 3, checks: ["重复位置"] },
      { id: "empty", start: 5 },
      // Written by the first iteration of this field.
      { id: "legacy", afterStep: 1, checks: ["旧格式"] }
    ]
  }, 6);

  assert.equal(intent.note, undefined);
  // Clamped to 1..stepCount+1: 9 means "starts before a step that does not
  // exist yet" and becomes 7 (the open step). The duplicate start drops; the
  // empty placeholder and the legacy afterStep entry are kept.
  assert.deepEqual(intent.steps.map(step => step.start), [2, 3, 5, 7]);
  // Ranges are explicit: a missing end runs to the step before the next test
  // step, and the last one runs to the end of the recording.
  assert.deepEqual(intent.steps.map(step => step.end), [2, 4, 6, 6]);
  assert.deepEqual(intent.steps.map(step => step.open), [false, false, false, true]);
  assert.deepEqual(intent.steps[1].checks, ["进入工作台"]);
  assert.equal(intent.steps[3].id, "s2");
  assert.equal(intent.steps[3].goal, "整份用例在测上传");
  assert.deepEqual(intent.steps[0].checks, ["旧格式"]);

  const detail = caseStore.detailRecordFor({
    id: "case_a",
    actions: Array.from({ length: 6 }, (_, index) => ({ id: `a${index + 1}` })),
    pages: [],
    intent
  });
  assert.deepEqual(detail.intent, intent);
  assert.equal(caseStore.detailRecordFor({ id: "b", actions: [], pages: [] }).intent, undefined);
});

test("a workbench annotation edit preserves the index and recorded actions", async () => {
  const entry = { id: "case_a", name: "case a", createdAt: 1, stepCount: 3, readable: true };
  const detail = { id: "case_a", actions: [{ id: "a1" }, { id: "a2" }, { id: "a3" }], pages: [] };
  const storage = installFakeChrome({
    schemaVersion: 3,
    caseIndex: [entry],
    "case:case_a": detail
  });
  const { caseStore } = await loadModules();

  const saved = await caseStore.updateIntent("case_a", {
    steps: [{ id: "s1", title: "上传", start: 99, goal: "上传本地文件", checks: ["附件出现"] }]
  });
  assert.equal(saved.goal, undefined);
  assert.equal(saved.steps[0].goal, "上传本地文件");
  // Clamped to one past the last step: an open test step.
  assert.equal(saved.steps[0].start, 4);
  assert.deepEqual(storage.data["case:case_a"].intent, saved);
  // The steps and the history list are untouched by an annotation edit.
  assert.deepEqual(storage.data["case:case_a"].actions, detail.actions);
  assert.deepEqual(storage.data.caseIndex, [entry]);

  assert.equal(await caseStore.updateIntent("case_a", { goal: "", steps: [] }), null);
  assert.equal(storage.data["case:case_a"].intent, undefined);
  assert.equal(await caseStore.updateIntent("missing", { goal: "x" }), undefined);
});

test("annotations keep test criteria and ignore retired data fields", async () => {
  installFakeChrome({});
  const { caseStore } = await loadModules();

  const intent = caseStore.sanitizeIntent({
    steps: [{
      id: "s1",
      start: 1,
      goal: "验证上传目标",
      purpose: "验证上传",
      preconditions: ["登录", "有权限"],
      pass: ["完成后刷新仍在"],
      dataValues: [
        { id: "d1", field: " 标题 ", control: "input", rule: " 用日期后缀 " },
        { id: "d2", field: "合同", control: "upload", rule: "ignored" },
        { field: "", control: "checkbox", rule: "无字段应丢弃" },
        { field: "状态", control: "unknown", rule: "按录制值" }
      ],
      filePool: {
        zipName: "C:\\cases\\关联文档-files.zip",
        poolKey: "intent-pool-s1",
        files: [
          { name: "../a.pdf", type: "pdf", size: 123 },
          { name: "", type: "PDF", size: 1 }
        ]
      }
    }]
  }, 3);

  assert.equal(intent.note, undefined);
  assert.equal(intent.setup, undefined);
  assert.equal(intent.pass, undefined);
  assert.equal(intent.steps[0].goal, "验证上传目标");
  assert.deepEqual(intent.steps[0].preconditions, ["登录", "有权限"]);
  assert.deepEqual(intent.steps[0].pass, ["完成后刷新仍在"]);
  assert.equal(intent.steps[0].purpose, "验证上传");
  assert.equal(intent.steps[0].dataValues, undefined);
  assert.equal(intent.steps[0].filePool, undefined);

  // The old case-level pass criteria move to the first step, so reopening an
  // annotated recording does not silently lose the tester's words.
  const migrated = caseStore.sanitizeIntent({
    note: "旧目标",
    setup: "旧前置一\n旧前置二",
    pass: "旧标准一\n旧标准二",
    steps: [{ start: 1 }]
  }, 2);
  assert.equal(migrated.note, undefined);
  assert.equal(migrated.setup, undefined);
  assert.equal(migrated.pass, undefined);
  assert.equal(migrated.steps[0].goal, "旧目标");
  assert.deepEqual(migrated.steps[0].preconditions, ["旧前置一", "旧前置二"]);
  assert.deepEqual(migrated.steps[0].pass, ["旧标准一", "旧标准二"]);
});
