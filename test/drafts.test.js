const assert = require("node:assert/strict");
const test = require("node:test");

async function setup(initial = {}, options = {}) {
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
    } }, ...options });
  return { data, writes, tabs, drafts, actions, readDraftMediaKeys, stops: () => stops };
}

function seedRetainedDrafts(count, activeNumber = count) {
  const data = { activeRecordingDraftId: `draft-${activeNumber}`, actionOrder: ["live-step"],
    "action:live-step": { id: "live-step", type: "click" }, recordingDraftIndex: [] };
  for (let number = 1; number <= count; number++) {
    const id = `draft-${number}`;
    data.recordingDraftIndex.push({ id, tabIds: [], stepCount: 1, savedCaseId: null, updatedAt: number });
    if (number !== activeNumber) {
      data[`recordingDraft:${id}`] = { actions: [{ id: `step-${number}`, screenshotKey: `image-${number}` }], state: {} };
      data[`recordingDraftMedia:${id}`] = [`image-${number}`];
    }
  }
  return data;
}

test("retention keeps ten unsaved recordings and discards the oldest content and media references", async () => {
  const cleaned = [];
  const initial = seedRetainedDrafts(11);
  initial.recordingDraftIndex[0].updatedAt = Date.now();
  const h = await setup(initial, { deleteScreenshots: async keys => cleaned.push(...keys) });
  assert.equal((await h.drafts.enforceLimit()).discardedCount, 1);
  assert.equal(h.data.recordingDraftIndex.length, 10);
  assert.equal(h.data.recordingDraftIndex[0].id, "draft-2");
  assert.equal(h.data["recordingDraft:draft-1"], undefined);
  assert.equal(h.data["recordingDraftMedia:draft-1"], undefined);
  assert.deepEqual(cleaned, ["image-1"]);
  assert.equal(h.data.activeRecordingDraftId, "draft-11");
  assert.deepEqual((await h.actions.readActions()).map(action => action.id), ["live-step"]);
  assert.equal((await h.drafts.enforceLimit()).discardedCount, 0);
});

test("retention protects the open recording even when it is oldest and recording is active", async () => {
  const h = await setup({ ...seedRetainedDrafts(12, 1), isRecording: true });
  assert.equal((await h.drafts.enforceLimit()).discardedCount, 2);
  assert.equal(h.data.recordingDraftIndex.length, 10);
  assert.equal(h.data.recordingDraftIndex[0].id, "draft-1");
  assert.equal(h.data["recordingDraft:draft-2"], undefined);
  assert.equal(h.data["recordingDraft:draft-3"], undefined);
  assert.equal(h.data.isRecording, true);
  assert.equal(h.stops(), 0);
});

test("empty and saved drafts do not consume retention slots, and shared case media stays safe", async () => {
  const initial = seedRetainedDrafts(11);
  initial.caseIndex = [{ id: "saved-case" }];
  initial["case:saved-case"] = { actions: [{ id: "saved-step", screenshotKey: "image-1" }], pages: [] };
  initial["caseMedia:saved-case"] = ["image-1"];
  initial.recordingDraftIndex.unshift({ id: "empty", stepCount: 0 }, { id: "saved", stepCount: 1, savedCaseId: "saved-case" });
  initial["recordingDraft:saved"] = { actions: [{ id: "saved-step", screenshotKey: "image-1" }], state: { activeCaseId: "saved-case" } };
  initial["recordingDraftMedia:saved"] = ["image-1"];
  const deleted = [];
  const h = await setup(initial, { deleteScreenshots: keys => cleanup.deleteUnreferenced(keys) });
  const { createMediaCleanupManager } = await import("../background/store/media-cleanup.js");
  const cleanup = createMediaCleanupManager({ mediaStore: { deleteBlobs: async keys => deleted.push(...keys) } });
  await h.drafts.enforceLimit();
  assert.equal((await h.drafts.read()).drafts.filter(draft => draft.hasUnsavedChanges).length, 10);
  assert.equal(h.data.recordingDraftIndex.length, 12);
  assert.deepEqual(deleted, [], "a saved case still references the discarded draft's screenshot");
  assert.deepEqual(h.data["case:saved-case"], initial["case:saved-case"]);
  assert.ok(h.data["recordingDraft:saved"]);
});

test("an empty eleventh draft causes no eviction until it gains a recorded step", async () => {
  const initial = seedRetainedDrafts(11);
  initial.actionOrder = [];
  delete initial["action:live-step"];
  const h = await setup(initial);
  assert.equal((await h.drafts.enforceLimit()).discardedCount, 0);
  await h.actions.appendAction({ id: "new-step" });
  assert.equal((await h.drafts.enforceLimit()).discardedCount, 1);
  assert.equal(h.data.activeRecordingDraftId, "draft-11");
  assert.deepEqual((await h.actions.readActions()).map(action => action.id), ["new-step"]);
});

test("a failed retention commit leaves every draft and its content intact", async () => {
  const h = await setup(seedRetainedDrafts(11));
  const before = structuredClone(h.data);
  const original = chrome.storage.local.set;
  chrome.storage.local.set = async values => {
    if (values.pendingRecordingDraftRemovals?.length) throw new Error("storage denied");
    return original(values);
  };
  await assert.rejects(h.drafts.enforceLimit(), /storage denied/);
  assert.deepEqual(h.data, before);
});

