const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function harness() {
  let now = 1000;
  let nextTimer = 0;
  const timers = new Map();
  const results = [];
  const root = {};
  const body = { parentElement: root };
  const context = { Date: { now: () => now }, innerWidth: 1000, innerHeight: 700, document: { body, documentElement: root },
    setTimeout: (run, delay) => { timers.set(++nextTimer, { run, at: now + delay }); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    getComputedStyle: node => ({ display: node.attrs.class === "hidden" ? "none" : "block", visibility: "visible" }),
    RecorderTargeting: { hasClickSemantics: node => !!node.strong }
  };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content/click-effects.js"), "utf8"), context);
  const effects = context.RecorderClickEffects.create({ onFinish: observation => results.push({ id: observation.id, ...observation.result }) });
  function element(parentElement = body, attrs = {}, strong = false) {
    return { nodeType: 1, tagName: "DIV", parentElement, attrs, strong, isConnected: true,
      getAttribute: name => attrs[name] ?? null,
      contains(node) { for (let current = node; current; current = current.parentElement) if (current === this) return true; return false; } };
  }
  function attribute(node, name, value) {
    const oldValue = node.getAttribute(name);
    node.attrs[name] = value;
    effects.observe([{ type: "attributes", attributeName: name, target: node, oldValue }]);
  }
  return { effects, results, element, attribute, timers, context,
    tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.run(); } } };
}

test("blank clicks ignore background class changes, same-value writes, layout and focus colour", async () => {
  const h = harness();
  const background = h.element(null, { class: "active" });
  h.effects.begin("blank", background, 0);
  h.attribute(background, "class", "active");
  h.attribute(background, "class", "next-slide");
  h.attribute(background, "style", "width:800px;zoom:0.8;background-color:white");
  h.attribute(h.element(), "style", "background-color:white");
  h.tick(1200);
  assert.equal((await h.effects.wait("blank")).changed, false);
  assert.equal(h.results[0].reason, "timeout");
});

test("a later input focus or click cannot supply evidence for an earlier blank click", async () => {
  const h = harness();
  h.effects.begin("first", h.element(), 0);
  h.tick(300);
  h.effects.interrupt("next-interaction");
  h.effects.begin("second", h.element(), 0);
  h.effects.observe([{ type: "childList", target: {}, addedNodes: [h.element()], removedNodes: [] }]);
  assert.equal((await h.effects.wait("first")).changed, false);
  assert.equal((await h.effects.wait("first")).interrupted, true);
  assert.equal((await h.effects.wait("second")).changed, true);
});

test("JS-only close controls retain ancestor removal and class-based hiding", async () => {
  const h = harness();
  const dialog = h.element();
  const close = h.element(dialog);
  h.effects.begin("hide", close, 0);
  h.attribute(dialog, "class", "hidden");
  assert.equal((await h.effects.wait("hide")).changed, true);
  h.effects.begin("remove", h.element(), 1);
  h.effects.observe([{ type: "childList", target: {}, addedNodes: [], removedNodes: [dialog] }]);
  assert.equal((await h.effects.wait("remove")).changed, true);
});

test("a semantic control retains its own class state but cannot borrow an unrelated background class", async () => {
  const h = harness();
  const button = h.element(null, { class: "" }, true);
  h.effects.begin("button", button, 0);
  h.attribute(h.element(), "class", "active");
  assert.equal(h.results.length, 0);
  h.attribute(button, "class", "pressed");
  assert.equal((await h.effects.wait("button")).changed, true);
});

test("worker delays cannot extend the page's observation deadline and resize ends it", async () => {
  const h = harness();
  h.effects.begin("expired", h.element(), 0);
  h.tick(1300);
  h.effects.observe([{ type: "childList", target: {}, addedNodes: [h.element()], removedNodes: [] }]);
  assert.equal((await h.effects.wait("expired")).changed, false);
  h.effects.begin("resize", h.element(), 0);
  h.effects.interrupt("viewport-resize");
  assert.equal((await h.effects.wait("resize")).interrupted, true);
  h.effects.stop();
  assert.equal(h.timers.size, 0);
});

test("responsive DOM rebuilding is rejected even before the resize listener runs", async () => {
  const h = harness();
  h.effects.begin("responsive", h.element(), 0);
  h.context.innerHeight = 644;
  h.effects.observe([{ type: "childList", target: {}, addedNodes: [h.element()], removedNodes: [] }]);
  const result = await h.effects.wait("responsive");
  assert.equal(result.changed, false);
  assert.equal(result.reason, "viewport-resize");
});
