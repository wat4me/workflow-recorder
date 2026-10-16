const assert = require("node:assert/strict");
const test = require("node:test");

async function setup(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  const tabs = [1, 2, 3, 4].map(id => ({ id, title: `Page ${id}`, url: `https://page${id}.test/` }));
  globalThis.chrome = {
    tabs: { get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw new Error("Closed tab"); return tab; }, query: async () => tabs },
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in data).map(key => [key, structuredClone(data[key])])),
      set: async values => { writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); },
      remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; }
    } }
  };
  const { createDraftManager, readDraftMediaKeys } = await import("../background/store/drafts.js");
  const actions = await import("../background/store/actions.js");
  let stops = 0;
  const drafts = createDraftManager({ queueCaseWrite: callback => callback(), drainRegistrations: async () => {}, notifyStepsUpdated: () => {},
    session: { toggle: async () => {
      stops++;
      data.resumableScope = { tabIds: data.recordingTabIds || [], tabsMapping: data.tabsMapping || {} };
      Object.assign(data, { isRecording: false, recordingTabIds: [], tabsMapping: {} });
    } } });
  return { data, writes, tabs, drafts, actions, readDraftMediaKeys, stops: () => stops };
}

test("A/B/C keep separate durable steps, frames, numbering and origin without auto-saving cases", async () => {
  const h = await setup();
  const a = await h.drafts.activate(1);
  await h.actions.appendAction({ id: "a", screenshotKey: "after-a", screenshotBeforeKey: "before-a" });
  Object.assign(h.data, { isRecording: true, recordingTabIds: [1, 4], tabsMapping: { 1: "page1", 4: "page2" }, nextPageNumber: 3 });
  const b = await h.drafts.activate(2);
  assert.equal(h.stops(), 1);
  assert.deepEqual(await h.actions.readActions(), []);
  assert.equal(h.data.caseIndex, undefined, "switching drafts is not a saved-case operation");
  await h.actions.appendAction({ id: "b", screenshotKey: "after-b" });
  await h.drafts.activate(3);
  await h.actions.appendAction({ id: "c" });
  assert.deepEqual((await h.drafts.read(1)).actions.map(action => action.id), ["a"]);
  assert.deepEqual((await h.drafts.read(2)).actions.map(action => action.id), ["b"]);
  assert.deepEqual([...await h.readDraftMediaKeys()].sort(), ["after-a", "after-b", "before-a"]);
  assert.equal((await h.drafts.activate(4)).draftId, a.draftId, "a child resumes its parent's draft");
  assert.equal(h.data.isRecording, false);
  assert.equal(h.data.nextPageNumber, 3);
  assert.deepEqual(h.data.resumableScope.tabIds, [1, 4]);
  assert.deepEqual((await h.actions.readActions()).map(action => action.id), ["a"]);
  const commit = h.writes.findLast(write => write.activeRecordingDraftId === a.draftId);
  assert.deepEqual(commit.actionOrder, ["a"], "draft pointer, metadata and steps commit together");
  assert.equal(commit["action:a"].screenshotKey, "after-a");
  await assert.rejects(h.drafts.assertActive(b.draftId), /草稿已切换/);
});

test("opening a child while its parent is recording never pauses or forks it", async () => {
  const h = await setup();
  const a = await h.drafts.activate(1);
  Object.assign(h.data, { isRecording: true, recordingTabIds: [1, 4] });
  const child = await h.drafts.activate(4);
  assert.equal(child.draftId, a.draftId);
  assert.equal(child.switched, false);
  assert.equal(h.stops(), 0);
  assert.equal(h.data.isRecording, true);
  assert.deepEqual(h.data.recordingDraftIndex[0].tabIds, [1, 4]);
});

test("legacy single workspace is adopted by its source tab instead of carried into B", async () => {
  const h = await setup({ actionOrder: ["legacy"], "action:legacy": { id: "legacy", url: "https://page1.test/", title: "Old A" }, nextPageNumber: 2 });
  await h.drafts.activate(2);
  assert.deepEqual(await h.actions.readActions(), []);
  assert.deepEqual((await h.drafts.read(1)).actions.map(action => action.id), ["legacy"]);
  await h.drafts.activate(1);
  assert.equal(h.data.nextPageNumber, 2);
});

