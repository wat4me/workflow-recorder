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
  mediaStore = {},
  cleanup = null,
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
      getAllKeys: async () => [...blobs.keys()],
      ...mediaStore
    },
    deleteScreenshots: cleanup || (async keys => {
      for (const key of keys) {
        deleted.push(key);
        blobs.delete(key);
      }
      return { deletedCount: keys.length, pending: false };
    }),
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
  assert.ok(readStep(storage, "step_1").screenshotKey, "slow progress writes must not block capture");
  releaseFirstStateWrite();
  await waitFor(() => readStep(storage, "step_1").screenshotKey, "the capture to finish");
  await waitFor(
    () => storage.data.screenshotCaptureState?.pendingCount === 0,
    "the final idle capture state"
  );
  assert.equal(storage.data.screenshotCaptureState.busy, false);
  assert.equal(storage.data.screenshotCaptureState.activeActionId, null);
});

test("a slow tab does not hold up another tab, while steps in that same tab stay ordered", async () => {
  let releaseSlowTab;
  const stabilityCalls = [];
  const { manager, storage } = await createManager({ steps: [
    { id: "slow", pageName: "page1", screenshotStatus: "pending" },
    { id: "next", pageName: "page1", screenshotStatus: "pending" },
    { id: "fast", pageName: "page2", screenshotStatus: "pending" }
  ] });
  chrome.tabs.sendMessage = (tabId, message) => {
    if (message.action !== "waitForPageStable") return Promise.resolve({});
    stabilityCalls.push(tabId);
    if (tabId === 1 && !releaseSlowTab) return new Promise(resolve => {
      releaseSlowTab = () => resolve({ stable: true });
    });
    return Promise.resolve({ stable: true });
  };
  manager.schedule("slow", TAB, "click");
  manager.schedule("next", TAB, "click");
  manager.schedule("fast", { id: 2, windowId: 1 }, "click");
  try {
    await waitFor(() => readStep(storage, "fast").screenshotKey, "the independent tab capture");
    assert.equal(readStep(storage, "slow").screenshotStatus, "pending");
    assert.equal(readStep(storage, "next").screenshotStatus, "pending");
    assert.deepEqual(stabilityCalls, [1, 2]);
  } finally {
    releaseSlowTab();
    await manager.flush();
  }
  assert.ok(readStep(storage, "slow").screenshotKey);
  assert.ok(readStep(storage, "next").screenshotKey);
  assert.equal(storage.data.screenshotCaptureState.pendingCount, 0);
  assert.deepEqual(storage.data.screenshotCaptureState.activeCaptures, []);
});

test("capture concurrency is bounded and a settled frame survives waiting for a storage slot", async () => {
  const releases = new Map();
  const frames = new Map([1, 2, 3].map(id => [id, { at: 100, data: Buffer.from(`tab-${id}-settled`).toString("base64") }]));
  const written = [];
  let thirdFramePinned = false;
  let activeWrites = 0;
  let maxWrites = 0;
  const { manager } = await createManager({
    steps: [1, 2, 3].map(id => ({ id: `step_${id}`, pageName: `page${id}`, screenshotStatus: "pending" })),
    screencast: { getLatestFrame: id => { if (id === 3) thirdFramePinned = true; return frames.get(id); } },
    mediaStore: { async putBlob(key, blob) {
      activeWrites++;
      maxWrites = Math.max(maxWrites, activeWrites);
      written.push({ key, text: await blob.text() });
      if (!key.startsWith("screenshot:step_3:")) await new Promise(resolve => { releases.set(key, resolve); });
      activeWrites--;
    } }
  });
  for (const id of [1, 2, 3]) manager.schedule(`step_${id}`, { id, windowId: 1 }, "click");
  await waitFor(() => releases.size === 2 && thirdFramePinned, "two writes and a queued third frame");
  assert.equal(written.length, 2);
  assert.equal(manager.getState().activeCaptures.length, 2);
  frames.set(3, { at: 200, data: Buffer.from("a later action").toString("base64") });
  for (const release of releases.values()) release();
  await manager.flush();
  assert.equal(maxWrites, 2);
  assert.equal(written.find(item => item.key.startsWith("screenshot:step_3:")).text, "tab-3-settled");
});

