const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness() {
  let now = 1000;
  let observer;
  let loading = false;
  let onSleep = () => {};
  const listeners = new Map();
  const indicator = { isConnected: true, tagName: "DIV", classList: [], getBoundingClientRect: () => ({ width: 10, height: 10 }) };
  const context = {
    Symbol, Date: { now: () => now },
    setTimeout(callback, delay) {
      Promise.resolve().then(() => { now += delay; onSleep(now); callback(); });
    },
    document: {
      documentElement: {}, readyState: "complete",
      querySelectorAll: selector => loading && selector.startsWith('[aria-busy') ? [indicator] : [],
      addEventListener: (name, callback) => listeners.set(name, callback),
      removeEventListener: name => listeners.delete(name)
    },
    addEventListener() {}, removeEventListener() {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    RecorderClickEffects: { create: () => ({ observe() {}, stop() {}, interrupt() {} }) },
    MutationObserver: class {
      constructor(callback) { this.callback = callback; this.pending = []; observer = this; }
      observe() {} disconnect() {} takeRecords() { return this.pending.splice(0); }
    }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../content/stability.js"), "utf8"), context);
  const stability = context.RecorderPageStability.create();
  stability.start();
  return {
    stability, observer, listeners,
    advance: ms => { now += ms; },
    loading: value => { loading = value; },
    onSleep: callback => { onSleep = callback; },
    mutation(value, oldValue = "old") {
      observer.callback([{ type: "attributes", attributeName: "style", oldValue,
        target: { getAttribute: () => value } }]);
    }
  };
}

test("a page already quiet before the request needs no new quiet interval", async () => {
  const h = harness();
  h.advance(500);
  const result = await h.stability.waitForPageStable({ quietMs: 280 });
  assert.equal(result.stable, true);
  assert.equal(result.waitedMs, 0);
  assert.equal(result.lastChangeAt, 1000);
});

test("no-op attribute writes and the frame primer do not restart the quiet clock", async () => {
  const h = harness();
  h.advance(500);
  h.mutation("width: 100px", "width: 100px");
  h.observer.callback([{ type: "childList", target: {}, removedNodes: [],
    addedNodes: [{ [Symbol.for("workflow-recorder.screencast-frame-primer")]: true }] }]);
  assert.equal((await h.stability.waitForPageStable({ quietMs: 280 })).waitedMs, 0);
});

test("real changes, pending observer records and trusted user actions restart the quiet clock", async () => {
  const h = harness();
  h.advance(500);
  h.observer.pending.push({ type: "attributes", attributeName: "class", oldValue: "closed",
    target: { getAttribute: () => "open" } });
  const changed = await h.stability.waitForPageStable({ quietMs: 280 });
  assert.equal(changed.waitedMs, 280);
  assert.equal(changed.lastChangeAt, 1500);
  h.listeners.get("click")({ isTrusted: true });
  assert.equal((await h.stability.waitForPageStable({ quietMs: 220 })).waitedMs, 220);
  h.listeners.get("click")({ isTrusted: false });
  assert.equal((await h.stability.waitForPageStable({ quietMs: 220 })).waitedMs, 0);
});

test("an asynchronous loading result still waits for loading to end and the new DOM to settle", async () => {
  const h = harness();
  h.advance(500);
  h.loading(true);
  let finished = false;
  h.onSleep(now => {
    if (now >= 2200 && !finished) {
      finished = true;
      h.loading(false);
      h.mutation("display: block");
    }
  });
  const result = await h.stability.waitForPageStable({ quietMs: 280, timeoutMs: 2500 });
  assert.equal(result.stable, true);
  assert.ok(result.waitedMs >= 980);
  assert.equal(result.mutationCount, 1);
});

test("iframe actions supply a quiet boundary even when the outer page has stayed idle", async () => {
  const h = harness();
  h.advance(1000);
  const result = await h.stability.waitForPageStable({ quietMs: 280, activityAt: 1900 });
  assert.equal(result.waitedMs, 180);
  assert.equal(result.lastChangeAt, 1900);
});

test("persistent loading times out and stopping tracking cancels an active wait", async () => {
  const h = harness();
  h.loading(true);
  const result = await h.stability.waitForPageStable({ quietMs: 280, timeoutMs: 700 });
  assert.equal(result.timedOut, true);
  assert.equal(result.loadingIndicatorVisible, true);
  assert.equal(result.waitedMs, 700);
  h.onSleep(() => h.stability.stop());
  assert.equal((await h.stability.waitForPageStable()).cancelled, true);
});
