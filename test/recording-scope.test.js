const assert = require("node:assert/strict");
const test = require("node:test");

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    local: {
      get: async keys => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter(key => key in data).map(key => [key, data[key]]));
      },
      set: async values => { Object.assign(data, values); },
      remove: async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      }
    }
  };
}

async function createScope({ storage, tabs = {} }) {
  globalThis.chrome = {
    runtime: { getURL: prefix => `chrome-extension://recorder/${prefix}` },
    storage: { local: storage.local },
    tabs: {
      get: async tabId => {
        if (!tabs[tabId]) throw new Error(`No tab with id ${tabId}`);
        return tabs[tabId];
      }
    }
  };
  const { createRecordingScope } = await import("../background/recording/scope.js");
  return createRecordingScope({ screencast: { start: async () => {} } });
}

test("pausing keeps the covered tabs as the handle for continuing", async () => {
  const storage = createStorage({
    isRecording: true,
    recordingTabIds: [1, 2],
    tabsMapping: { 1: "page1", 2: "page2" },
    nextPageNumber: 3
  });
  const scope = await createScope({ storage });

  await scope.clearScope();

  assert.equal(storage.data.isRecording, false);
  assert.deepEqual(storage.data.recordingTabIds, []);
  assert.deepEqual(storage.data.tabsMapping, {});
  assert.deepEqual(storage.data.resumableScope, {
    tabIds: [1, 2],
    tabsMapping: { 1: "page1", 2: "page2" }
  });
});

test("the cleanup after a failed start does not erase the paused session", async () => {
  const paused = { tabIds: [1], tabsMapping: { 1: "page1" } };
  const storage = createStorage({
    isRecording: false,
    recordingTabIds: [],
    tabsMapping: {},
    resumableScope: paused
  });
  const scope = await createScope({ storage });

  await scope.clearScope();

  assert.deepEqual(storage.data.resumableScope, paused);
});

test("continuing re-adopts the paused tabs with the handles their steps use", async () => {
  const storage = createStorage({
    isRecording: false,
    nextPageNumber: 4,
    resumableScope: {
      tabIds: [1, 2, 3, 4],
      tabsMapping: { 1: "page1", 2: "page2", 3: "page3", 4: "page4" }
    }
  });
  const scope = await createScope({
    storage,
    tabs: {
      1: { id: 1, url: "https://one.test/" },
      2: { id: 2, url: "https://two.test/" },
      // 3 was closed while the recording was paused.
      4: { id: 4, url: "chrome://extensions" }
    }
  });

  const tabs = await scope.resumeTabs(
    { id: 1, url: "https://one.test/" },
    { fallbackPageName: "page2", nextPageNumber: 4 }
  );

  assert.deepEqual(tabs.map(tab => tab.id), [1, 2]);
  assert.deepEqual(storage.data.recordingTabIds, [1, 2]);
  assert.deepEqual(storage.data.tabsMapping, { 1: "page1", 2: "page2" });
  assert.equal(storage.data.nextPageNumber, 4);
});

test("a tab the paused session never tracked cannot take a live page handle", async () => {
  const storage = createStorage({
    isRecording: false,
    nextPageNumber: 3,
    resumableScope: { tabIds: [1, 2], tabsMapping: { 1: "page1", 2: "page2" } }
  });
  const scope = await createScope({
    storage,
    tabs: {
      1: { id: 1, url: "https://one.test/" },
      2: { id: 2, url: "https://two.test/" }
    }
  });

  await scope.resumeTabs(
    { id: 9, url: "https://fresh.test/" },
    { fallbackPageName: "page2", nextPageNumber: 3 }
  );

  assert.deepEqual(storage.data.recordingTabIds, [9, 1, 2]);
  assert.deepEqual(storage.data.tabsMapping, { 1: "page1", 2: "page2", 9: "page3" });
  assert.equal(storage.data.nextPageNumber, 4);
});

test("the page the workspace ended on is reused when no live tab claims it", async () => {
  const storage = createStorage({
    isRecording: false,
    nextPageNumber: 3,
    resumableScope: { tabIds: [1], tabsMapping: { 1: "page1" } }
  });
  const scope = await createScope({ storage, tabs: { 1: { id: 1, url: "https://one.test/" } } });

  await scope.resumeTabs(
    { id: 9, url: "https://fresh.test/" },
    { fallbackPageName: "page2", nextPageNumber: 3 }
  );

  assert.deepEqual(storage.data.tabsMapping, { 1: "page1", 9: "page2" });
  assert.equal(storage.data.nextPageNumber, 3);
});

test("a fresh recording drops the paused session's tabs", async () => {
  const storage = createStorage({
    isRecording: false,
    resumableScope: { tabIds: [7], tabsMapping: { 7: "page1" } }
  });
  const scope = await createScope({ storage, tabs: { 7: { id: 7, url: "https://old.test/" } } });

  const tabs = await scope.bindRootTab(
    { id: 5, url: "https://fresh.test/" },
    { pageName: "page1", nextPageNumber: 2 }
  );

  assert.deepEqual(tabs.map(tab => tab.id), [5]);
  assert.deepEqual(storage.data.recordingTabIds, [5]);
  assert.deepEqual(storage.data.tabsMapping, { 5: "page1" });
  assert.equal(storage.data.resumableScope, undefined);

  const resumed = await scope.resumeTabs(
    { id: 5, url: "https://fresh.test/" },
    { fallbackPageName: "page1", nextPageNumber: 2 }
  );
  assert.deepEqual(resumed.map(tab => tab.id), [5]);
  assert.equal(storage.data.nextPageNumber, 2);
});