test("a cached frame preceding the latest page change requests a fresh frame", async () => {
  const calls = [];
  const { manager, storage, blobs } = await createManager({
    steps: [{ id: "step_1", pageName: "page1", screenshotStatus: "pending" }],
    screencast: {
      getLatestFrame: () => ({ at: 100, data: FRAME }),
      getFrame: async (tabId, afterAt) => {
        calls.push({ tabId, afterAt });
        return { at: Date.now(), data: Buffer.from("loaded result").toString("base64") };
      }
    }
  });
  chrome.tabs.sendMessage = (tabId, message) => Promise.resolve(
    message.action === "waitForPageStable" ? { stable: true, lastChangeAt: 200 } : {}
  );
  manager.schedule("step_1", TAB, "click");
  await waitFor(() => readStep(storage, "step_1").screenshotKey, "a fresh screenshot");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].afterAt >= 200);
  assert.equal(await blobs.get(readStep(storage, "step_1").screenshotKey).text(), "loaded result");
  await manager.flush();
});

test("manual capture interrupts only its own tab's stability wait and stop cancels all remaining waits", async () => {
  const waiting = new Map();
  const cancelled = [];
  const { manager, storage } = await createManager({ steps: [
    { id: "step_1", pageName: "page1", screenshotStatus: "pending" },
    { id: "step_2", pageName: "page2", screenshotStatus: "pending" }
  ] });
  chrome.tabs.sendMessage = (id, message) => {
    if (message.action === "waitForPageStable") return new Promise(resolve => waiting.set(id, resolve));
    if (message.action === "cancelPageStableWait") {
      cancelled.push(id);
      waiting.get(id)?.({ stable: false, cancelled: true });
    }
    return Promise.resolve({});
  };
  manager.schedule("step_1", TAB, "click");
  manager.schedule("step_2", { id: 2, windowId: 1 }, "click");
  await waitFor(() => waiting.size === 2, "both page stability waits");
  assert.equal((await manager.handleManual(TAB)).success, true);
  await waitFor(() => readStep(storage, "step_1").screenshotSource === "manual", "the prioritized manual screenshot");
  assert.deepEqual(cancelled, [1]);
  assert.equal(readStep(storage, "step_2").screenshotStatus, "pending");
  await manager.flush();
  assert.ok(cancelled.includes(2));
  assert.equal(readStep(storage, "step_2").screenshotStatus, "captured");
  assert.equal(manager.getState().pendingCount, 0);
});

for (const fails of [false, true]) {
  test(`stop detaches before slow media writes finish and ${fails ? "records failures without losing old images" : "saves every queued frame after the live cache disappears"}`, async () => {
    let releaseWrites;
    const writes = new Promise(resolve => { releaseWrites = resolve; });
    let detached = false;
    let readsAfterDetach = 0;
    const stored = new Map();
    let writesStarted = 0;
    const steps = [1, 2, 3, 4].map(id => ({ id: `pending_${id}`, pageName: `page${id % 2 + 1}`,
      screenshotStatus: "pending", ...(fails ? { screenshotKey: `old_${id}` } : {}) }));
    const { manager, storage } = await createManager({ steps,
      screencast: {
        has: () => !detached,
        getLatestFrame: id => {
          if (detached) { readsAfterDetach++; return null; }
          return { data: Buffer.from(`tab-${id}`).toString("base64") };
        }
      },
      mediaStore: { async putBlob(key, blob) {
        writesStarted++;
        await writes;
        if (fails) throw new Error("Media disk unavailable");
        stored.set(key, await blob.text());
      } }
    });
    const { createRecordingSession } = await import("../background/recording/session.js");
    const session = createRecordingSession({
      scope: { readScope: async () => ({ recordingTabIds: [1, 2] }), clearScope: async () => {} },
      screenshots: manager, screencast: { stopAll: async () => { detached = true; } }, drainActions: async () => {}
    });
    for (const [index, step] of steps.entries()) manager.schedule(step.id, { id: index % 2 + 1, windowId: 1 }, "click");
    await waitFor(() => writesStarted > 0, "media persistence to start");
    let completed = false;
    const stopping = session.toggle(false).then(result => { completed = true; return result; });
    try {
      await waitFor(() => detached, "debugger release while writes are blocked");
      assert.equal(completed, false, "the stop request still owns and awaits the remaining saves");
    } finally {
      releaseWrites();
    }
    assert.equal((await stopping).success, true);
    assert.equal(readsAfterDetach, 0);
    for (const [index, step] of steps.entries()) {
      const result = readStep(storage, step.id);
      if (fails) {
        assert.equal(result.screenshotStatus, "failed");
        assert.equal(result.screenshotKey, `old_${index + 1}`);
      } else {
        assert.equal(result.screenshotStatus, "captured");
        assert.equal(stored.get(result.screenshotKey), `tab-${index % 2 + 1}`);
      }
    }
    assert.equal(manager.getState().pendingCount, 0);
  });
}

