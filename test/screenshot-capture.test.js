/**
 * Screenshot binding, re-binding and interrupted-capture recovery.
 *
 * Drives the real capture pump against a fake screencast and a fake storage,
 * because the invariants worth protecting are ordering invariants: which key a
 * blob is written under, when the key it replaced becomes collectable, and what a
 * step looks like after the worker that was capturing it disappeared.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

// A one-pixel JPEG is unnecessary: the pump only base64-decodes the frame.
const FRAME = Buffer.from("frame-bytes").toString("base64");

function createStorage(initial = {}) {
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

function seedSteps(storage, actions) {
  storage.data.actionOrder = actions.map(item => item.id);
  for (const item of actions) storage.data[`action:${item.id}`] = structuredClone(item);
}

function readStep(storage, id) {
  return storage.data[`action:${id}`];
}

async function createManager({
  steps = [],
  captureFails = false,
  configureStorage = null,
  screencast = {},
  t = (key, subs, fallback) => fallback
} = {}) {
  const storage = createStorage({ recordingTabIds: [1], isRecording: true, tabsMapping: { 1: "page1" } });
  seedSteps(storage, steps);
  configureStorage?.(storage);

  globalThis.chrome = {
    storage,
    tabs: {
      // `wasVisible: false` tells the pump the overlay was already off screen, so
      // it does not wait for a fresh post-hide frame.
      sendMessage: (tabId, message) => Promise.resolve(
        message.action === "waitForPageStable" ? { stable: true } : { wasVisible: false }
      )
    },
    i18n: { getUILanguage: () => "en-US" }
  };

  const blobs = new Map();
  const deleted = [];
  const { createScreenshotManager } = await import(
    `../background/capture/screenshots.js?t=${Math.random()}`
  );

  const manager = createScreenshotManager({
    t,
    // Production serializes action writes; the ordering under test is the
    // pipeline's, so this is a pass-through.
    queueAction: fn => fn(),
    screencast: {
      has: () => !captureFails,
      getLatestFrame: () => ({ data: FRAME }),
      getFrame: async () => ({ data: FRAME }),
      ...screencast
    },
    mediaStore: {
      putBlob: async (key, blob) => { blobs.set(key, blob); },
      getBlob: async key => blobs.get(key) || null,
      getAllKeys: async () => [...blobs.keys()]
    },
    deleteScreenshots: async keys => {
      for (const key of keys) {
        deleted.push(key);
        blobs.delete(key);
      }
      return { deletedCount: keys.length, pending: false };
    },
    notifyStepsUpdated: () => {}
  });

  return { manager, storage, blobs, deleted };
}

const TAB = { id: 1, windowId: 1 };

async function waitFor(check, label, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${label}`);
}

test("a capture binds a versioned key and clears earlier failure state", async () => {
  const { manager, storage, blobs } = await createManager({
    steps: [{
      id: "step_1",
      type: "click",
      pageName: "page1",
      // Left behind by an attempt that failed before this one.
      screenshotStatus: "failed",
      screenshotError: "boom",
      screenshotAttemptedAt: 1,
      screenshotSkippedReason: "opens-child-page"
    }]
  });

  manager.schedule("step_1", TAB, "click");
  const step = await waitFor(() => readStep(storage, "step_1").screenshotKey && readStep(storage, "step_1"), "the bind");

  assert.match(step.screenshotKey, /^screenshot:step_1:[a-z0-9]+$/);
  assert.equal(step.screenshotStatus, "captured");
  // A step showing a screenshot must not also be carrying an error or a "needs no
  // screenshot" marker: both would make the card render as something it is not.
  assert.equal("screenshotError" in step, false);
  assert.equal("screenshotAttemptedAt" in step, false);
  assert.equal("screenshotSkippedReason" in step, false);
  assert.equal(blobs.has(step.screenshotKey), true);
});

test("capture state writes cannot leave an older pending snapshot after the queue drains", async () => {
  let releaseFirstStateWrite;
  let stateWriteCount = 0;
  const { manager, storage } = await createManager({
    steps: [{ id: "step_1", type: "click", pageName: "page1", screenshotStatus: "pending" }],
    configureStorage(target) {
      const set = target.local.set.bind(target.local);
      target.local.set = async values => {
        if (values.screenshotCaptureState && ++stateWriteCount === 1) {
          await new Promise(resolve => { releaseFirstStateWrite = resolve; });
        }
        return set(values);
      };
    }
  });

  manager.schedule("step_1", TAB, "click");
  await waitFor(() => releaseFirstStateWrite, "the first capture-state write to start");
  // Long enough that an unserialized pump would finish and publish idle before
  // this older pending write is released.
  await new Promise(resolve => setTimeout(resolve, 150));
  releaseFirstStateWrite();
  await waitFor(() => readStep(storage, "step_1").screenshotKey, "the capture to finish");
  await waitFor(
    () => storage.data.screenshotCaptureState?.pendingCount === 0,
    "the final idle capture state"
  );
  assert.equal(storage.data.screenshotCaptureState.busy, false);
  assert.equal(storage.data.screenshotCaptureState.activeActionId, null);
});

test("a re-capture writes a new key and only then releases the old one", async () => {
  const { manager, storage, blobs, deleted } = await createManager({
    steps: [{ id: "step_1", type: "click", pageName: "page1" }]
  });

  manager.schedule("step_1", TAB, "click");
  const firstKey = (await waitFor(
    () => readStep(storage, "step_1").screenshotKey,
    "the first bind"
  ));

  manager.schedule("step_1", TAB, "click");
  const secondKey = await waitFor(() => {
    const key = readStep(storage, "step_1").screenshotKey;
    return key && key !== firstKey ? key : null;
  }, "the re-bind");

  assert.notEqual(secondKey, firstKey);
  assert.equal(blobs.has(secondKey), true);
  // Offered for collection only after the step pointed at the new blob, and
  // through the reference-aware path, so a saved case using it would keep it.
  assert.deepEqual(deleted, [firstKey]);
});

test("a capture that lands after its step was deleted removes its own blob", async () => {
  const { manager, storage, blobs, deleted } = await createManager({
    steps: [{ id: "step_1", type: "click", pageName: "page1" }]
  });

  manager.schedule("step_1", TAB, "click");
  // The user deletes the step while the frame is being taken.
  storage.data.actionOrder = [];
  delete storage.data["action:step_1"];

  await waitFor(() => deleted.length > 0, "the orphaned blob to be dropped");
  assert.equal(deleted.length, 1);
  assert.match(deleted[0], /^screenshot:step_1:/);
  assert.equal(blobs.size, 0);
});

test("a failed re-capture keeps the screenshot the step already had", async () => {
  const { manager, storage } = await createManager({
    steps: [{
      id: "step_1",
      type: "click",
      pageName: "page1",
      screenshotKey: "screenshot:step_1:existing",
      screenshotStatus: "captured"
    }],
    captureFails: true
  });

  manager.schedule("step_1", TAB, "click");
  const step = await waitFor(
    () => readStep(storage, "step_1").screenshotStatus === "failed" && readStep(storage, "step_1"),
    "the failure to be recorded"
  );

  assert.equal(step.screenshotKey, "screenshot:step_1:existing");
  assert.ok(step.screenshotError);
});

test("a failed manual capture leaves pending instead of waiting forever", async () => {
  const { manager, storage } = await createManager({
    steps: [{ id: "step_1", type: "click", pageName: "page1", screenshotStatus: "captured", screenshotKey: "k" }],
    captureFails: true
  });

  assert.equal((await manager.handleManual(TAB)).success, true);
  const step = await waitFor(
    () => readStep(storage, "step_1").screenshotStatus !== "pending" && readStep(storage, "step_1"),
    "the manual failure to resolve"
  );
  assert.equal(step.screenshotStatus, "failed");
  assert.equal(step.screenshotKey, "k");
});

test("an unmapped child tab in the recording scope cannot replace the root page's after frame", async context => {
  const rootStep = {
    id: "root_step",
    type: "click",
    pageName: "page1",
    screenshotStatus: "captured",
    screenshotBeforeKey: "root-before",
    screenshotKey: "root-after",
    screenshotCapturedTabId: 1
  };
  const { manager, storage, blobs, deleted } = await createManager({
    steps: [rootStep],
    configureStorage: target => { target.data.recordingTabIds.push(2); },
    t: key => key
  });
  const writes = context.mock.method(storage.local, "set");

  const result = await manager.handleManual({ id: 2, windowId: 1 });
  await manager.flush();

  assert.deepEqual(result, { success: false, error: "errorNoStepForScreenshot" });
  assert.deepEqual(readStep(storage, rootStep.id), rootStep);
  assert.deepEqual(storage.data.actionOrder, [rootStep.id]);
  assert.equal(writes.mock.calls.some(call => Object.keys(call.arguments[0]).some(key => key.startsWith("action:"))), false);
  assert.equal(blobs.size, 0);
  assert.deepEqual(deleted, []);
  assert.equal(manager.getState().pendingCount, 0);
});

for (const cachedFrame of [true, false]) {
  test(`flush finishes when a manual primer never responds, ${cachedFrame ? "using the latest frame" : "keeping the old screenshot on failure"}`, { timeout: 2500 }, async () => {
    let primeStarted;
    let rejectPrime;
    const priming = new Promise(resolve => { primeStarted = resolve; });
    const frameWaits = [];
    const { manager, storage, blobs, deleted } = await createManager({
      steps: [{ id: "step_1", type: "click", pageName: "page1", screenshotStatus: "captured", screenshotKey: "old-after" }],
      screencast: {
        getLatestFrame: () => cachedFrame ? { data: FRAME } : null,
        getFrame: (tabId, afterAt, timeoutMs) => {
          frameWaits.push({ tabId, afterAt, timeoutMs });
          return new Promise((resolve, reject) => {
            setTimeout(() => reject(new Error("No fresh frame")), timeoutMs);
          });
        }
      }
    });
    chrome.tabs.sendMessage = (tabId, message) => {
      assert.equal(tabId, TAB.id);
      assert.equal(message.action, "primeScreencastFrame");
      primeStarted();
      return new Promise((resolve, reject) => { rejectPrime = reject; });
    };

    assert.equal((await manager.handleManual(TAB)).success, true);
    // Stop only once the pump is already waiting on the unresponsive primer.
    await priming;
    assert.equal(readStep(storage, "step_1").screenshotStatus, "pending");
    const startedAt = Date.now();
    await manager.flush();
    assert.ok(Date.now() - startedAt < 2000, "flush must bound both the primer and frame waits");
    assert.equal(frameWaits.length, 1);
    assert.equal(frameWaits[0].tabId, TAB.id);
    assert.ok(frameWaits[0].afterAt > 0);
    assert.equal(frameWaits[0].timeoutMs, 800);

    const step = readStep(storage, "step_1");
    if (cachedFrame) {
      assert.equal(step.screenshotStatus, "captured");
      assert.equal(step.screenshotSource, "manual");
      assert.equal(await blobs.get(step.screenshotKey).text(), "frame-bytes");
      assert.deepEqual(deleted, ["old-after"]);
      // A message channel may reject after the timeout has already won.
      rejectPrime(new Error("Primer channel closed after flush"));
      await new Promise(resolve => setImmediate(resolve));
    } else {
      assert.equal(step.screenshotStatus, "failed");
      assert.equal(step.screenshotErrorReason, "captureFailed");
      assert.equal(step.screenshotKey, "old-after");
      assert.equal(blobs.size, 0);
      assert.deepEqual(deleted, []);
    }
    assert.equal(manager.getState().pendingCount, 0);
    assert.equal(storage.data.screenshotCaptureState.busy, false);
    assert.equal(storage.data.screenshotCaptureState.activeActionId, null);
  });
}

for (const rejects of [false, true]) {
  test(`a promptly ${rejects ? "rejected" : "resolved"} primer clears its timeout and still captures`, async context => {
    const { manager, storage } = await createManager({
      steps: [{ id: "step_1", type: "click", pageName: "page1" }]
    });
    let primeStarted;
    const priming = new Promise(resolve => { primeStarted = resolve; });
    chrome.tabs.sendMessage = () => {
      primeStarted();
      return rejects ? Promise.reject(new Error("Primer unavailable")) : Promise.resolve(true);
    };
    const setTimer = context.mock.method(globalThis, "setTimeout");
    const clearTimer = context.mock.method(globalThis, "clearTimeout");

    assert.equal((await manager.handleManual(TAB)).success, true);
    await priming;
    await manager.flush();

    assert.equal(readStep(storage, "step_1").screenshotStatus, "captured");
    assert.equal(setTimer.mock.callCount(), 1);
    const timerCall = setTimer.mock.calls[0];
    assert.ok(timerCall.arguments[1] > 0 && timerCall.arguments[1] <= 500);
    assert.equal(clearTimer.mock.callCount(), 1);
    assert.equal(clearTimer.mock.calls[0].arguments[0], timerCall.result);
  });
}

test("steps stranded by a worker restart are failed, not left waiting", async () => {
  const { manager, storage } = await createManager({
    steps: [
      // Written by a worker that no longer exists: its queue and its CDP sessions
      // went with it, so no capture is coming for these.
      { id: "step_1", type: "click", pageName: "page1", screenshotStatus: "pending" },
      { id: "step_2", type: "click", pageName: "page1", screenshotStatus: "captured", screenshotKey: "k" },
      { id: "step_3", type: "click", pageName: "page1", screenshotStatus: "skipped" }
    ]
  });

  assert.equal(await manager.recoverInterruptedJobs(), 1);
  assert.equal(readStep(storage, "step_1").screenshotStatus, "failed");
  assert.match(readStep(storage, "step_1").screenshotError, /interrupted|中断/);
  assert.equal(readStep(storage, "step_2").screenshotStatus, "captured");
  assert.equal(readStep(storage, "step_3").screenshotStatus, "skipped");

  // Idle is published too, so no node keeps a spinner for a capture that is not
  // happening.
  assert.equal(storage.data.screenshotCaptureState.busy, false);
  assert.equal(storage.data.screenshotCaptureState.activeActionId, null);
});

test("recovery leaves alone a step this worker has already claimed", async () => {
  const { manager, storage } = await createManager({
    steps: [{ id: "step_1", type: "click", pageName: "page1", screenshotStatus: "pending" }]
  });

  // Queued by *this* worker. Storage cannot tell it apart from a stranded step --
  // both are simply `pending` -- so the manager has to remember what it claimed.
  manager.schedule("step_1", TAB, "click");

  assert.equal(await manager.recoverInterruptedJobs(), 0);
  assert.notEqual(readStep(storage, "step_1").screenshotStatus, "failed");
  const step = await waitFor(
    () => readStep(storage, "step_1").screenshotKey && readStep(storage, "step_1"),
    "the claimed capture to complete"
  );
  assert.equal(step.screenshotStatus, "captured");
});

test("a manual capture updates only the last operation's after frame on the current page", async () => {
  const { manager, storage } = await createManager({
    steps: [{
      id: "earlier_step",
      type: "click",
      pageName: "page1",
      screenshotKey: "earlier-after"
    }, {
      id: "step_1",
      type: "click",
      pageName: "page1",
      // A step that was deliberately skipped is still a valid manual target.
      screenshotStatus: "skipped",
      screenshotBeforeKey: "before-kept",
      screenshotSkippedReason: "opens-child-page"
    }, {
      id: "step_2",
      type: "click",
      pageName: "page2",
      screenshotKey: "screenshot:step_2:existing",
      screenshotStatus: "captured"
    }]
  });

  const result = await manager.handleManual(TAB);
  assert.equal(result.success, true);
  // The last step on the requesting tab's page, not simply the last step.
  assert.equal(result.actionId, "step_1");
  assert.deepEqual(storage.data.actionOrder, ["earlier_step", "step_1", "step_2"]);
  assert.equal(readStep(storage, "step_1").screenshotIntent, "manual");
  assert.equal(readStep(storage, "step_2").screenshotKey, "screenshot:step_2:existing");

  const step = await waitFor(
    () => readStep(storage, "step_1").screenshotKey && readStep(storage, "step_1"),
    "the manual bind"
  );
  assert.equal(step.screenshotStatus, "captured");
  assert.equal(step.screenshotSource, "manual");
  assert.equal(step.screenshotBeforeKey, "before-kept");
  assert.equal(readStep(storage, "earlier_step").screenshotKey, "earlier-after");
  assert.equal(readStep(storage, "step_2").screenshotKey, "screenshot:step_2:existing");
});

/** The derived card state, loaded without a DOM. */
function loadCaptureState() {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "ui", "lib", "capture-state.js"),
    "utf8"
  );
  const context = { globalThis: {} };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.RecorderCaptureState;
}

