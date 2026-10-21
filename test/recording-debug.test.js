const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function stabilityHarness() {
  const logged = [];
  const listeners = new Map();
  let observer;
  const root = { tagName: "HTML", classList: [], clientWidth: 1000, clientHeight: 700,
    scrollWidth: 1000, style: { getPropertyValue: () => "" } };
  const context = {
    URL, Symbol, Date, Math, setTimeout, clearTimeout, innerWidth: 1000, innerHeight: 700,
    console: { debug() {} }, location: { href: "https://example.test/login?token=private#secret" },
    getComputedStyle: element => ({ display: element.display || "block", visibility: "visible" }),
    document: { documentElement: root, addEventListener: (key, fn) => listeners.set(key, fn),
      removeEventListener: key => listeners.delete(key) },
    addEventListener: (key, fn) => listeners.set(key, fn), removeEventListener: key => listeners.delete(key),
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.pending = []; observer = this; }
      takeRecords() { return this.pending.splice(0); }
      observe(options, config) { this.config = config; }
      disconnect() {}
    }
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["shared/protocol.js", "content/click-effects.js", "content/stability.js"]) {
    let source = fs.readFileSync(path.join(__dirname, "..", file), "utf8");
    // Exercise the opt-in diagnostic build without enabling it in shared builds.
    if (file === "shared/protocol.js") source = source.replace("const RECORDING_DEBUG_ENABLED = false;", "const RECORDING_DEBUG_ENABLED = true;");
    vm.runInContext(source, context);
  }
  context.WorkflowRecorderProtocol.setRecordingDebugSink(entry => logged.push(entry));
  const stability = context.RecorderPageStability.create();
  stability.start();
  return { context, stability, logged, listeners, observer,
    element: (id, style = "") => ({ nodeType: 1, tagName: "DIV", id, classList: [], parentElement: root, isConnected: true,
      value: "private-password", textContent: "private-text", getAttribute: name => name === "style" ? style : "active" }) };
}

test("click diagnostics separate pre-click mutations from accepted structural evidence and retain viewport events", async () => {
  const h = stabilityHarness();
  const target = h.element("login-background");
  h.observer.pending.push({ type: "attributes", attributeName: "class", oldValue: "", target });
  const baseline = h.stability.getEffectVersion();
  const clickId = h.stability.traceClick({ target, clientX: 20, clientY: 30 }, target, baseline);
  h.observer.callback([{ type: "attributes", attributeName: "style", oldValue: "width: 1000px",
    target: h.element("carousel", "width: 850px; background-image: url(https://secret.test/token); --secret: private") }]);
  h.observer.callback([{ type: "childList", target, addedNodes: [h.element("dialog")], removedNodes: [] }]);
  assert.equal((await h.stability.waitForClickEffect(baseline, 200, clickId)).changed, true);
  const result = h.logged.find(item => item.event === "click-dom-result").detail;
  assert.equal(result.clickId, clickId);
  assert.equal(result.mutations.length, 2);
  assert.equal(result.mutations[0].samples[0].target, "div#carousel");
  assert.equal(result.mutations[0].samples[0].before, "width: 1000px");
  assert.equal(result.mutations[0].samples[0].after, "width: 850px");
  assert.equal(result.acceptedMutations[0].type, "childList");
  h.context.innerWidth = 850;
  h.listeners.get("resize")();
  assert.equal(h.logged.find(item => item.event === "viewport-resize").detail.viewport.width, 850);
  const json = JSON.stringify(h.logged);
  assert.doesNotMatch(json, /private|secret|token/);
  assert.match(json, /https:\/\/example.test\/login/);
  assert.equal(h.observer.config.attributeOldValue, true);
  h.stability.stop();
  assert.equal(h.listeners.size, 0);
});

test("diagnostics preserve no-effect decisions and exclude the recorder's frame primer", async () => {
  const h = stabilityHarness();
  const baseline = h.stability.getEffectVersion();
  const clickId = h.stability.traceClick({ target: h.element("inert") }, h.element("inert"), baseline);
  h.observer.callback([{ type: "childList", target: {}, addedNodes: [
    { [Symbol.for("workflow-recorder.screencast-frame-primer")]: true }
  ], removedNodes: [] }]);
  h.listeners.get("pointerdown")({ isTrusted: true });
  assert.equal((await h.stability.waitForClickEffect(baseline, 200, clickId)).changed, false);
  const result = h.logged.find(item => item.event === "click-dom-result").detail;
  assert.equal(result.changed, false);
  assert.equal(result.mutations.length, 0);
  h.stability.stop();
});

test("diagnostic mutation samples stay bounded on a noisy page", async () => {
  const h = stabilityHarness();
  const baseline = h.stability.getEffectVersion();
  const clickId = h.stability.traceClick({ target: h.element("inert") }, h.element("inert"), baseline);
  for (let i = 0; i < 100; i++) {
    h.observer.callback(Array.from({ length: 50 }, () => ({ type: "attributes", attributeName: "class",
      oldValue: "x".repeat(500), target: h.element("y".repeat(500)) })));
  }
  h.listeners.get("pointerdown")({ isTrusted: true });
  await h.stability.waitForClickEffect(baseline, 200, clickId);
  const result = h.logged.find(item => item.event === "click-dom-result");
  assert.equal(result.detail.historyTruncated, true);
  assert.ok(JSON.stringify(result).length < 12000);
  h.stability.stop();
});

function storageHarness() {
  const data = {};
  return { data, storage: { get: async key => structuredClone({ [key]: data[key] }),
    set: async values => Object.assign(data, structuredClone(values)) } };
}

test("debug timeline caps history, survives a worker restart, and exports pending events", async () => {
  const { createRecordingDebugStore, MAX_DEBUG_EVENTS } = await import("../background/store/recording-debug.js");
  const h = storageHarness();
  const store = createRecordingDebugStore(h);
  for (let i = 0; i < MAX_DEBUG_EVENTS + 10; i++) await store.append({ event: "click", detail: { number: i } });
  const exported = await store.read();
  assert.equal(exported.events.length, MAX_DEBUG_EVENTS);
  assert.equal(exported.dropped, 10);
  assert.equal(exported.events[0].detail.number, 10);
  assert.equal(exported.events.at(-1).detail.number, MAX_DEBUG_EVENTS + 9);
  const restarted = createRecordingDebugStore(h);
  assert.equal((await restarted.read()).events.length, MAX_DEBUG_EVENTS);
  await restarted.append({ event: "pending" });
  await restarted.clear();
  assert.equal((await restarted.read()).events.length, 0);
});

test("debug timeline bounds storage size even with large valid events", async () => {
  const { createRecordingDebugStore } = await import("../background/store/recording-debug.js");
  const store = createRecordingDebugStore(storageHarness());
  for (let i = 0; i < 100; i++) await store.append({ event: "mutation", detail: { sample: "a".repeat(7000) } });
  const exported = await store.read();
  assert.ok(exported.events.length < 100);
  assert.ok(JSON.stringify(exported.events).length * 2 < 601000);
  assert.ok(exported.dropped > 0);
});
