/** One semantic action owns a safely-published before frame. */
const assert = require("node:assert/strict");
const test = require("node:test");

function createStorage(initial, events) {
  const data = structuredClone(initial);
  return {
    data,
    local: {
      get(keys) {
        const names = keys === null || keys === undefined
          ? Object.keys(data)
          : (Array.isArray(keys) ? keys : [keys]);
        const result = {};
        for (const name of names) {
          if (Object.prototype.hasOwnProperty.call(data, name)) result[name] = structuredClone(data[name]);
        }
        return Promise.resolve(result);
      },
      set(values) {
        if (Object.keys(values).some(key => key.startsWith("action:"))) events.push("publish-step");
        for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
        return Promise.resolve();
      },
      remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
        return Promise.resolve();
      }
    }
  };
}

async function setup(storeFrameBlob) {
  const events = [];
  const storage = createStorage({
    isRecording: true,
    recordingTabIds: [1],
    tabsMapping: { 1: "page1" },
    nextPageNumber: 2,
    actionOrder: []
  }, events);
  globalThis.chrome = { storage, i18n: { getUILanguage: () => "en-US" } };

  const scheduled = [];
  const { createActionLog } = await import(`../background/recording/action-log.js?t=${Math.random()}`);
  const log = createActionLog({
    t: (key, subs, fallback) => fallback,
    scope: {},
    screenshots: {
      snapshotFrameData: () => "cached-frame",
      beforeKeyFor: actionId => `screenshot:${actionId}:before`,
      storeFrameBlob: async (key, data, highlightBox) => {
        events.push("store-before");
        return storeFrameBlob(key, data, highlightBox);
      },
      schedule: actionId => scheduled.push(actionId)
    },
    mediaCleanup: { deleteUnreferenced: async () => ({ deletedCount: 0, pending: false }) },
    notifyStepsUpdated: () => {}
  });
  return { events, log, scheduled, storage };
}

test("the before blob lands before its key is published on the single step", async () => {
  let receivedHighlight = null;
  const { events, log, scheduled, storage } = await setup(async (key, data, highlightBox) => {
    receivedHighlight = highlightBox;
    return key;
  });

  await log.log(
    {
      id: "step_1",
      type: "click",
      timestamp: 1,
      target: { domPath: "body>button", boundingBox: { x: 10, y: 20, width: 30, height: 40 } }
    },
    { id: 1, windowId: 1, url: "https://example.test/", title: "Example" }
  );

  assert.deepEqual(events.slice(0, 2), ["store-before", "publish-step"]);
  assert.deepEqual(storage.data.actionOrder, ["step_1"]);
  assert.equal(storage.data["action:step_1"].screenshotBeforeKey, "screenshot:step_1:before");
  assert.equal(storage.data["action:step_1"].screenshotStatus, "pending");
  assert.deepEqual(scheduled, ["step_1"]);
  assert.deepEqual(receivedHighlight, { x: 10, y: 20, width: 30, height: 40 });
});

test("a failed before-frame write publishes a valid single-frame step", async () => {
  const { log, storage } = await setup(async () => null);

  await log.log(
    { id: "step_1", type: "click", timestamp: 1, target: { domPath: "body>button" } },
    { id: 1, windowId: 1, url: "https://example.test/", title: "Example" }
  );

  assert.equal("screenshotBeforeKey" in storage.data["action:step_1"], false);
  assert.equal(storage.data["action:step_1"].screenshotStatus, "pending");
});
