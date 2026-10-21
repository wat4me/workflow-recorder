const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function harness({ control = false, cursor = "auto" } = {}) {
  const actions = [];
  class Element {
    constructor() { Object.assign(this, { x: 0, y: 0, isConnected: true, parentNode: {}, nextSibling: null }); }
    closest() { return control ? this : null; }
    getBoundingClientRect() { return { x: this.x, y: this.y, left: this.x, top: this.y, width: 100, height: 50 }; }
  }
  const source = new Element();
  const context = { Element, Date, innerWidth: 1000, innerHeight: 700, scrollX: 0, scrollY: 0,
    document: { body: {}, documentElement: {}, elementFromPoint: () => source },
    getComputedStyle: () => ({ cursor }), getSelection: () => ({ isCollapsed: true }),
    SemanticElementAnalyzer: { analyze: element => ({ x: element.x }) },
    RecorderTargeting: { getDragSourceElement: element => element, getDragTargetElement: element => element,
      makePointerPoint: event => ({ x: event.clientX, y: event.clientY }) } };
  context.window = context;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "content/drag-recorder.js"), "utf8"), context);
  const recorder = context.RecorderDragRecorder.create({ isRecording: () => true,
    recordAction: action => actions.push(action), getInteractableTarget: element => element });
  const event = (x = 0, y = 0) => ({ target: source, button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: y });
  return { source, recorder, actions, event, context,
    down: () => recorder.handlePointerDown(event()),
    up: distance => { recorder.handlePointerMove(event(distance)); recorder.handlePointerUp(event(distance)); } };
}

test("moving over an inert background is not a drag even past the distance threshold", () => {
  for (const distance of [10, 22, 238]) {
    const h = harness();
    h.down();
    h.up(distance);
    assert.equal(h.actions.length, 0);
    assert.equal(h.recorder.shouldSuppressClick(), true);
  }
});

test("marked controls, drag cursors and native drags remain recordable", () => {
  for (const options of [{ control: true }, { cursor: "grab" }, { cursor: "col-resize" }]) {
    const h = harness(options);
    h.down();
    h.up(20);
    assert.equal(h.actions.length, 1);
  }
  const h = harness();
  h.recorder.handleNativeDragStart(h.event());
  h.recorder.handleNativeDragEnd(h.event(20));
  assert.equal(h.actions.length, 1);
});

test("unannotated JS drag controls record actual movement or reordering", () => {
  for (const move of [h => { h.source.x = 20; }, h => { h.source.parentNode = {}; }, h => { h.source.isConnected = false; }]) {
    const h = harness();
    h.down();
    move(h);
    h.up(20);
    assert.equal(h.actions.length, 1);
  }
  const h = harness();
  h.down();
  h.source.x = 20;
  h.context.innerWidth = 800;
  h.up(20);
  assert.equal(h.actions.length, 0, "layout movement during a viewport resize is not a custom drag");
});
