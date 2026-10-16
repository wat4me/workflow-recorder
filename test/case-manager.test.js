/**
 * Case lifecycle over the split store.
 *
 * These assertions are the contract the storage refactor had to keep: what the
 * panel sees in the history list, what loading a case does to the workspace, and
 * which screenshots a deletion is allowed to reclaim. They are written against
 * the manager rather than the storage keys so they stay meaningful when the
 * layout changes again.
 */
const assert = require("node:assert/strict");
const test = require("node:test");

function createFakeStorage(initial = {}) {
  const data = structuredClone(initial);

  return {
    data,
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
        // `set` stores null; only `remove` deletes. Emulating that matters here,
        // because the difference is exactly how "cleared" and "absent" are told
        // apart when deciding whether a profile has been converted.
        for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
        return Promise.resolve();
      },
      remove(keys) {
        for (const name of Array.isArray(keys) ? keys : [keys]) delete data[name];
        return Promise.resolve();
      }
    }
  };
}

function action(id, overrides = {}) {
  return { id, type: "click", pageName: "page1", timestamp: 1, ...overrides };
}

/** Seeds the workspace step list in its stored form. */
function seedWorkspace(storage, actions) {
  storage.data.actionOrder = actions.map(item => item.id);
  for (const item of actions) storage.data[`action:${item.id}`] = structuredClone(item);
}

/** Seeds a saved case in its stored form: index entry, detail record, media list. */
function seedCase(storage, { id, name = id, actions, lineage = null }) {
  storage.data.caseIndex = [
    ...(storage.data.caseIndex || []).filter(entry => entry.id !== id),
    { id, name, createdAt: 1, stepCount: actions.length, readable: true, ...(lineage ? { lineage } : {}) }
  ];
  storage.data[`case:${id}`] = { id, actions: structuredClone(actions), pages: [] };
  storage.data[`caseMedia:${id}`] = [...new Set(actions
    .flatMap(item => [item.screenshotKey, item.screenshotBeforeKey])
    .filter(Boolean))];
}

async function setup({ initial = {}, writable = true, reason = "migration-failed", queueCaseWrite = fn => fn() } = {}) {
  const storage = createFakeStorage({ schemaVersion: 2, caseIndex: [], ...initial });
  globalThis.chrome = { storage, i18n: { getUILanguage: () => "en-US" } };

  const suffix = `?t=${Math.random()}`;
  const { createCaseManager } = await import(`../background/store/cases.js${suffix}`);
  const caseStore = await import(`../background/store/case-store.js${suffix}`);

  const deleted = [];
  const cases = createCaseManager({
    t: (key, subs, fallback) => fallback,
    notifyStepsUpdated: () => {},
    // Case mutations are serialized in production; the ordering is not what these
    // assertions are about, so the queue is a pass-through here.
    queueCaseWrite,
    caseStoreReady: async () => (writable
      ? { ok: true, writable: true, version: 2 }
      : { ok: false, writable: false, reason, version: 1, expected: 2 }),
    deleteScreenshots: async keys => {
      const retained = await caseStore.readReferencedScreenshotKeys();
      const workspace = new Set(
        (storage.data.actionOrder || [])
          .map(id => storage.data[`action:${id}`]?.screenshotKey)
          .filter(Boolean)
      );
      const removable = keys.filter(key => !retained.has(key) && !workspace.has(key));
      deleted.push(...removable);
      return { deletedCount: removable.length, pending: false };
    },
    // Mirrors mediaCleanup.referencedKeys: the workspace plus every case except the
    // ones being asked about, which is what makes a preview describe the deletion.
    readReferencedScreenshotKeys: async ({ excludingCaseIds = null } = {}) => {
      const retained = await caseStore.readReferencedScreenshotKeys({ excluding: excludingCaseIds });
      for (const id of storage.data.actionOrder || []) {
        const step = storage.data[`action:${id}`];
        for (const key of [step?.screenshotKey, step?.screenshotBeforeKey]) if (key) retained.add(key);
      }
      return retained;
    }
  });

  return { cases, caseStore, storage, deleted };
}

test("saving banks the workspace and makes the case the active baseline", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1", { screenshotKey: "screenshot:s1" }), action("s2")]);

  const result = await cases.save("Login");
  assert.equal(result.success, true);
  assert.equal(result.case.name, "Login");
  assert.equal(result.case.stepCount, 2);
  assert.equal(storage.data.activeCaseId, result.case.id);
  assert.equal(storage.data[`case:${result.case.id}`].actions.length, 2);
  assert.deepEqual(storage.data[`caseMedia:${result.case.id}`], ["screenshot:s1"]);
  // The saved copy is a snapshot: later workspace edits must not reach it.
  assert.notEqual(storage.data[`case:${result.case.id}`].actions, storage.data["action:s1"]);
});

