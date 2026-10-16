const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

function harness() {
  class Element {
    constructor(tag, parentElement = null, attrs = {}) {
      Object.assign(this, { tagName: tag.toUpperCase(), parentElement, attrs });
    }
    getAttribute(name) { return this.attrs[name] ?? null; }
    hasAttribute(name) { return name in this.attrs; }
  }
  const html = new Element("html");
  const body = new Element("body", html);
  const cursor = element => element.attrs.cursor || (element.parentElement ? cursor(element.parentElement) : "auto");
  const context = { Element, document: { body, documentElement: html },
    window: { getComputedStyle: element => ({ cursor: cursor(element) }) } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content", "targeting.js"), "utf8"), context);
  return { Element, body, targeting: context.RecorderTargeting };
}

test("inherited pointer cursors on SVG and text resolve to the containing button", () => {
  const { Element, body, targeting } = harness();
  const button = new Element("button", body, { cursor: "pointer" });
  const svg = new Element("svg", button);
  const pathNode = new Element("path", svg);
  for (const hit of [svg, pathNode, new Element("span", button)]) {
    assert.equal(targeting.getInteractableTarget(hit), button);
  }
});

test("explicit child handlers and editable boundaries keep their own identity", () => {
  const { Element, body, targeting } = harness();
  const button = new Element("button", body, { cursor: "pointer" });
  const child = new Element("span", button, { onclick: "customAction()" });
  assert.equal(targeting.getInteractableTarget(child), child);
  const editor = new Element("div", button);
  editor.isContentEditable = true;
  assert.equal(targeting.getInteractableTarget(editor), editor);
});

test("custom pointer controls and ARIA menu items remain recordable", () => {
  const { Element, body, targeting } = harness();
  const control = new Element("div", body, { cursor: "pointer" });
  const label = new Element("span", control);
  assert.equal(targeting.getInteractableTarget(label), control);
  assert.equal(targeting.isMeaningfulClickTarget(control), true);
  const item = new Element("div", body, { role: "menuitem" });
  assert.equal(targeting.getInteractableTarget(new Element("span", item)), item);
  assert.equal(targeting.getInteractableTarget(null), null);
});

test("unannotated custom controls are candidates even without pointer or inline handlers", () => {
  const { Element, body, targeting } = harness();
  const close = new Element("span", body, { class: "my-icon-close close", "data-v-a506f636": "" });
  assert.equal(targeting.getInteractableTarget(close), close);
  assert.equal(targeting.isMeaningfulClickTarget(close), true, "absence of DOM semantics does not prove a click is inert");
  assert.equal(targeting.isMeaningfulClickTarget(body), false);
  assert.equal(targeting.isMeaningfulClickTarget(body.parentElement), false);
  assert.equal(targeting.isMeaningfulClickTarget(null), false);
});