test("a worker restart finishes an interrupted eviction without touching the current recording", async () => {
  const h = await setup(seedRetainedDrafts(11));
  const original = chrome.storage.local.remove;
  chrome.storage.local.remove = async () => { throw new Error("worker stopped"); };
  await assert.rejects(h.drafts.enforceLimit(), /worker stopped/);
  assert.equal(h.data.recordingDraftIndex.length, 10, "the index is committed before content is deleted");
  assert.ok(h.data["recordingDraft:draft-1"]);
  chrome.storage.local.remove = original;
  const cleaned = [];
  const resumed = await setup(h.data, { deleteScreenshots: async keys => cleaned.push(...keys) });
  await resumed.drafts.enforceLimit();
  assert.equal(resumed.data["recordingDraft:draft-1"], undefined);
  assert.deepEqual(cleaned, ["image-1"]);
  assert.deepEqual(resumed.data.pendingRecordingDraftRemovals, []);
  assert.equal(resumed.data.activeRecordingDraftId, "draft-11");
  assert.deepEqual((await resumed.actions.readActions()).map(action => action.id), ["live-step"]);
});

test("retention also handles old drafts with no indexed saved-case marker or media list", async () => {
  const initial = seedRetainedDrafts(11);
  for (const entry of initial.recordingDraftIndex) delete entry.savedCaseId;
  delete initial["recordingDraftMedia:draft-1"];
  const cleaned = [];
  const h = await setup(initial, { deleteScreenshots: async keys => cleaned.push(...keys) });
  await h.drafts.enforceLimit();
  assert.equal(h.data.recordingDraftIndex.length, 10);
  assert.equal(h.data["recordingDraft:draft-1"], undefined);
  assert.deepEqual(cleaned, ["image-1"], "legacy snapshot keys are reclaimed too");
});

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

test("continuing an unchanged saved recording is excluded until a step is changed", async () => {
  const h = await setup({ caseIndex: [{ id: "saved-a" }] });
  const { originFor } = await import("../background/store/workspace-origin.js");
  const a = await h.drafts.activate(1);
  const action = { id: "a", type: "type", value: "saved value" };
  await h.actions.appendAction(action);
  h.data.workspaceOrigin = originFor({ id: "saved-a", name: "Saved A" }, [action]);
  h.data.activeCaseId = null;
  assert.equal((await h.drafts.read(1)).drafts[0].hasUnsavedChanges, false);
  await h.drafts.activate(2);
  assert.equal((await h.drafts.read(2)).drafts.find(item => item.id === a.draftId).hasUnsavedChanges, false);
  await h.drafts.activate(1);
  await h.actions.patchAction("a", { value: "changed value" });
  assert.equal((await h.drafts.read(1)).drafts.find(item => item.id === a.draftId).hasUnsavedChanges, true);
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

test("recovery counts nonempty unsaved recordings and excludes saved baselines", async () => {
  const h = await setup({ caseIndex: [{ id: "saved-a" }] });
  const a = await h.drafts.activate(1);
  assert.equal((await h.drafts.read(1)).drafts.filter(item => item.hasUnsavedChanges).length, 0);
  await h.actions.appendAction({ id: "a" });
  await h.drafts.activate(2);
  assert.deepEqual((await h.drafts.read(2)).drafts.filter(item => item.hasUnsavedChanges).map(item => item.id), [a.draftId]);
  await h.actions.appendAction({ id: "b" });
  assert.equal((await h.drafts.read(2)).drafts.filter(item => item.hasUnsavedChanges).length, 2);
  await h.drafts.activate(1);
  h.data.activeCaseId = "saved-a";
  assert.equal((await h.drafts.read(1)).drafts.find(item => item.id === a.draftId).hasUnsavedChanges, false);
  await h.drafts.activate(3);
  assert.equal((await h.drafts.read(3)).drafts.find(item => item.id === a.draftId).hasUnsavedChanges, false);
  h.data.caseIndex = [];
  assert.equal((await h.drafts.read(3)).drafts.find(item => item.id === a.draftId).hasUnsavedChanges, true,
    "deleting the saved case makes the retained steps recoverable again");
});

test("existing drafts without recovery metadata are classified without rewriting their contents", async () => {
  const h = await setup({
    caseIndex: [{ id: "saved-a" }], activeRecordingDraftId: "live",
    recordingDraftIndex: [
      { id: "old-saved", tabIds: [1], stepCount: 1 },
      { id: "old-unsaved", tabIds: [2], stepCount: 2 },
      { id: "live", tabIds: [3], stepCount: 0 }
    ],
    "recordingDraft:old-saved": { actions: [{ id: "saved-step" }], state: { activeCaseId: "saved-a" } },
    "recordingDraft:old-unsaved": { actions: [{ id: "first" }, { id: "second" }], state: {} }
  });
  const before = structuredClone(h.data);
  const state = await h.drafts.read(3);
  assert.deepEqual(state.drafts.filter(item => item.hasUnsavedChanges).map(item => item.id), ["old-unsaved"]);
  assert.deepEqual(h.data, before, "reading legacy summaries preserves the saved snapshots");
  await h.drafts.activate(3, "old-unsaved");
  assert.deepEqual((await h.actions.readActions()).map(action => action.id), ["first", "second"]);
  assert.equal(h.data.caseIndex.length, 1, "recovery does not create saved cases");
});