test("saving commits the selected folder with the case and preserves snapshot semantics", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1")]);
  const folder = await cases.createFolder("Login flows");
  assert.equal(folder.success, true);
  const snapshot = await cases.save("Snapshot", true, folder.folder.id);
  assert.equal(snapshot.success, true);
  assert.equal(snapshot.case.folderId, folder.folder.id);
  assert.equal(storage.data.caseIndex[0].folderId, folder.folder.id);
  assert.equal(storage.data.activeCaseId, undefined);
  const saved = await cases.save("Filed", false, folder.folder.id);
  assert.equal(saved.success, true);
  assert.equal(saved.case.folderId, folder.folder.id);
  assert.equal(storage.data.activeCaseId, saved.case.id);
  const unfiled = await cases.save("Unfiled", false, null);
  assert.equal(unfiled.case.folderId || null, null);
});

test("a missing or invalid save folder leaves the case index and workspace unchanged", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1")]);
  const before = structuredClone(storage.data);
  for (const folderId of ["deleted-folder", {}, 123, ""]) {
    const saved = await cases.save("Filed", false, folderId);
    assert.equal(saved.success, false);
    assert.match(saved.error, /文件夹不存在/);
    assert.deepEqual(storage.data, before);
  }
});

test("a snapshot is banked without becoming the baseline", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1")]);

  const result = await cases.save("Snapshot", true);
  assert.equal(result.success, true);
  assert.equal(storage.data.activeCaseId, undefined);
  assert.equal(storage.data.caseIndex.length, 1);
});

test("duplicate saves receive folder-local numbers without replacing earlier snapshots", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("original", { screenshotKey: "shot:original" })]);
  const first = await cases.save("Login");
  seedWorkspace(storage, [action("changed")]);
  const second = await cases.save(" login ");
  const third = await cases.save("Login");
  const numbered = await cases.save("Login（2）");
  assert.deepEqual([first, second, third, numbered].map(result => result.case.name),
    ["Login", "login（2）", "Login（3）", "Login（4）"]);
  assert.equal(new Set(storage.data.caseIndex.map(entry => entry.id)).size, 4);
  assert.equal(storage.data[`case:${first.case.id}`].actions[0].id, "original");
  assert.deepEqual(storage.data[`caseMedia:${first.case.id}`], ["shot:original"]);
  const { folder } = await cases.createFolder("Other");
  assert.equal((await cases.save("Login", false, folder.id)).case.name, "Login");
  const long = "长".repeat(120);
  await cases.save(long);
  const limited = await cases.save(long);
  assert.equal(limited.case.name, "长".repeat(117) + "（2）");
  assert.equal(limited.case.name.length, 120);
});

test("serialized concurrent saves reserve distinct names and keep both entries", async () => {
  let pending = Promise.resolve();
  const { cases, storage } = await setup({ queueCaseWrite: fn => {
    const next = pending.then(fn);
    pending = next.catch(() => {});
    return next;
  } });
  seedWorkspace(storage, [action("s1")]);
  const saved = await Promise.all([cases.save("Same"), cases.save("Same"), cases.save("Same")]);
  assert.deepEqual(saved.map(result => result.case.name), ["Same", "Same（2）", "Same（3）"]);
  assert.equal(storage.data.caseIndex.length, 3);
});

test("rename rejects same-folder collisions while preserving legacy duplicates and cross-folder names", async () => {
  const { cases, storage } = await setup();
  seedCase(storage, { id: "first", name: "Login", actions: [action("one")] });
  seedCase(storage, { id: "legacy", name: "Login", actions: [action("two")] });
  seedCase(storage, { id: "other", name: "Other", actions: [action("three")] });
  const before = structuredClone(storage.data);
  const conflict = await cases.rename("other", "  LOGIN  ");
  assert.equal(conflict.success, false);
  assert.match(conflict.error, /同名用例/);
  assert.deepEqual(storage.data, before);
  assert.equal((await cases.rename("legacy", "Login")).success, true);
  const { folder } = await cases.createFolder("Separate");
  await cases.moveToFolder(["other"], folder.id);
  assert.equal((await cases.rename("other", "Login")).success, true);
});

