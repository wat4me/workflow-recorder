const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function harness() {
  class Element {
    constructor(value, editor = false, attrs = {}) {
      this.tagName = editor ? "DIV" : "INPUT";
      this.isContentEditable = editor;
      this.isConnected = true;
      this.attrs = attrs;
      this.setValue(value);
    }
    setValue(value) { this.value = this.innerText = this.textContent = value; }
    getAttribute(name) { return this.attrs?.[name] ?? null; }
    closest() { return this.isContentEditable ? this : null; }
  }
  const timers = new Map();
  let nextTimer = 0;
  const actions = [];
  const context = {
    Element, document: { activeElement: null },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
    SemanticElementAnalyzer: { analyze: () => ({ tagName: "input" }) }
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ["targeting.js", "input-recorder.js"]) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, "../content", file), "utf8"), context);
  }
  const recorder = context.RecorderInputRecorder.create({ recordAction: action => actions.push(action) });
  return { recorder, actions, field: (value = "", editor = false, attrs = {}) => new Element(value, editor, attrs),
    focus(field) { context.document.activeElement = field; recorder.handleFocus({ target: field, isTrusted: true }); },
    edit(field, value) {
      recorder.handleBeforeInput({ target: field, isTrusted: true });
      field.setValue(value);
      recorder.handleInput({ target: field, isTrusted: true });
    },
    runTimers() { const pending = [...timers.values()]; timers.clear(); for (const callback of pending) callback(); }
  };
}

test("clicking and leaving an unchanged empty, filled or filler-only field records no input", () => {
  for (const editor of [false, true]) {
    for (const value of ["", "existing text", "\u200b", "\ufeff", " \u200b\n"]) {
      const h = harness();
      const field = h.field(value, editor);
      h.focus(field);
      h.recorder.markUserTouched(field);
      h.recorder.handleBlur({ target: field });
      h.recorder.scheduleCommittedCheck();
      h.runTimers();
      h.recorder.flush();
      assert.equal(h.actions.length, 0, `${editor ? "editor" : "input"}: ${JSON.stringify(value)}`);
    }
  }
});

test("an editor replacing an empty paragraph with fillers produces no typing step", () => {
  const h = harness();
  const field = h.field("", true);
  h.focus(field);
  h.edit(field, "\u200b");
  h.runTimers();
  h.edit(field, "\u200b\ufeff\n");
  h.recorder.flush();
  assert.equal(h.actions.length, 0);
  h.edit(field, "real content");
  h.recorder.flush();
  assert.equal(h.actions[0].value, "real content");
});

test("clearing existing text, including to an editor filler, records an empty value once", () => {
  for (const editor of [false, true]) {
    const h = harness();
    const field = h.field("existing", editor);
    h.focus(field);
    h.edit(field, editor ? "\u200b" : "");
    h.recorder.flush();
    h.recorder.handleBlur({ target: field });
    assert.equal(h.actions.length, 1);
    assert.equal(h.actions[0].value, "");
  }
});

test("a click's script-driven clear is recorded only if the click cannot account for it", () => {
  for (const accepted of [true, false]) {
    const h = harness();
    const field = h.field();
    h.focus(field);
    h.edit(field, "search text");
    h.recorder.scheduleCommittedCheck(() => accepted);
    field.setValue("");
    h.recorder.handleInput({ target: field, isTrusted: false });
    h.recorder.handleBlur({ target: field });
    h.runTimers();
    assert.deepEqual(h.actions.map(action => action.value), accepted ? ["search text"] : ["search text", ""]);
  }
});

test("a trusted deletion stays an input step after a click that left the value intact", () => {
  const h = harness();
  const field = h.field("search text");
  h.focus(field);
  h.recorder.markUserTouched(field);
  h.recorder.scheduleCommittedCheck(() => true);
  h.edit(field, "");
  h.recorder.flush();
  assert.deepEqual(h.actions.map(action => action.value), [""]);
});

test("normal typing retains spaces, inline zero-width characters and emoji joiners", () => {
  for (const value of ["  ", "  padded text  ", "a\u200bb", "\u200btext\u200b", "👩\u200d💻"]) {
    const h = harness();
    const field = h.field();
    h.focus(field);
    h.edit(field, value);
    h.runTimers();
    assert.equal(h.actions.length, 1);
    assert.equal(h.actions[0].value, value);
  }
});

test("native autofill remains recordable without beforeinput or a focus baseline", () => {
  for (const focused of [true, false]) {
    const h = harness();
    const field = h.field();
    if (focused) h.focus(field);
    field.setValue("autofilled account");
    h.recorder.handleInput({ target: field, isTrusted: true });
    h.recorder.flush();
    assert.equal(h.actions[0].value, "autofilled account");
  }
  const h = harness();
  const field = h.field();
  h.focus(field);
  field.setValue("autofilled through change");
  h.recorder.handleChange({ target: field, isTrusted: true });
  assert.equal(h.actions[0].value, "autofilled through change");
});

test("synthetic events cannot admit a previously untouched field", () => {
  const h = harness();
  const field = h.field();
  h.recorder.handleBeforeInput({ target: field, isTrusted: false });
  field.setValue("script value");
  h.recorder.handleInput({ target: field, isTrusted: false });
  h.recorder.handleChange({ target: field, isTrusted: false });
  h.recorder.handleBlur({ target: field });
  h.runTimers();
  assert.equal(h.actions.length, 0);
});

test("refocusing a field snapshots its new initial value without suppressing later edits", () => {
  const h = harness();
  const field = h.field();
  h.focus(field);
  h.edit(field, "first input");
  h.recorder.flush();
  field.setValue("page restored value");
  h.focus(field);
  h.recorder.markUserTouched(field);
  h.recorder.handleBlur({ target: field });
  assert.equal(h.actions.length, 1);
  h.edit(field, "second input");
  h.recorder.flush();
  assert.equal(h.actions[1].value, "second input");
});

test("a script-dispatched select change is not a step, a trusted one is", () => {
  const h = harness();
  const select = h.field("b");
  select.tagName = "SELECT";
  select.options = [{ text: "A", value: "a" }, { text: "B", value: "b" }];
  select.selectedIndex = 1;
  h.recorder.handleChange({ target: select, isTrusted: false });
  assert.equal(h.actions.length, 0);
  h.recorder.handleChange({ target: select, isTrusted: true });
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, "select");
  assert.equal(h.actions[0].value, "b");
  assert.equal(h.actions[0].label, "B");
});

test("date inputs commit their picked value as a type step", () => {
  const h = harness();
  const date = h.field("", false, { type: "date" });
  h.focus(date);
  date.setValue("2026-11-04");
  h.recorder.handleChange({ target: date, isTrusted: true });
  assert.equal(h.actions.length, 1);
  assert.equal(h.actions[0].type, "type");
  assert.equal(h.actions[0].value, "2026-11-04");
});