test("a step showing a screenshot is never reported as unavailable", () => {
  const { resolve } = loadCaptureState();
  const capture = { busy: true, kind: "auto", activeActionId: "other" };

  assert.equal(resolve({ id: "a", screenshotKey: "k", screenshotStatus: "captured" }, capture), "captured");
  // Failed *re*-capture: the previous image stays, so this is a warning, not a
  // missing screenshot.
  assert.equal(
    resolve({ id: "a", screenshotKey: "k", screenshotStatus: "failed", screenshotError: "boom" }, capture),
    "recapture-failed"
  );
  assert.equal(resolve({ id: "a", screenshotKey: "k", screenshotStatus: "pending" }, capture), "pending");
});

test("waiting and capturing are distinguished by which step is active", () => {
  const { resolve } = loadCaptureState();
  const pending = { id: "a", screenshotStatus: "pending" };

  assert.equal(resolve(pending, { busy: false, activeActionId: "a" }), "pending");
  assert.equal(resolve(pending, { busy: true, kind: "auto", activeActionId: "b" }), "pending");
  assert.equal(resolve(pending, { busy: true, kind: "auto", activeActionId: "a" }), "capturing-auto");
  assert.equal(resolve(pending, { busy: true, kind: "manual", activeActionId: "a" }), "capturing-manual");
  assert.equal(
    resolve({ id: "a", screenshotKey: "k", screenshotStatus: "pending" }, { busy: true, kind: "manual", activeActionId: "a" }),
    "recapturing"
  );
});

test("skipped, failed and pre-existing steps resolve as expected", () => {
  const { resolve } = loadCaptureState();

  assert.equal(resolve({ id: "a", screenshotStatus: "skipped" }, {}), "skipped");
  assert.equal(resolve({ id: "a", screenshotSkippedReason: "opens-child-page" }, {}), "skipped");
  assert.equal(resolve({ id: "a", screenshotStatus: "failed" }, {}), "failed");
  assert.equal(resolve({ id: "a", screenshotError: "boom" }, {}), "failed");
  // Recorded before capture state was persisted: say nothing rather than guess.
  assert.equal(resolve({ id: "a" }, {}), "");
  assert.equal(resolve(null, {}), "");
});