test("imports number collisions against existing unfiled cases and within the incoming batch", async () => {
  const { cases, storage } = await setup();
  seedCase(storage, { id: "existing", name: "Flow", actions: [action("existing-step")] });
  const result = await cases.importMany(["one", "two"].map(id => ({
    id: `case_import_${id}`, name: "Flow", createdAt: 1, actions: [action(id)], pages: []
  })));
  assert.equal(result.success, true);
  assert.equal(result.renamedCount, 2);
  assert.deepEqual(storage.data.caseIndex.map(item => item.name).sort(), ["Flow", "Flow（2）", "Flow（3）"]);
  assert.equal(storage.data["case:existing"].actions[0].id, "existing-step");
});

test("batch moves number name conflicts and update the loaded origin without touching steps or media", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1", { screenshotKey: "shot:shared" })]);
  const { folder: source } = await cases.createFolder("Source");
  const { folder: target } = await cases.createFolder("Target");
  const first = await cases.save("Flow", false, source.id);
  const second = await cases.save("Flow");
  const existing = await cases.save("Flow", false, target.id);
  await cases.load(second.case.id);
  const before = structuredClone(storage.data);
  const result = await cases.moveToFolder([first.case.id, second.case.id, existing.case.id], target.id);
  assert.equal(result.success, true);
  assert.equal(result.renamedCount, 2);
  const index = storage.data.caseIndex;
  assert.deepEqual(index.map(entry => entry.name).sort(), ["Flow", "Flow（2）", "Flow（3）"]);
  assert.ok(index.every(entry => entry.folderId === target.id));
  assert.equal(index.find(entry => entry.id === existing.case.id).name, "Flow");
  assert.equal(storage.data.workspaceOrigin.caseNameSnapshot, index.find(entry => entry.id === second.case.id).name);
  for (const [key, value] of Object.entries(before)) {
    if (key !== "caseIndex" && key !== "workspaceOrigin") assert.deepEqual(storage.data[key], value, key);
  }
  const again = await cases.moveToFolder([first.case.id, second.case.id], target.id);
  assert.equal(again.renamedCount, 0);
  assert.deepEqual(storage.data.caseIndex, index);
});

test("a scene saved by an earlier build remains a readable flat case", async () => {
  const { cases, caseStore, storage } = await setup();
  await caseStore.writeCase({
    id: "legacy-scene",
    name: "旧场景",
    createdAt: 1,
    kind: "scene",
    actions: [action("scene-step")],
    pages: [{ name: "page1", url: "https://example.test", title: "Example" }],
    composition: {
      type: "sequence",
      sources: [{
        caseId: "deleted-source", caseName: "旧来源", order: 0, startIndex: 0,
        count: 1, actionIndexes: [0], actionIds: ["original-step"]
      }]
    }
  });

  const details = await cases.getDetails("legacy-scene");
  assert.equal(details.success, true);
  assert.equal(details.case.actions[0].id, "scene-step");
  const loaded = await cases.load("legacy-scene");
  assert.equal(loaded.success, true);
  assert.deepEqual(storage.data.actionOrder, ["scene-step"]);
});

test("importing a case family commits its index, details, media and lineage together", async () => {
  const { cases, storage } = await setup();
  const parent = {
    id: "case_import_parent",
    name: "Shared parent",
    createdAt: 10,
    actions: [action("step_import_shared", { screenshotKey: "import:one" })],
    pages: [{ name: "page1", url: "https://example.test" }],
    lineage: null
  };
  const child = {
    id: "case_import_child",
    name: "Shared child",
    createdAt: 11,
    actions: [
      action("step_import_shared", { screenshotKey: "import:one" }),
      action("step_import_child", { screenshotBeforeKey: "import:two" })
    ],
    pages: [{ name: "page1", url: "https://example.test" }],
    lineage: {
      parentCaseId: parent.id,
      forkedFromActionId: "step_import_shared",
      inheritedStepCount: 1,
      addedStepCount: 1,
      relation: "continued"
    }
  };

  const result = await cases.importMany([parent, child]);
  assert.equal(result.success, true);
  assert.equal(result.importedCount, 2);
  assert.equal(storage.data.caseIndex.length, 2);
  assert.deepEqual(storage.data["caseMedia:case_import_parent"], ["import:one"]);
  assert.deepEqual(storage.data["caseMedia:case_import_child"], ["import:one", "import:two"]);
  assert.equal(
    storage.data.caseIndex.find(item => item.id === child.id).lineage.parentCaseId,
    parent.id
  );
  assert.equal(storage.data["case:case_import_child"].actions.length, 2);
});

test("saving refuses when there are no steps", async () => {
  const { cases } = await setup();
  const result = await cases.save("Empty");
  assert.equal(result.success, false);
  assert.match(result.error, /没有可保存的步骤/);
});