test("stop releases the debugger even while an already-replaced screenshot is waiting for cleanup", async () => {
  let releaseCleanup;
  let cleaning = false;
  let detached = false;
  const cleanup = new Promise(resolve => { releaseCleanup = resolve; });
  const { manager, storage } = await createManager({
    steps: [{ id: "step_1", pageName: "page1", screenshotKey: "old-image" }],
    cleanup: async () => { cleaning = true; await cleanup; }
  });
  manager.schedule("step_1", TAB, "click");
  await waitFor(() => cleaning, "old image cleanup");
  assert.equal(readStep(storage, "step_1").screenshotStatus, "captured");
  const { createRecordingSession } = await import("../background/recording/session.js");
  const session = createRecordingSession({
    scope: { readScope: async () => ({ recordingTabIds: [1] }), clearScope: async () => {} },
    screenshots: manager, screencast: { stopAll: async () => { detached = true; } }, drainActions: async () => {}
  });
  const stopping = session.toggle(false);
  try {
    await waitFor(() => detached, "debugger release ahead of cleanup");
  } finally {
    releaseCleanup();
  }
  await stopping;
});

test("stop abandons a non-responding manual primer and persists its frozen frame after detach", async () => {
  let priming = false;
  let detached = false;
  const { manager, storage, blobs } = await createManager({
    steps: [{ id: "step_1", pageName: "page1" }],
    screencast: {
      has: () => !detached,
      getLatestFrame: () => detached ? null : { data: FRAME },
      getFrame: () => { assert.fail("stop must not request a new frame"); }
    }
  });
  chrome.tabs.sendMessage = (id, message) => {
    if (message.action === "primeScreencastFrame") { priming = true; return new Promise(() => {}); }
    return Promise.resolve({});
  };
  await manager.handleManual(TAB);
  await waitFor(() => priming, "the manual primer");
  manager.beginStopping();
  manager.freezeFrames();
  detached = true;
  await manager.flush();
  assert.equal(readStep(storage, "step_1").screenshotStatus, "captured");
  assert.equal(await blobs.get(readStep(storage, "step_1").screenshotKey).text(), "frame-bytes");
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
    assert.equal(frameWaits.length, 0, "finishing skips a new frame wait after the primer resolves/times out");

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

test("cards identify concurrent captures on different tabs", () => {
  const { resolve } = loadCaptureState();
  const capture = { busy: true, kind: "auto", activeActionId: "a", activeCaptures: [
    { actionId: "a", kind: "auto" }, { actionId: "b", kind: "manual" }
  ] };
  assert.equal(resolve({ id: "a", screenshotStatus: "pending" }, capture), "capturing-auto");
  assert.equal(resolve({ id: "b", screenshotStatus: "pending" }, capture), "capturing-manual");
  assert.equal(resolve({ id: "c", screenshotStatus: "pending" }, capture), "pending");
});
