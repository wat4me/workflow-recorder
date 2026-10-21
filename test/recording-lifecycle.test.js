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
  const pageListeners = {};
  const ports = [];
  const storageReads = [];
  let disconnectError;
  let errorReads = 0;
  let messageHandler;
  let nextTimer = 0;
  const noop = () => {};
  const field = { value: "draft", isConnected: true, isContentEditable: false };
  const context = {
    console: { log: noop, warn: noop, error: noop }, Element: class {},
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    document: { title: "Test", activeElement: field,
      addEventListener: (name, fn) => { listeners[name] = fn; },
      removeEventListener: (name, fn) => { if (listeners[name] === fn) delete listeners[name]; } },
    chrome: {
      storage: { local: { get: (keys, callback) => storageReads.push(callback) }, onChanged: { addListener: noop } },
      runtime: {
        get lastError() { errorReads++; return disconnectError; },
        onMessage: { addListener: fn => { messageHandler = fn; } },
        connect: () => {
          let onDisconnect;
          const port = { onDisconnect: { addListener: fn => { onDisconnect = fn; } },
            disconnect: () => { port.closed = true; },
            drop: () => {
              port.closed = true;
              disconnectError = { message: "The page keeping the extension port is moved into back/forward cache" };
              onDisconnect();
              disconnectError = undefined;
            } };
          ports.push(port);
          return port;
        },
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
    addEventListener: (name, fn) => { pageListeners[name] = fn; }, SemanticElementAnalyzer: { analyze: () => ({}) } });
  vm.createContext(context);
  for (const file of ["input-recorder.js", "main.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content", file), "utf8"), context);
  }
  return {
    sent, timers, deliveries, replies, ports, storageReads,
    get errorReads() { return errorReads; },
    page: (name, event = {}) => pageListeners[name](event),
    runTimers: () => {
      const pending = [...timers.values()];
      timers.clear();
      for (const callback of pending) callback();
    },
    message: action => messageHandler({ action, recordNavigate: false }, {}, reply => replies.push(reply.status)),
    input: () => listeners.input?.({ target: field, isTrusted: true })
  };
}

test("BFCache restore reconnects only after checking the current recording state", () => {
  const h = contentHarness();
  h.message("startRecording");
  assert.equal(h.ports.length, 1);
  h.page("pagehide", { persisted: true });
  assert.equal(h.ports[0].closed, true);
  h.ports[0].drop();
  assert.equal(h.errorReads, 1, "lastError is consumed even for an old port");
  assert.equal(h.timers.size, 0, "a cached page does not retry");
  h.page("pageshow", { persisted: true });
  assert.equal(h.ports.length, 1, "wait for storage before reconnecting");
  h.storageReads.at(-1)({ isRecording: true });
  assert.equal(h.ports.length, 2);
  assert.equal(h.sent.length, 0, "restoring a page adds no navigation step");
  h.ports[0].drop();
  h.message("stopRecording");
  assert.equal(h.ports[1].closed, true, "an old disconnect cannot clear the new port");
});

test("a recording stopped while the document was cached stays stopped on restore", () => {
  const h = contentHarness();
  h.message("startRecording");
  h.page("pagehide", { persisted: true });
  h.page("pageshow", { persisted: true });
  h.storageReads.at(-1)({ isRecording: false });
  h.input();
  h.runTimers();
  assert.equal(h.ports.length, 1);
  assert.equal(h.sent.length, 0);
});

test("stop cancels a pending keepalive reconnect", () => {
  const h = contentHarness();
  h.message("startRecording");
  h.ports[0].drop();
  assert.equal(h.errorReads, 1);
  assert.equal(h.timers.size, 1);
  h.message("stopRecording");
  assert.equal(h.timers.size, 0);
  h.runTimers();
  assert.equal(h.ports.length, 1);
});