test("clearing the workspace removes its steps and both screenshot frames", async () => {
  const { cases, storage, deleted } = await setup({
    initial: {
      activeCaseId: "case_old",
      workspaceOrigin: { caseId: "case_old" },
      tabsMapping: { 1: "page1" },
      nextPageNumber: 2,
      isRecording: false
    }
  });
  seedWorkspace(storage, [action("s1", {
    screenshotBeforeKey: "screenshot:s1:before",
    screenshotKey: "screenshot:s1:after"
  })]);

  const result = await cases.clearWorkspace();
  assert.equal(result.success, true);
  assert.deepEqual(storage.data.actionOrder, []);
  assert.equal(storage.data.activeCaseId, null);
  assert.equal(storage.data.workspaceOrigin, null);
  assert.deepEqual(storage.data.tabsMapping, {});
  assert.equal(storage.data.nextPageNumber, 1);
  assert.deepEqual(deleted.sort(), ["screenshot:s1:after", "screenshot:s1:before"]);
});

test("clearing steps is refused while recording", async () => {
  const { cases, storage } = await setup({ initial: { isRecording: true } });
  seedWorkspace(storage, [action("s1")]);

  const result = await cases.clearWorkspace();
  assert.equal(result.success, false);
  assert.match(result.error, /暂停录制/);
  assert.deepEqual(storage.data.actionOrder, ["s1"]);
});

test("the history list carries metadata only", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1"), action("s2")]);
  await cases.save("Login");
  seedWorkspace(storage, [action("s3")]);
  storage.data.activeCaseId = null;

  const listed = await cases.list();
  assert.equal(listed.cases.length, 1);
  assert.deepEqual(Object.keys(listed.cases[0]).sort(), [
    "createdAt", "folderId", "id", "isActive", "name", "readable", "stepCount"
  ]);
  assert.equal(listed.cases[0].stepCount, 2);
  assert.equal(listed.currentStepCount, 1);
  assert.equal(listed.hasUnsavedChanges, true);
});

test("folders support three levels and refuse deletion while their tree has cases", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1")]);
  const saved = await cases.save("Login");

  const created = await cases.createFolder("Smoke tests");
  const child = await cases.createFolder("Admin", created.folder.id);
  const grandchild = await cases.createFolder("Login", child.folder.id);
  assert.equal(created.success, true);
  assert.equal(child.success, true);
  assert.equal(grandchild.success, true);
  assert.equal((await cases.createFolder("Too deep", grandchild.folder.id)).success, false);
  assert.equal((await cases.listFolders()).folders.length, 3);
  assert.equal((await cases.createFolder(" smoke TESTS ")).success, false);

  const moved = await cases.moveToFolder([saved.case.id], grandchild.folder.id);
  assert.equal(moved.success, true);
  assert.equal((await cases.list()).cases[0].folderId, grandchild.folder.id);

  const blocked = await cases.removeFolder(created.folder.id);
  assert.equal(blocked.success, false);
  assert.equal(blocked.caseCount, 1);

  await cases.moveToFolder([saved.case.id], null);
  const removed = await cases.removeFolder(created.folder.id);
  assert.equal(removed.success, true);
  assert.equal(removed.removedCount, 3);
  assert.ok(storage.data[`case:${saved.case.id}`]);
});

test("folder update messages rename and move a subtree without changing cases or the workspace", async () => {
  const { cases, storage, deleted } = await setup({
    initial: { tabsMapping: { 1: "page1" }, nextPageNumber: 2, isRecording: true }
  });
  const { folder: source } = await cases.createFolder("Source");
  const { folder: child } = await cases.createFolder("Child", source.id);
  const { folder: target } = await cases.createFolder("Target");
  const steps = [action("s1", { screenshotBeforeKey: "shot:before", screenshotKey: "shot:after" })];
  seedWorkspace(storage, steps);
  const parentCase = await cases.save("Parent");
  seedWorkspace(storage, [...steps, action("s2", { screenshotKey: "shot:child" })]);
  const childCase = await cases.save("Continuation");
  await cases.moveToFolder([parentCase.case.id], source.id);
  await cases.moveToFolder([childCase.case.id], child.id);
  assert.equal(childCase.case.lineage.parentCaseId, parentCase.case.id);

  const { createApplicationRoutes } = await import("../background/routes.js");
  const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
  assert.equal(MESSAGE.updateCaseFolder, "updateCaseFolder");
  const routes = createApplicationRoutes({ cases });
  const before = structuredClone(storage.data);
  let expectedFolder = source;
  for (const changes of [
    { name: "  Renamed  " },
    { parentId: target.id },
    { name: "Renamed again", parentId: null }
  ]) {
    expectedFolder = { ...expectedFolder, ...changes };
    expectedFolder.name = expectedFolder.name.trim();
    const result = await routes[MESSAGE.updateCaseFolder]({ folderId: source.id, changes });
    assert.deepEqual(result, { success: true, folder: expectedFolder });
    assert.deepEqual(storage.data, {
      ...before,
      caseFolders: [...before.caseFolders.filter(folder => folder.id !== source.id), expectedFolder]
    });
    assert.deepEqual(deleted, []);
  }
});

