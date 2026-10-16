/** Only the first root page of a fresh recording is a lifecycle step. */
const assert = require("node:assert/strict");
const test = require("node:test");

function createStorage() {
  const data = {
    isRecording: true,
    recordingTabIds: [1, 2],
    tabsMapping: { 1: "page1" },
    nextPageNumber: 2,
    actionOrder: []
  };
  return {
    data,
    local: {
      get(keys) {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) {
          if (Object.hasOwn(data, key)) result[key] = structuredClone(data[key]);
        }
        return Promise.resolve(result);
      },
      set(values) {
        Object.assign(data, structuredClone(values));
        return Promise.resolve();
      },
      remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        return Promise.resolve();
      }
    }
  };
}

async function setup(scope = {}) {
  const storage = createStorage();
  globalThis.chrome = { storage, i18n: { getUILanguage: () => "en-US" } };
  const { createActionLog } = await import(`../background/recording/action-log.js?t=${Math.random()}`);
  const scheduled = [];
  const actionLog = createActionLog({
    t: (key, substitutions, fallback) => fallback,
    scope,
    screenshots: {
      snapshotFrameData: () => null,
      beforeKeyFor: id => `before:${id}`,
      storeFrameBlob: async () => null,
      schedule: id => scheduled.push(id)
    },
    mediaCleanup: { deleteUnreferenced: async () => ({ pending: false }) },
    notifyStepsUpdated: () => {}
  });
  return { actionLog, scheduled, storage };
}

const rootTab = { id: 1, url: "https://example.test/login", title: "Login" };
const childTab = { id: 2, url: "https://example.test/home", title: "Home" };

test("the fresh root page is recorded once", async () => {
  const { actionLog, scheduled, storage } = await setup();
  await actionLog.log({ id: "open", type: "navigate", url: rootTab.url, title: rootTab.title }, rootTab);

  assert.deepEqual(storage.data.actionOrder, ["open"]);
  assert.equal(storage.data["action:open"].pageName, "page1");
  assert.deepEqual(scheduled, ["open"]);
});

test("redirects, reloads and child-page opens are not recorded", async () => {
  const { actionLog, scheduled, storage } = await setup();
  await actionLog.log({ id: "open", type: "navigate", url: rootTab.url, title: rootTab.title }, rootTab);
  await actionLog.log({ id: "redirect", type: "navigate", url: "https://example.test/home" }, rootTab);
  await actionLog.log({ id: "reload", type: "navigate", url: "https://example.test/home" }, rootTab);
  await actionLog.log({ id: "child-open", type: "navigate", url: childTab.url }, childTab);

  assert.deepEqual(storage.data.actionOrder, ["open"]);
  assert.deepEqual(scheduled, ["open"]);
  assert.equal(storage.data.tabsMapping[2], "page2");
});

test("a destroyed click frame still waits for the resulting navigation", async () => {
  const { actionLog, storage } = await setup({
    waitForBrowserContextChange: async () => null,
    findBrowserContextChange: () => null
  });
  let reads = 0;
  chrome.tabs = {
    sendMessage: async () => { throw new Error("Message port closed"); },
    get: async () => ({ ...rootTab, url: ++reads >= 3 ? "https://example.test/home" : rootTab.url })
  };
  const result = await actionLog.logClick({
    payload: { id: "login", type: "click", url: rootTab.url, timestamp: Date.now() }
  }, { tab: rootTab, frameId: 0 });
  assert.equal(result.ignored, undefined);
  assert.deepEqual(storage.data.actionOrder, ["login"]);
});

test("a close control inside a removed iframe records without top-level navigation", async () => {
  const { actionLog, storage } = await setup({ waitForBrowserContextChange: async () => null, findBrowserContextChange: () => null });
  chrome.tabs = { get: async () => rootTab, sendMessage: async () => { throw new Error("Frame was removed"); } };
  chrome.webNavigation = { getAllFrames: async () => [{ frameId: 0, documentId: "top" }] };
  const result = await actionLog.logClick({ payload: { id: "close-frame", type: "click", url: "https://example.test/dialog" } },
    { tab: rootTab, frameId: 7, documentId: "dialog-doc" });
  assert.equal(result.ignored, undefined);
  assert.equal(storage.data["action:close-frame"].frameClosedAfterClick, true);
  assert.equal(storage.data["action:close-frame"].openedChildPage, undefined);
});

