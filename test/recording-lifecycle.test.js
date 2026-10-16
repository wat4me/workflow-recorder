const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function contentHarness() {
  const listeners = {};
  const timers = new Map();
  const sent = [];
  const deliveries = [];
  const replies = [];
  let messageHandler;
  let nextTimer = 0;
  const noop = () => {};
  const field = { value: "draft", isConnected: true, isContentEditable: false };
  const context = {
    console: { log: noop, warn: noop, error: noop }, Element: class {},
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    document: { title: "Test", activeElement: field,
      addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: noop },
    chrome: {
      storage: { local: { get: noop }, onChanged: { addListener: noop } },
      runtime: {
        onMessage: { addListener: fn => { messageHandler = fn; } },
        connect: () => ({ onDisconnect: { addListener: noop }, disconnect: noop }),
        sendMessage: (message, callback) => { sent.push(message); deliveries.push(callback); }
      }
    },
    WorkflowRecorderProtocol: { MESSAGE: Object.fromEntries(
      ["pingRecorder", "startRecording", "stopRecording", "logAction"].map(name => [name, name])) },
    RecorderTargeting: { getEditableTarget: target => target === field ? field : null,
      getEditableValue: target => target.value },
    RecorderPageStability: { create: () => ({ start: noop, stop: noop }) },
    RecorderPageFit: { create: () => ({}) },
    RecorderScreencastFramePrimer: { create: () => ({ dispose: noop }) },
    RecorderDragRecorder: { create: () => ({ reset: noop }) }
  };
  Object.assign(context, { window: context, top: context, location: { href: "https://example.test" },
    addEventListener: noop, SemanticElementAnalyzer: { analyze: () => ({}) } });
  vm.createContext(context);
  for (const file of ["input-recorder.js", "main.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content", file), "utf8"), context);
  }
  return {
    sent, timers, deliveries, replies,
    message: action => messageHandler({ action, recordNavigate: false }, {}, reply => replies.push(reply.status)),
    input: () => listeners.input({ target: field, isTrusted: true })
  };
}

test("stop commits pending input and resets deduplication for the next recording", () => {
  const h = contentHarness();
  for (let session = 0; session < 2; session++) {
    h.message("startRecording");
    h.input();
    assert.equal(h.timers.size, 1);
    h.message("stopRecording");
    assert.equal(h.timers.size, 0);
    assert.equal(h.sent.filter(message => message.payload?.type === "type").length, session + 1);
  }
  assert.equal(h.sent[0].payload.value, "draft");
});

test("stop acknowledges only after flushed actions have been committed by the worker", async () => {
  const h = contentHarness();
  h.message("startRecording");
  h.input();
  assert.equal(h.message("stopRecording"), true, "the response channel stays open");
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.replies, ["started"]);
  h.deliveries[0]({ success: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.replies, ["started", "stopped"]);
});

test("session stop waits for every iframe reply before draining and detaching", async () => {
  const replies = new Map();
  const events = [];
  globalThis.chrome = {
    storage: { local: { get: async () => ({ isRecording: true }) } },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }, { frameId: 9 }] },
    tabs: { sendMessage: async (tabId, message, options) => new Promise(resolve => replies.set(options.frameId, resolve)) }
  };
  const { createRecordingSession } = await import("../background/recording/session.js");
  const session = createRecordingSession({
    scope: { readScope: async () => ({ recordingTabIds: [1] }), clearScope: async () => events.push("clear") },
    drainActions: async () => events.push("drain"),
    screenshots: { flush: async () => events.push("flush") },
    screencast: { stopAll: async () => events.push("detach") }
  });
  const stopped = session.toggle(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...replies.keys()], [0, 9]);
  replies.get(0)({ status: "stopped" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [], "a top-frame reply cannot bypass an iframe's input commit");
  replies.get(9)({ status: "stopped" });
  await stopped;
  assert.deepEqual(events, ["drain", "flush", "detach", "clear"]);
});