test("folder updates reject case-insensitive sibling collisions but exclude themselves", async context => {
  const { cases, storage } = await setup();
  const { folder: source } = await cases.createFolder("Source");
  const { folder: target } = await cases.createFolder("Target");
  await cases.createFolder("source", target.id);
  await cases.createFolder("Other", target.id);
  const before = structuredClone(storage.data);
  const writes = context.mock.method(storage.local, "set");
  for (const changes of [
    { name: "  TARGET  " },
    { parentId: target.id },
    { name: "OTHER", parentId: target.id }
  ]) {
    assert.deepEqual(await cases.updateFolder(source.id, changes), {
      success: false, error: "已存在同名文件夹"
    });
  }
  assert.deepEqual(storage.data, before);
  assert.equal(writes.mock.callCount(), 0);
  assert.deepEqual(await cases.updateFolder(source.id, { name: "SOURCE" }), {
    success: true, folder: { ...source, name: "SOURCE" }
  });
});

test("folder updates validate plain patches, names and explicitly supplied parent ids", async context => {
  const { cases, storage } = await setup();
  const { folder } = await cases.createFolder("Source");
  const before = structuredClone(storage.data);
  const writes = context.mock.method(storage.local, "set");
  const invalidChanges = [
    undefined, null, [], "Renamed", 1, true, new Date(), new Map(), () => {},
    Object.create({ name: "Inherited" }),
    { id: "replacement" }, { createdAt: 0 }, { name: "Valid", extra: true },
    { [Symbol("extra")]: true },
    ...[undefined, null, 1, false, {}, [], new String("Name"), "", " \t\n ", "x".repeat(81)]
      .map(name => ({ name })),
    ...[undefined, 1, false, {}, [], "", " \t "].map(parentId => ({ parentId }))
  ];
  for (const changes of invalidChanges) {
    assert.deepEqual(await cases.updateFolder(folder.id, changes), {
      success: false, error: "文件夹更新参数无效"
    });
  }
  assert.deepEqual(storage.data, before);
  assert.equal(writes.mock.callCount(), 0);

  const changes = Object.assign(Object.create(null), { name: `  ${"x".repeat(80)}  ` });
  assert.deepEqual(await cases.updateFolder(folder.id, changes), {
    success: true, folder: { ...folder, name: "x".repeat(80) }
  });
});

test("folder updates reject missing folders and missing destinations without writing", async context => {
  const { cases, storage } = await setup();
  const { folder } = await cases.createFolder("Source");
  const before = structuredClone(storage.data);
  const writes = context.mock.method(storage.local, "set");
  for (const folderId of ["folder_missing", "", null, undefined, 1]) {
    assert.deepEqual(await cases.updateFolder(folderId, { name: "Renamed" }), {
      success: false, error: "文件夹不存在"
    });
  }
  assert.deepEqual(await cases.updateFolder(folder.id, { name: "Renamed", parentId: "folder_missing" }), {
    success: false, error: "文件夹不存在"
  });
  assert.deepEqual(storage.data, before);
  assert.equal(writes.mock.callCount(), 0);
});

test("folder updates refuse moves into themselves or any descendant", async context => {
  const { cases, storage } = await setup();
  const { folder: root } = await cases.createFolder("Root");
  const { folder: child } = await cases.createFolder("Child", root.id);
  const { folder: leaf } = await cases.createFolder("Leaf", child.id);
  const before = structuredClone(storage.data);
  const writes = context.mock.method(storage.local, "set");
  for (const parentId of [root.id, child.id, leaf.id]) {
    assert.deepEqual(await cases.updateFolder(root.id, { name: "Renamed", parentId }), {
      success: false, error: "不能将文件夹移入自身或其子文件夹"
    });
  }
  assert.deepEqual(storage.data, before);
  assert.equal(writes.mock.callCount(), 0);
});