test("iframe navigation records a distinct outcome from iframe removal", async () => {
  const { actionLog, storage } = await setup({ waitForBrowserContextChange: async () => null, findBrowserContextChange: () => null });
  chrome.tabs = { get: async () => rootTab, sendMessage: async () => { throw new Error("Document was replaced"); } };
  chrome.webNavigation = { getAllFrames: async () => [{ frameId: 0 }, { frameId: 7, documentId: "new-doc" }] };
  await actionLog.logClick({ payload: { id: "frame-nav", type: "click", url: "https://example.test/dialog" } },
    { tab: rootTab, frameId: 7, documentId: "old-doc" });
  assert.equal(storage.data["action:frame-nav"].frameClosedAfterClick, undefined);
  assert.equal(storage.data["action:frame-nav"].frameNavigatedAfterClick, true);
});

test("a stalled browser frame query cannot block a DOM-validated click", { timeout: 3000 }, async () => {
  const { actionLog, storage } = await setup({ waitForBrowserContextChange: async () => null, findBrowserContextChange: () => null });
  chrome.tabs = { get: async () => rootTab, sendMessage: async () => ({ changed: true }) };
  chrome.webNavigation = { getAllFrames: () => new Promise(() => {}) };
  await actionLog.logClick({ payload: { id: "frame-effect", type: "click", url: "https://example.test/dialog" } },
    { tab: rootTab, frameId: 7, documentId: "dialog-doc" });
  assert.deepEqual(storage.data.actionOrder, ["frame-effect"]);
  assert.equal(storage.data["action:frame-effect"].frameClosedAfterClick, undefined);
});

test("missing browser frame information cannot turn an inert iframe click into a close", async () => {
  for (const result of [null, [], [{ frameId: 0 }, { frameId: 7, documentId: "same-doc" }], "error"]) {
    const { actionLog, storage } = await setup({ waitForBrowserContextChange: async () => null, findBrowserContextChange: () => null });
    chrome.tabs = { get: async () => rootTab, sendMessage: async () => ({ changed: false }) };
    chrome.webNavigation = { getAllFrames: async () => { if (result === "error") throw new Error("Unavailable"); return result; } };
    const outcome = await actionLog.logClick({ payload: { id: "inert-frame", type: "click", url: "https://example.test/dialog" } },
      { tab: rootTab, frameId: 7, documentId: "same-doc" });
    assert.equal(outcome.ignored, true);
    assert.deepEqual(storage.data.actionOrder, []);
  }
});

test("click navigation uses the event URL when sender metadata has already changed", async () => {
  const { actionLog, storage } = await setup({
    waitForBrowserContextChange: async () => null,
    findBrowserContextChange: () => null
  });
  const navigatedTab = { ...rootTab, url: "https://example.test/home" };
  chrome.tabs = { sendMessage: async () => ({ changed: false }), get: async () => navigatedTab };
  await actionLog.logClick({ payload: { id: "login", type: "click", url: rootTab.url } },
    { tab: navigatedTab, frameId: 0 });
  assert.deepEqual(storage.data.actionOrder, ["login"]);
});

test("an unresponsive content script cannot block inert-click filtering", { timeout: 3000 }, async () => {
  const { actionLog, storage } = await setup({
    waitForBrowserContextChange: async () => null,
    findBrowserContextChange: () => null
  });
  chrome.tabs = { sendMessage: () => new Promise(() => {}), get: async () => rootTab };
  const result = await actionLog.logClick({ payload: { id: "inert", type: "click", url: rootTab.url } },
    { tab: rootTab, frameId: 0 });
  assert.equal(result.ignored, true);
  assert.deepEqual(storage.data.actionOrder, []);
});

test("a click dropped for having no effect says so, with what was observed", async () => {
  const { actionLog, storage } = await setup({
    waitForBrowserContextChange: async () => null,
    findBrowserContextChange: () => null
  });
  chrome.tabs = { sendMessage: async () => ({ changed: false }), get: async () => rootTab };
  const logged = [];
  const original = console.debug;
  console.debug = (...args) => logged.push(args);
  try {
    const result = await actionLog.logClick({
      payload: { id: "inert", type: "click", url: rootTab.url, target: { tagName: "div" } }
    }, { tab: rootTab, frameId: 0 });
    assert.equal(result.ignored, true);
  } finally {
    console.debug = original;
  }

  // A dropped click and a click nobody made used to leave the same empty trace,
  // which is what made a missing step unexplainable.
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /click not recorded: no-observable-effect/);
  assert.equal(logged[0][1].domChanged, false);
  assert.equal(logged[0][1].navigated, false);
  assert.equal(logged[0][1].target, "div");
  assert.deepEqual(storage.data.actionOrder, []);
});
