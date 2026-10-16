const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness(originalZoom = "") {
  const timers = new Map();
  const listeners = new Map();
  let nextTimer = 0;
  let observer;
  let measurements = 0;
  let now = 0;
  const properties = new Map(originalZoom ? [["zoom", [originalZoom, "important"]]] : []);
  const root = {
    scrollWidth: 2400, clientWidth: 1000,
    getBoundingClientRect: () => { measurements++; return { width: 1000 }; },
    style: {
      getPropertyValue: key => properties.get(key)?.[0] || "",
      getPropertyPriority: key => properties.get(key)?.[1] || "",
      setProperty: (key, value, priority) => properties.set(key, [value, priority]),
      removeProperty: key => properties.delete(key)
    }
  };
  const context = {
    Date: { now: () => now },
    innerWidth: 1000, document: { documentElement: root },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
    ResizeObserver: class {
      constructor(fn) { observer = this; this.callback = fn; this.disconnected = false; }
      observe() {}
      disconnect() { this.disconnected = true; }
    }
  };
  context.window = context;
  context.top = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content", "page-fit.js"), "utf8"), context);
  return {
    controller: context.RecorderPageFit.create(), root, context, timers, listeners,
    measured: () => measurements,
    advance: ms => { now += ms; },
    observer: () => observer,
    runTimer() {
      const [id, fn] = timers.entries().next().value;
      timers.delete(id);
      fn();
    }
  };
}

test("page fit ignores its own resize even when expensive layout exceeds a timer window", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.observer().callback();
  assert.equal(h.timers.size, 1, "initial resize does not postpone the pending fit");
  h.runTimer();
  assert.equal(h.root.style.getPropertyValue("zoom"), String(1000 / 2400));
  h.root.clientWidth = 2400; // The fitted root now fits its CSS viewport.
  h.advance(500); // The page's layout exceeded the previous 120ms suppression.
  for (let i = 0; i < 20; i++) h.observer().callback();
  assert.equal(h.timers.size, 0, "a fitted page never feeds back into restore/measure/zoom");
  h.controller.setEnabled(true);
  assert.equal(h.timers.size, 0, "duplicate panel handshakes do not remeasure the page");
  assert.equal(h.measured(), 1);
});

test("page fit still responds to viewport changes and new horizontal overflow", () => {
  const h = harness();
  h.controller.setEnabled(true);
  h.runTimer();
  h.root.clientWidth = 2400;
  h.root.scrollWidth = 3000;
  h.observer().callback();
  assert.equal(h.timers.size, 1);
  h.runTimer();
  assert.equal(h.root.style.getPropertyValue("zoom"), String(1000 / 3000));
  h.context.innerWidth = 800;
  h.listeners.get("resize")();
  h.runTimer();
  assert.equal(h.root.style.getPropertyValue("zoom"), String(800 / 3000));
});

test("closing the panel cancels pending fitting and restores original zoom and priority", () => {
  for (const original of ["", "1.25"]) {
    const h = harness(original);
    h.controller.setEnabled(true);
    h.runTimer();
    h.listeners.get("resize")();
    h.controller.setEnabled(false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.observer().disconnected, true);
    assert.equal(h.root.style.getPropertyValue("zoom"), original);
    assert.equal(h.root.style.getPropertyPriority("zoom"), original ? "important" : "");
    h.controller.setEnabled(true);
    assert.equal(h.timers.size, 1, "reopening performs a fresh fit");
  }
});