test("folder moves enforce the depth limit on the entire subtree", async context => {
  const { cases, storage } = await setup();
  const { folder: root } = await cases.createFolder("Root");
  const { folder: child } = await cases.createFolder("Child", root.id);
  await cases.createFolder("Leaf", child.id);
  const { folder: target } = await cases.createFolder("Target");
  const { folder: targetChild } = await cases.createFolder("Target child", target.id);
  const before = structuredClone(storage.data);
  const writes = context.mock.method(storage.local, "set");
  for (const [folderId, parentId] of [[root.id, target.id], [child.id, targetChild.id]]) {
    assert.deepEqual(await cases.updateFolder(folderId, { parentId }), {
      success: false, error: "文件夹最多支持三级"
    });
  }
  assert.deepEqual(storage.data, before);
  assert.equal(writes.mock.callCount(), 0);
});

test("folder updates honor the writable gate, including unchanged and invalid patches", async context => {
  const folder = { id: "folder_source", name: "Source", parentId: null, createdAt: 1 };
  for (const [reason, error] of [["migration-failed", /升级尚未完成/], ["newer", /更新版本/]]) {
    const { cases, storage } = await setup({
      writable: false, reason, initial: { caseFolders: [folder] }
    });
    const before = structuredClone(storage.data);
    const reads = context.mock.method(storage.local, "get");
    const writes = context.mock.method(storage.local, "set");
    for (const changes of [{ name: "Renamed" }, {}, null]) {
      const result = await cases.updateFolder(folder.id, changes);
      assert.equal(result.success, false);
      assert.match(result.error, error);
    }
    assert.deepEqual(storage.data, before);
    assert.equal(reads.mock.callCount(), 0);
    assert.equal(writes.mock.callCount(), 0);
  }
});

test("unchanged folder updates return the folder without writing", async context => {
  const { cases, storage } = await setup();
  const { folder: root } = await cases.createFolder("Root");
  const { folder: child } = await cases.createFolder("Child", root.id);
  const before = structuredClone(storage.data);
  const writes = context.mock.method(storage.local, "set");
  const removals = context.mock.method(storage.local, "remove");
  for (const folder of [root, child]) {
    for (const changes of [
      {}, Object.create(null), { name: `  ${folder.name}  ` }, { parentId: folder.parentId },
      { name: folder.name, parentId: folder.parentId }
    ]) {
      assert.deepEqual(await cases.updateFolder(folder.id, changes), { success: true, folder });
    }
  }
  assert.deepEqual(storage.data, before);
  assert.equal(writes.mock.callCount(), 0);
  assert.equal(removals.mock.callCount(), 0);
});

test("batch deletion removes selected cases and clears an active workspace once", async () => {
  const { cases, storage, deleted } = await setup();
  seedWorkspace(storage, [action("s1", { screenshotKey: "screenshot:one" })]);
  const first = await cases.save("First");
  seedWorkspace(storage, [action("s2", { screenshotKey: "screenshot:two" })]);
  const second = await cases.save("Second");

  const removed = await cases.removeMany([first.case.id, second.case.id]);
  assert.equal(removed.success, true);
  assert.equal(removed.deletedCount, 2);
  assert.deepEqual(storage.data.caseIndex, []);
  assert.deepEqual(storage.data.actionOrder, []);
  assert.deepEqual(deleted.sort(), ["screenshot:one", "screenshot:two"]);
});

test("loading replaces the workspace and restores page numbering", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1"), action("s2", { pageName: "page3" })]);
  const saved = await cases.save("Login");
  seedWorkspace(storage, [action("other")]);

  const loaded = await cases.load(saved.case.id);
  assert.equal(loaded.success, true);
  assert.deepEqual(storage.data.actionOrder, ["s1", "s2"]);
  assert.equal(storage.data.activeCaseId, saved.case.id);
  // page3 is in use, so the next unseen document must not reuse page2 or page3.
  assert.equal(storage.data.nextPageNumber, 4);
  assert.deepEqual(storage.data.tabsMapping, {});
});

test("loading is refused while recording, and a missing case is reported", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1")]);
  const saved = await cases.save("Login");

  storage.data.isRecording = true;
  assert.match((await cases.load(saved.case.id)).error, /录制进行中/);

  storage.data.isRecording = false;
  assert.match((await cases.load("case_missing")).error, /用例不存在/);
});

test("an unreadable case is flagged in the index instead of failing repeatedly", async () => {
  const { cases, storage } = await setup({
    initial: {
      caseIndex: [{ id: "case_bad", name: "broken", createdAt: 5, stepCount: 2, readable: true }],
      "case:case_bad": { id: "case_bad", actions: null, pages: null }
    }
  });

  const loaded = await cases.load("case_bad");
  assert.equal(loaded.success, false);
  assert.match(loaded.error, /不兼容的旧版本/);
  assert.equal(storage.data.caseIndex[0].readable, false);
  assert.equal((await cases.list()).cases[0].readable, false);
});