test("failed CDP start stops content recording, clears scope and allows retry", async () => {
  const state = { isRecording: false, actionOrder: [] };
  const messages = [];
  globalThis.chrome = {
    storage: { local: {
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]])),
      set: async values => Object.assign(state, values), remove: async () => {}
    } },
    scripting: { executeScript: async () => {} },
    tabs: { sendMessage: async (id, message) => { messages.push(message.action); return {}; } }
  };
  const { createRecordingSession } = await import("../background/recording/session.js");
  let attempts = 0;
  let stopped = 0;
  const session = createRecordingSession({
    t: () => "", cases: { autoSave: async () => null },
    scope: {
      resolveInitialTab: async () => ({ id: 1 }),
      bindRootTab: async () => { state.recordingTabIds = [1]; return [{ id: 1 }]; },
      readScope: async () => state,
      clearScope: async () => Object.assign(state, { isRecording: false, recordingTabIds: [], tabsMapping: {} })
    },
    screencast: {
      start: async () => { if (++attempts === 1) throw new Error("attach denied"); },
      stopAll: async () => { stopped++; }
    }, screenshots: { flush: async () => {} }, drainActions: async () => {}
  });
  await assert.rejects(session.toggle(true, null, 1), /attach denied/);
  assert.equal(state.isRecording, false);
  assert.deepEqual(state.recordingTabIds, []);
  assert.ok(messages.includes("stopRecording"));
  assert.equal(stopped, 1);
  assert.deepEqual(await session.toggle(true, null, 1), { success: true });
  assert.equal(attempts, 2);
});

test("continuing a recording re-instruments every tab the paused session covered", async () => {
  const data = {
    isRecording: false,
    actionOrder: ["step_1"],
    "action:step_1": { id: "step_1", type: "click", pageName: "page1" },
    nextPageNumber: 3,
    resumableScope: { tabIds: [1, 2], tabsMapping: { 1: "page1", 2: "page2" } }
  };
  const tabs = {
    1: { id: 1, url: "https://one.test/", windowId: 1 },
    2: { id: 2, url: "https://two.test/", windowId: 2 }
  };
  const messaged = [];
  const started = [];
  globalThis.chrome = {
    runtime: { getURL: () => "chrome-extension://recorder/" },
    storage: { local: {
      get: async keys => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter(key => key in data).map(key => [key, data[key]]));
      },
      set: async values => Object.assign(data, values),
      remove: async keys => {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
      }
    } },
    tabs: {
      get: async tabId => {
        if (!tabs[tabId]) throw new Error(`No tab with id ${tabId}`);
        return tabs[tabId];
      },
      sendMessage: async (tabId, message) => { messaged.push(`${tabId}:${message.action}`); return {}; }
    },
    scripting: { executeScript: async () => {} }
  };
  const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
  const { createRecordingScope } = await import("../background/recording/scope.js");
  const { createRecordingSession } = await import("../background/recording/session.js");
  const scope = createRecordingScope({ screencast: { start: async () => {} } });
  const session = createRecordingSession({
    t: () => "error",
    scope,
    cases: { autoSave: async () => null },
    screencast: { start: async tabId => { started.push(tabId); }, stopAll: async () => {} },
    screenshots: { flush: async () => {} },
    drainActions: async () => {}
  });

  const result = await session.toggle(true, tabs[1], 1, "continue");

  assert.deepEqual(result, { success: true });
  assert.deepEqual(data.recordingTabIds, [1, 2]);
  assert.deepEqual(data.tabsMapping, { 1: "page1", 2: "page2" });
  assert.deepEqual(started, [1, 2]);
  assert.deepEqual(
    messaged.filter(entry => entry.endsWith(MESSAGE.startRecording)),
    ["1:startRecording", "2:startRecording"]
  );
});

test("stopAll waits for a pending attach and detaches it before returning", async () => {
  let release;
  const attached = new Promise(resolve => { release = resolve; });
  const calls = [];
  globalThis.chrome = { debugger: {
    attach: () => attached,
    sendCommand: async (target, method) => { calls.push(method); },
    detach: async () => { calls.push("detach"); },
    onEvent: { addListener: () => {} }, onDetach: { addListener: () => {} }
  } };
  const { createScreencastManager } = await import("../background/capture/screencast.js");
  const capture = createScreencastManager();
  const starting = capture.start(1);
  let stopFinished = false;
  const stopping = capture.stopAll().then(() => { stopFinished = true; });
  await Promise.resolve();
  assert.equal(stopFinished, false);
  release();
  await Promise.all([starting, stopping]);
  assert.equal(capture.has(1), false);
  assert.deepEqual(calls, ["Runtime.enable", "Page.enable", "Page.startScreencast", "Page.stopScreencast", "detach"]);
});
