const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadAnalyzer() {
  const analyzerPath = path.join(__dirname, "..", "content", "analyzer.js");
  const source = fs.readFileSync(analyzerPath, "utf8");
  const context = { window: { innerWidth: 1280, innerHeight: 720 } };
  context.window.self = context.window;
  context.window.top = context.window;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.SemanticElementAnalyzer;
}

test("bounding boxes carry their top-level viewport coordinate system", () => {
  const analyzer = loadAnalyzer();
  const box = analyzer.getBoundingBox({
    getBoundingClientRect: () => ({ x: 12.4, y: 30.6, width: 99.5, height: 40.2 })
  });

  assert.deepEqual(JSON.parse(JSON.stringify(box)), {
    x: 12,
    y: 31,
    width: 100,
    height: 40,
    viewportWidth: 1280,
    viewportHeight: 720,
    coordinateSpace: "top-viewport"
  });
});

// Minimal DOM stub good enough for name computation on text-only elements
function fakeElement({ tag, text = "", attrs = {} } = {}) {
  return {
    tagName: tag,
    childNodes: [],
    textContent: text,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute(name) { return attrs[name] !== undefined ? attrs[name] : null; },
    hasAttribute(name) { return attrs[name] !== undefined; }
  };
}

test("generic elements do not invent an accessible name from container text", () => {
  const analyzer = loadAnalyzer();

  // A plain div is not an accessibility label merely because it has text.
  const placeholder = fakeElement({ tag: "DIV", text: "点击此处新建流程" });
  assert.equal(analyzer.computeAccessibleName(placeholder), null);

  // Long container text is not a label; leave unnamed (skeleton carries it)
  const verbose = fakeElement({ tag: "DIV", text: "x".repeat(81) });
  assert.equal(analyzer.computeAccessibleName(verbose), null);
});

test("explicit aria-label provides the semantic name", () => {
  const analyzer = loadAnalyzer();
  const el = fakeElement({ tag: "DIV", text: "内部文字", attrs: { "aria-label": "外部标签" } });
  assert.equal(analyzer.computeAccessibleName(el), "外部标签");
});

test("sanitizeHTML collapses inline SVG and strips style/on* attributes", () => {
  const analyzer = loadAnalyzer();

  const raw = '<li role="option" class="ant-select-dropdown-menu-item" unselectable="on" fiber-id="connect_menuitem_3" style="user-select: none;"> 测试用户(示例部门) <i aria-label="图标: check" class="anticon anticon-check"><svg viewBox="64 64 896 896" width="1em"><path d="M912 190h-69.9c-9.8 0-19.1 4.5-25.1 12.2L404.7 724.5 207 474a32 32 0 0 0-25.1-12.2H112c-6.7 0-10.4 7.7-6.3 12.9l273.9 347c12.8 16.2 37.4 16.2 50.3 0l488.4-618.9c4.1-5.1.4-12.8-6.3-12.8z"></path></svg></i></li>';

  const out = analyzer.sanitizeHTML(raw, 800);

  // The option text must survive; the SVG path data must not
  assert.match(out, /测试用户\(示例部门\)/);
  assert.doesNotMatch(out, /M912 190/);
  assert.match(out, /<svg\/>/);
  // style attribute stripped, other attributes kept
  assert.doesNotMatch(out, /style\s*=/i);
  assert.match(out, /role="option"/);
  assert.match(out, /aria-label="图标: check"/);
});

test("sanitizeHTML truncates very long content and keeps null for empty input", () => {
  const analyzer = loadAnalyzer();

  assert.equal(analyzer.sanitizeHTML(null, 100), null);
  assert.equal(analyzer.sanitizeHTML("", 100), null);

  const long = "<div>" + "x".repeat(500) + "</div>";
  const out = analyzer.sanitizeHTML(long, 100);
  assert.ok(out.length <= 103);
  assert.match(out, /\.\.\.$/);
});

test("ancestor DOM context preserves late test hooks ahead of presentation attributes", () => {
  const element = fakeElement({ tag: "BUTTON", attrs: {
    class: "one two three four five", title: "Details", href: "/old", src: "/icon", type: "button", placeholder: "hint",
    "data-render-count": "42", "data-testid": "branch-toggle", "aria-label": "Choose branch"
  } });
  const tag = loadAnalyzer().renderOpenTag(element);
  assert.match(tag, /data-testid="branch-toggle"/);
  assert.match(tag, /aria-label="Choose branch"/);
  assert.ok(tag.endsWith(">"));
});