test("getDetails is the only path that returns steps", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1"), action("s2")]);
  const saved = await cases.save("Login");

  const details = await cases.getDetails(saved.case.id);
  assert.equal(details.success, true);
  assert.equal(details.case.name, "Login");
  assert.deepEqual(details.case.actions.map(item => item.id), ["s1", "s2"]);
  assert.equal((await cases.getDetails("case_missing")).success, false);
});

test("deleting a case keeps screenshots the workspace still shows", async () => {
  const { cases, storage, deleted } = await setup();
  seedWorkspace(storage, [action("s1", { screenshotKey: "screenshot:shared" })]);
  const saved = await cases.save("Login");
  // The workspace moves on but keeps referencing the same screenshot.
  storage.data.activeCaseId = null;

  const removed = await cases.remove(saved.case.id);
  assert.equal(removed.success, true);
  assert.deepEqual(deleted, []);
  assert.equal(storage.data.caseIndex.length, 0);
  assert.equal(storage.data[`case:${saved.case.id}`], undefined);
  // Not the active case, so the open steps are left alone.
  assert.deepEqual(storage.data.actionOrder, ["s1"]);
});

test("deleting the active case clears the workspace and reclaims its screenshots", async () => {
  const { cases, storage, deleted } = await setup();
  seedWorkspace(storage, [action("s1", { screenshotKey: "screenshot:only" })]);
  const saved = await cases.save("Login");

  const removed = await cases.remove(saved.case.id);
  assert.equal(removed.success, true);
  assert.deepEqual(deleted, ["screenshot:only"]);
  assert.deepEqual(storage.data.actionOrder, []);
  assert.equal(storage.data.activeCaseId, null);
  assert.equal(storage.data.nextPageNumber, 1);
});

test("creating a new case banks the open steps first", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("s1")]);

  assert.equal((await cases.createNew()).success, true);
  assert.equal(storage.data.caseIndex.length, 1);
  assert.deepEqual(storage.data.actionOrder, []);
  assert.equal(storage.data.activeCaseId, null);
});

test("an unwritable store refuses to modify cases but still reads them", async () => {
  const { cases, storage } = await setup({
    writable: false,
    initial: {
      schemaVersion: 1,
      caseIndex: undefined,
      cases: [{
        id: "case_a",
        name: "Legacy",
        createdAt: 5,
        stepCount: 1,
        actions: [action("s1")],
        pages: [{ name: "page1", url: "", title: "" }]
      }]
    }
  });
  seedWorkspace(storage, [action("s9")]);

  const saved = await cases.save("New");
  assert.equal(saved.success, false);
  assert.match(saved.error, /升级尚未完成/);
  assert.match((await cases.remove("case_a")).error, /升级尚未完成/);
  // The open steps survive: nothing may be discarded that could not be banked.
  assert.deepEqual(storage.data.actionOrder, ["s9"]);
  assert.match((await cases.createNew()).error, /升级尚未完成/);

  // Reading keeps working off the layout that is actually on disk.
  const listed = await cases.list();
  assert.deepEqual(listed.cases.map(item => item.name), ["Legacy"]);
  assert.equal((await cases.getDetails("case_a")).case.actions.length, 1);
});

test("a store written by a newer build reports a different reason", async () => {
  const { cases, storage } = await setup({ writable: false, reason: "newer" });
  seedWorkspace(storage, [action("s1")]);
  assert.match((await cases.save("New")).error, /更新版本/);
});

test("a deletion preview counts both frames of every step", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, []);
  seedCase(storage, {
    id: "case_pair",
    actions: [action("s1", { screenshotBeforeKey: "shot:before", screenshotKey: "shot:after" })]
  });

  const preview = await cases.previewRemoval(["case_pair"]);

  assert.equal(preview.success, true);
  assert.equal(preview.caseCount, 1);
  assert.equal(preview.stepCount, 1);
  assert.equal(preview.screenshotCount, 2);
  assert.equal(preview.deletableScreenshotCount, 2);
});

test("a deletion preview counts the screenshots nobody else would keep", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, []);
  seedCase(storage, {
    id: "case_root",
    actions: [
      action("r1", { screenshotKey: "shot:r1" }),
      action("r2", { screenshotKey: "shot:r2" })
    ]
  });
  // A continuation reuses the inherited steps' keys, which is what makes deleting
  // it free far less than the case's own total.
  seedCase(storage, {
    id: "case_child",
    lineage: { parentCaseId: "case_root" },
    actions: [
      action("r1", { screenshotKey: "shot:r1" }),
      action("r2", { screenshotKey: "shot:r2" }),
      action("c1", { screenshotKey: "shot:c1" })
    ]
  });

  const preview = await cases.previewRemoval(["case_child"]);

  assert.equal(preview.stepCount, 3);
  assert.equal(preview.screenshotCount, 3);
  assert.equal(preview.deletableScreenshotCount, 1);
});