test("failed draft publication and unreadable snapshots leave the active steps intact", async () => {
  const h = await setup();
  const a = await h.drafts.activate(1);
  await h.actions.appendAction({ id: "a" });
  const original = chrome.storage.local.set;
  chrome.storage.local.set = async values => {
    if (values.activeRecordingDraftId && values.activeRecordingDraftId !== a.draftId) throw new Error("storage denied");
    return original(values);
  };
  await assert.rejects(h.drafts.activate(2), /storage denied/);
  assert.equal(h.data.activeRecordingDraftId, a.draftId);
  assert.deepEqual((await h.actions.readActions()).map(action => action.id), ["a"]);
  chrome.storage.local.set = original;
  const b = await h.drafts.activate(2);
  await h.actions.appendAction({ id: "b" });
  h.data[`recordingDraft:${a.draftId}`] = null;
  await assert.rejects(h.drafts.activate(1), /不可读取/);
  assert.equal(h.data.activeRecordingDraftId, b.draftId);
  assert.deepEqual((await h.actions.readActions()).map(action => action.id), ["b"]);
});

test("closed tabs and browser restart unbind tab IDs while drafts remain recoverable", async () => {
  const h = await setup();
  const a = await h.drafts.activate(1);
  await h.actions.appendAction({ id: "a" });
  Object.assign(h.data, { resumableScope: { tabIds: [1, 4], tabsMapping: { 1: "page1", 4: "page2" } } });
  await h.drafts.activate(2);
  await h.drafts.unbind(1);
  assert.deepEqual((await h.drafts.read(1)).actions, []);
  assert.ok(h.data[`recordingDraft:${a.draftId}`]);
  await h.drafts.unbind();
  assert.ok(h.data.recordingDraftIndex.every(entry => !entry.tabIds.length));
  await h.drafts.activate(3, a.draftId);
  assert.deepEqual((await h.actions.readActions()).map(action => action.id), ["a"]);
  assert.deepEqual(h.data.resumableScope?.tabIds || [], []);
});

test("recreating the worker restores inactive draft data and invalidates deleted saved-case state", async () => {
  const h = await setup({ caseIndex: [{ id: "case-a" }] });
  const a = await h.drafts.activate(1);
  await h.actions.appendAction({ id: "a" });
  Object.assign(h.data, { activeCaseId: "case-a", workspaceOrigin: { caseId: "case-a", caseNameSnapshot: "Saved A" } });
  await h.drafts.activate(2);
  h.data.caseIndex = [];
  const resumed = await setup(h.data);
  assert.equal((await resumed.drafts.activate(1)).draftId, a.draftId);
  assert.deepEqual((await resumed.actions.readActions()).map(action => action.id), ["a"]);
  assert.equal(resumed.data.activeCaseId, null);
  assert.equal(resumed.data.workspaceOrigin.deleted, true);
});

test("inactive draft frames survive reference-aware cleanup but clearing the live draft frees its frames", async () => {
  const h = await setup();
  const a = await h.drafts.activate(1);
  await h.actions.appendAction({ id: "a", screenshotKey: "after-a", screenshotBeforeKey: "before-a" });
  await h.drafts.activate(2);
  await h.actions.appendAction({ id: "b", screenshotKey: "after-b" });
  const deleted = [];
  const { createMediaCleanupManager } = await import("../background/store/media-cleanup.js");
  const cleanup = createMediaCleanupManager({ mediaStore: { deleteBlobs: async keys => deleted.push(...keys) } });
  await cleanup.deleteUnreferenced(["after-a", "before-a", "after-b", "orphan"]);
  assert.deepEqual(deleted, ["orphan"]);
  await h.drafts.activate(1);
  await h.actions.clearActions();
  await cleanup.deleteUnreferenced(["after-a", "before-a", "after-b"]);
  assert.deepEqual(deleted.sort(), ["after-a", "before-a", "orphan"]);
  assert.equal(h.data.activeRecordingDraftId, a.draftId);
});
