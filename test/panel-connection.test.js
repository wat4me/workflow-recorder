const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function eventTarget() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
    },
    removeEventListener(name, callback) { listeners.get(name)?.delete(callback); },
    async fire(name, event = {}) {
      await Promise.all([...(listeners.get(name) || [])].map(callback => callback(event)));
    }
  };
}

async function panelHarness({ visibilityState = "visible" } = {}) {
  const noop = () => {};
  const timers = new Map();
  const ports = [];
  const messages = [];
  const warnings = [];
  let refreshes = 0;
  let errorReads = 0;
  let nextTimer = 0;
  let failConnect = false;
  let disconnectError;
  const element = () => ({ addEventListener: noop, getClientRects: () => [], querySelector: () => ({}) });
  const document = Object.assign(eventTarget(), {
    visibilityState, getElementById: element, querySelector: element
  });
  const window = Object.assign(eventTarget(), {
    RecorderI18n: { ready: Promise.resolve(), applyI18n: noop, bindLanguageToggle: noop },
    RecorderStepView: { create: () => ({ dispose: noop }) },
    RecorderPanel: { create: () => ({ refreshState: async () => { refreshes++; } }) }
  });
  const chrome = {
    tabs: { query: async () => [{ id: 1, windowId: 2, url: "https://example.test" }] },
    runtime: {
      get lastError() { errorReads++; return disconnectError; },
      getURL: () => "chrome-extension://recorder/",
      sendMessage: async message => { messages.push(message); },
      connect() {
        if (failConnect) throw new Error("Extension context invalidated");
        let onDisconnect;
        const port = {
          closed: false, sent: [],
          onDisconnect: { addListener: callback => { onDisconnect = callback; } },
          postMessage(message) {
            if (port.closed) throw new Error("Attempting to use a disconnected port object");
            port.sent.push(message);
          },
          disconnect() { port.closed = true; },
          drop() {
            port.closed = true;
            disconnectError = { message: "Message channel closed" };
            onDisconnect();
            disconnectError = undefined;
          }
        };
        ports.push(port);
        return port;
      }
    }
  };
  class Observer { observe() {} disconnect() {} }
  const context = vm.createContext({
    document, window, chrome,
    WorkflowRecorderProtocol: { MESSAGE: { setSidePanelLayout: "layout" } },
    matchMedia: () => Object.assign(eventTarget(), { matches: false }),
    ResizeObserver: Observer, MutationObserver: Observer,
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    console: { warn: (...args) => warnings.push(args) }
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "popup.js"), "utf8"), context);
  await document.fire("DOMContentLoaded");
  return {
    document, window, chrome, ports, messages, warnings, timers,
    get refreshes() { return refreshes; }, get errorReads() { return errorReads; },
    failConnect: () => { failConnect = true; },
    async runTimers() {
      const pending = [...timers.values()];
      timers.clear();
      await Promise.all(pending.map(callback => callback()));
    }
  };
}

test("a panel created hidden still initializes its draft and layout context", async () => {
  const h = await panelHarness({ visibilityState: "hidden" });
  assert.equal(h.refreshes, 1);
  assert.equal(h.ports.length, 1);
  assert.equal(h.messages[0].open, true);
});

test("visible panel reconnects, resends its layout and refreshes after disconnect", async () => {
  const h = await panelHarness();
  h.ports[0].drop();
  assert.equal(h.errorReads, 1);
  await h.runTimers();
  assert.equal(h.ports.length, 2);
  assert.equal(h.ports[1].sent[0].windowId, 2);
  assert.equal(h.messages.filter(message => message.open).length, 2);
  assert.equal(h.refreshes, 2);
  assert.deepEqual(h.warnings, []);
});

test("postMessage recovers a stale port before its disconnect event arrives", async () => {
  const h = await panelHarness();
  h.ports[0].closed = true;
  await h.window.fire("focus");
  assert.equal(h.ports.length, 2);
  assert.equal(h.refreshes, 2);
  h.ports[0].drop();
  await h.window.fire("focus");
  assert.equal(h.ports.length, 2, "a late old event does not discard the replacement");
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.warnings, []);
});

test("hidden panels defer reconnection until visible", async () => {
  const h = await panelHarness();
  h.document.visibilityState = "hidden";
  h.ports[0].drop();
  assert.equal(h.timers.size, 0);
  await h.window.fire("focus");
  assert.equal(h.ports.length, 1);
  h.document.visibilityState = "visible";
  await h.document.fire("visibilitychange");
  assert.equal(h.ports.length, 2);
  assert.equal(h.refreshes, 2);
});

test("layout failures still allow the panel to refresh its draft and steps", async () => {
  const h = await panelHarness();
  h.ports[0].drop();
  h.failConnect();
  await h.runTimers();
  assert.equal(h.refreshes, 2);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0][0], /Layout binding failed/);
  assert.equal(h.timers.size, 0, "an invalid extension context does not loop");
});

test("closing a panel cancels its reconnect and late disconnects", async () => {
  const h = await panelHarness();
  h.ports[0].drop();
  await h.window.fire("unload");
  assert.equal(h.timers.size, 0);
  await h.runTimers();
  h.ports[0].drop();
  assert.equal(h.timers.size, 0);
  assert.equal(h.ports.length, 1);
  assert.equal(h.refreshes, 1);
  assert.equal(h.messages.at(-1).open, false);
});

test("late tab queries cannot reconnect a panel after it closes", async () => {
  const h = await panelHarness();
  let resolveTab;
  h.chrome.tabs.query = () => new Promise(resolve => { resolveTab = resolve; });
  const focused = h.window.fire("focus");
  await h.window.fire("unload");
  resolveTab([{ id: 1, windowId: 2, url: "https://example.test" }]);
  await focused;
  assert.equal(h.ports.length, 1);
  assert.equal(h.ports[0].closed, true);
  assert.equal(h.messages.at(-1).open, false);
  assert.equal(h.refreshes, 1);
});

test("an old background layout port cannot restore over its replacement", async () => {
  const fits = [];
  let errorReads = 0;
  globalThis.chrome = {
    runtime: { get lastError() { errorReads++; return { message: "Channel closed" }; } },
    sidePanel: { setPanelBehavior: async () => {}, setOptions: async () => {} },
    scripting: { executeScript: async () => {} },
    tabs: {
      get: async id => ({ id, windowId: 2, url: "https://example.test" }),
      sendMessage: async (tabId, message) => { fits.push({ tabId, enabled: message.enabled }); }
    }
  };
  try {
    const { createSidePanelController } = await import("../background/side-panel.js");
    const controller = createSidePanelController({ isRecordableTab: () => true });
    const makePort = () => {
      const port = { name: "side-panel-layout",
        onMessage: { addListener: callback => { port.message = callback; } },
        onDisconnect: { addListener: callback => { port.drop = callback; } } };
      assert.equal(controller.trackLayoutPort(port), true);
      port.message({ windowId: 2 });
      return port;
    };
    const oldPort = makePort();
    await controller.setLayout({ open: true, tabId: 1, windowId: 2 });
    const newPort = makePort();
    await controller.setLayout({ open: true, tabId: 1, windowId: 2 });
    oldPort.drop();
    assert.equal(errorReads, 1);
    assert.deepEqual(fits.map(fit => fit.enabled), [true, true]);
    newPort.drop();
    assert.equal(errorReads, 2);
    assert.deepEqual(fits.at(-1), { tabId: 1, enabled: false });
  } finally {
    delete globalThis.chrome;
  }
});