test("screenshots the open workspace still shows are not counted as freed", async () => {
  const { cases, storage } = await setup();
  // Loading a case puts its steps, screenshot keys included, into the workspace.
  seedWorkspace(storage, [action("s1", { screenshotKey: "shot:held" })]);
  seedCase(storage, { id: "case_loaded", actions: [action("s1", { screenshotKey: "shot:held" })] });

  const preview = await cases.previewRemoval(["case_loaded"]);

  assert.equal(preview.screenshotCount, 1);
  assert.equal(preview.deletableScreenshotCount, 0);
});

test("deleting several cases together frees what none of them keeps", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, []);
  seedCase(storage, { id: "case_a", actions: [action("a1", { screenshotKey: "shot:shared" })] });
  seedCase(storage, { id: "case_b", actions: [action("b1", { screenshotKey: "shot:shared" })] });

  const preview = await cases.previewRemoval(["case_a", "case_b"]);

  assert.equal(preview.caseCount, 2);
  assert.equal(preview.stepCount, 2);
  assert.equal(preview.deletableScreenshotCount, 1);
});

test("a deletion preview refuses an empty or unknown selection", async () => {
  const { cases } = await setup();

  assert.equal((await cases.previewRemoval([])).success, false);
  assert.equal((await cases.previewRemoval(["case_missing"])).success, false);
});

test("an unreadable-case query cannot overwrite a concurrent case save", async () => {
  const { createSerialQueue } = await import("../background/queue.js");
  const { cases, storage } = await setup({ queueCaseWrite: createSerialQueue("Test Cases") });
  seedCase(storage, { id: "damaged", actions: [] });
  delete storage.data["case:damaged"];
  seedWorkspace(storage, [action("new-step")]);
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const saving = new Promise(resolve => { started = resolve; });
  const set = storage.local.set;
  storage.local.set = async values => {
    if (values.caseIndex?.some(entry => entry.name === "New")) {
      started();
      await gate;
    }
    return set(values);
  };
  const save = cases.save("New");
  await saving;
  const query = cases.getDetails("damaged");
  // Let the query reach its write-back while the save still owns the queue.
  await new Promise(setImmediate);
  assert.equal(storage.data.caseIndex.find(entry => entry.id === "damaged").readable, true);
  release();
  assert.equal((await save).success, true);
  assert.equal((await query).success, false);
  assert.equal(storage.data.caseIndex.find(entry => entry.id === "damaged").readable, false);
  assert.equal(storage.data.caseIndex.filter(entry => entry.name === "New").length, 1);
});


test("renaming preserves case content, placement and workspace while updating its current name", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("rename-step", { screenshotKey: "shot:rename" })]);
  const folder = await cases.createFolder("Saved flows");
  const saved = await cases.save("Original", false, folder.folder.id);
  const before = structuredClone(storage.data);
  const result = await cases.rename(saved.case.id, "  New name  ");
  assert.equal(result.success, true);
  assert.equal((await cases.getDetails(saved.case.id)).case.name, "New name");
  assert.equal(storage.data.workspaceOrigin.caseNameSnapshot, "New name");
  const expected = structuredClone(before);
  expected.caseIndex[0].name = "New name";
  expected.workspaceOrigin.caseNameSnapshot = "New name";
  assert.deepEqual(storage.data, expected);
  for (const invalid of ["", "   ", "x".repeat(121), null]) {
    assert.equal((await cases.rename(saved.case.id, invalid)).success, false);
    assert.deepEqual(storage.data, expected);
  }
  assert.equal((await cases.rename("missing", "Another name")).success, false);
  assert.deepEqual(storage.data, expected);
});

test("renaming is refused when the case store is read only", async () => {
  const { cases, storage } = await setup({ writable: false });
  seedCase(storage, { id: "read-only", actions: [action("step")] });
  const before = structuredClone(storage.data);
  assert.equal((await cases.rename("read-only", "Changed")).success, false);
  assert.deepEqual(storage.data, before);
});


test("saving rejects overlong and non-text names before changing storage", async () => {
  const { cases, storage } = await setup();
  seedWorkspace(storage, [action("name-limit")]);
  const before = structuredClone(storage.data);
  for (const name of ["x".repeat(121), 123, { name: "invalid" }]) {
    assert.equal((await cases.save(name)).success, false);
    assert.deepEqual(storage.data, before);
  }
  assert.equal((await cases.save("x".repeat(120))).success, true);
});