test("an active recording reconnects after an unexpected disconnect", () => {
  const h = contentHarness();
  h.message("startRecording");
  h.ports[0].drop();
  h.runTimers();
  assert.equal(h.ports.length, 2);
});

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
    screenshots: { beginStopping: () => events.push("begin-stop"), freezeFrames: () => events.push("freeze"),
      flush: async () => events.push("flush") },
    screencast: { stopAll: async () => events.push("detach") }
  });
  const stopped = session.toggle(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...replies.keys()], [0, 9]);
  replies.get(0)({ status: "stopped" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, ["begin-stop"], "a top-frame reply cannot bypass an iframe's input commit");
  replies.get(9)({ status: "stopped" });
  await stopped;
  assert.deepEqual(events, ["begin-stop", "drain", "freeze", "detach", "flush", "clear"]);
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

test("a stalled stopScreencast response cannot hold the debugger connection open", async () => {
  let releaseStop;
  let detached = false;
  globalThis.chrome = { debugger: {
    attach: async () => {},
    sendCommand: async (target, method) => {
      if (method === "Page.stopScreencast") return new Promise(resolve => { releaseStop = resolve; });
    },
    detach: async () => { detached = true; },
    onEvent: { addListener() {} }, onDetach: { addListener() {} }
  } };
  const { createScreencastManager } = await import("../background/capture/screencast.js");
  const capture = createScreencastManager();
  await capture.start(1);
  await capture.stopAll();
  assert.equal(detached, true, "detach must finish before the stalled command answers");
  releaseStop();
});

test("stopping prevents new debugger sessions until the next recording starts", async () => {
  const attached = [];
  globalThis.chrome = { debugger: {
    attach: async ({ tabId }) => { attached.push(tabId); }, sendCommand: async () => {}, detach: async () => {},
    onEvent: { addListener() {} }, onDetach: { addListener() {} }
  } };
  const { createScreencastManager } = await import("../background/capture/screencast.js");
  const capture = createScreencastManager();
  await capture.start(1);
  capture.beginStopping();
  await capture.start(2);
  await capture.stopAll();
  assert.deepEqual(attached, [1]);
  capture.beginRecording();
  await capture.start(2);
  assert.deepEqual(attached, [1, 2]);
  await capture.stopAll();
});

test("an injection begun before stop cannot restart a page in a later recording generation", async () => {
  let releaseInjection;
  const sent = [];
  let first = true;
  globalThis.chrome = {
    scripting: { executeScript: async () => {
      if (first) { first = false; await new Promise(resolve => { releaseInjection = resolve; }); }
    } },
    tabs: { sendMessage: async (id, message) => { sent.push(message.action); } }
  };
  const injection = await import("../background/recording/injection.js");
  injection.beginRecordingInjection();
  const pending = injection.injectRecordingScripts(1);
  injection.stopRecordingInjection();
  injection.beginRecordingInjection();
  releaseInjection();
  assert.equal(await pending, false);
  assert.deepEqual(sent, ["pingRecorder"]);
});

test("post-detach persistence keeps the worker active and releases its heartbeat even on failure", async context => {
  let tick;
  let rejectSave;
  let platformReads = 0;
  let scopeCleared = false;
  const timer = {};
  context.mock.method(globalThis, "setInterval", (callback, delay) => {
    assert.ok(delay > 0 && delay < 30000, "refresh the worker lifetime before its idle deadline");
    tick = callback;
    return timer;
  });
  const clear = context.mock.method(globalThis, "clearInterval", () => {});
  globalThis.chrome = {
    runtime: { getPlatformInfo: async () => { platformReads++; } },
    storage: { local: { get: async () => ({ isRecording: true }) } },
    tabs: { sendMessage: async () => ({}) }
  };
  const { createRecordingSession } = await import("../background/recording/session.js");
  const session = createRecordingSession({
    scope: { readScope: async () => ({ recordingTabIds: [1] }), clearScope: async () => { scopeCleared = true; } },
    drainActions: async () => {}, screencast: { stopAll: async () => {} },
    screenshots: { flush: () => new Promise((resolve, reject) => { rejectSave = reject; }) }
  });
  const stopping = session.toggle(false);
  await new Promise(resolve => setImmediate(resolve));
  tick();
  assert.equal(platformReads, 1);
  assert.equal(clear.mock.callCount(), 0);
  rejectSave(new Error("Save failed"));
  await assert.rejects(stopping, /Save failed/);
  assert.equal(scopeCleared, true);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(clear.mock.calls[0].arguments[0], timer);
});
