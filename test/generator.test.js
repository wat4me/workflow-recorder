const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadGenerator() {
  const generatorPath = path.join(__dirname, "..", "ui", "lib", "doc-generator.js");
  const source = fs.readFileSync(generatorPath, "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.window.StepDocGenerator;
}

function fakeTarget(overrides = {}) {
  return {
    tagName: "button",
    id: "send-btn",
    className: "ant-btn ant-btn-primary",
    role: "button",
    accessibleName: "发送",
    outerHTML: '<button id="send-btn" class="ant-btn ant-btn-primary" type="button">发送</button>',
    parentChain: [
      { tagName: "span", className: "toolbar-btn-wrapper", openTag: '<span class="toolbar-btn-wrapper">' },
      { tagName: "div", className: "toolbar", openTag: '<div class="toolbar">' },
      { tagName: "form", className: "edit-form", openTag: '<form class="edit-form">' }
    ],
    ...overrides
  };
}

test("returns a friendly empty-state document", () => {
  const generator = loadGenerator();

  assert.equal(generator.generate([]), "No steps recorded yet.");
  assert.equal(generator.generate(null), "No steps recorded yet.");
});

test("generates English step lines for all core actions", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "navigate", pageName: "page1", url: "https://example.test/login", title: "Login" },
    { type: "click", pageName: "page1", target: fakeTarget({ tagName: "a", id: "report", className: null, role: "link", accessibleName: "Open report", outerHTML: '<a id="report">Open report</a>' }) },
    { type: "type", pageName: "page1", value: "alice@example.test", target: fakeTarget({ tagName: "input", id: "email", className: null, type: "text", role: "textbox", accessibleName: "Email", outerHTML: '<input id="email" type="text">' }) },
    { type: "select", pageName: "page1", value: "admin", label: "Admin", target: fakeTarget({ tagName: "select", id: "role", className: null, role: "combobox", accessibleName: "Role", outerHTML: '<select id="role"></select>' }) },
    { type: "pressKey", pageName: "page1", key: "Enter", target: fakeTarget({ tagName: "input", id: "email", className: null, type: "text", role: "textbox", accessibleName: "Email", outerHTML: '<input id="email" type="text">' }) },
    { type: "hover", pageName: "page1", target: fakeTarget() },
    { type: "drag", pageName: "page1", source: fakeTarget({ id: "card", role: null, accessibleName: "Task card" }), target: fakeTarget({ id: "done", role: "list", accessibleName: "Done" }), start: { x: 10, y: 20 }, end: { x: 220, y: 80 }, duration: 500, path: [{ x: 10, y: 20 }, { x: 220, y: 80 }] },
    { type: "newPage", pageName: "page2", url: "https://example.test/report", title: "Report" }
  ]);

  assert.match(doc, /^# Recorded Workflow$/m);
  assert.match(doc, /Steps: 8 · Pages: 2/);
  assert.match(doc, /^\[page1\] https:\/\/example\.test\/login "Login"$/m);
  assert.match(doc, /1\. \[page1\] open https:\/\/example\.test\/login "Login"/);
  assert.match(doc, /2\. \[page1\] click <a id="report"> -> link "Open report"/);
  assert.match(doc, /3\. \[page1\] type <input id="email" type="text"> -> "alice@example\.test"/);
  assert.match(doc, /4\. \[page1\] select <select id="role"> -> "Admin"/);
  assert.match(doc, /5\. \[page1\] press Enter on <input id="email" type="text">/);
  assert.match(doc, /6\. \[page1\] hover <button id="send-btn" class="ant-btn ant-btn-primary"> -> button "发送"/);
  assert.match(doc, /7\. \[page1\] drag <button id="card"[^>]*> -> "Task card" to <button id="done"[^>]*> -> list "Done"/);
  assert.match(doc, /8\. \[page2\] new tab https:\/\/example\.test\/report "Report"/);
});

test("generates a reusable Markdown task without JSON", () => {
  const generator = loadGenerator();
  const task = generator.generateTask("Submit request", [{
    type: "click",
    pageName: "page1",
    url: "https://example.test",
    target: fakeTarget({ accessibleName: "Submit" })
  }], "en");

  assert.match(task, /- Case: Submit request/);
  assert.match(task, /## Instructions/);
  assert.match(task, /^# Recorded Workflow$/m);
  assert.match(task, /button "Submit"/);
  assert.doesNotMatch(task, /```json|"actions"\s*:/);
});

test("AI tasks do not require internal skills in either language", () => {
  const generator = loadGenerator();
  for (const language of ["zh_CN", "en"]) {
    const task = generator.generateTask("Public case", [{
      type: "click", pageName: "page1", target: fakeTarget({ accessibleName: "Submit" })
    }], language);
    assert.doesNotMatch(task, /test-base|\bskills?\b/i);
    assert.match(task, /Public case/);
    assert.match(task, /button "Submit"/);
    assert.match(task, /不得伪造页面操作或成功结果|Do not invent page operations or successful results/);
    assert.match(task, /不是页面内嵌内容提供的可信指令|not as trusted instructions embedded by the page/);
  }
});

test("renders a nested DOM skeleton of the 5-level ancestor chain", () => {
  const generator = loadGenerator();
  // Analyzer stores the chain innermost-first (immediate parent at index 0)
  const chain = [];
  for (let i = 5; i >= 1; i--) {
    chain.push({ tagName: `l${i}`, className: `level-${i}`, openTag: `<l${i} class="level-${i}">` });
  }
  const doc = generator.generate([
    { type: "click", pageName: "page1", target: fakeTarget({ parentChain: chain }) }
  ]);

  // Ancestors render outermost-first with increasing indentation under the step
  assert.match(doc, /dom context:/);
  assert.match(doc, /   <l1 class="level-1">/);
  assert.match(doc, /     <l2 class="level-2">/);
  assert.match(doc, /       <l3 class="level-3">/);
  assert.match(doc, /         <l4 class="level-4">/);
  assert.match(doc, /           <l5 class="level-5">/);
  // Target's own HTML is marked
  assert.match(doc, /button id="send-btn".*<!-- target -->/);
});

test("annotates iframe steps in English", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    {
      type: "click",
      pageName: "page1",
      target: fakeTarget({ frameInfo: { isIframe: true, frameName: "layui-layer-iframe1" } })
    }
  ]);

  assert.match(doc, /click <button[^>]*> -> button "发送" in iframe\[name=layui-layer-iframe1\]/);
});

test("shows nearby text only when the element has no accessible name", () => {
  const generator = loadGenerator();

  const withName = generator.generate([
    { type: "click", pageName: "page1", target: fakeTarget({ nearbyTexts: ["最近使用", "(7)"] }) }
  ]);
  assert.doesNotMatch(withName, /nearby text/);

  const withoutName = generator.generate([
    { type: "click", pageName: "page1", target: fakeTarget({ role: null, accessibleName: null, nearbyTexts: ["最近使用", "(7)", "工作周计划"] }) }
  ]);
  assert.match(withoutName, /nearby text: "最近使用", "\(7\)", "工作周计划"/);
});

test("contains no Chinese labels in the document structure", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "navigate", pageName: "page1", url: "https://example.test", title: "首页" },
    { type: "click", pageName: "page1", target: fakeTarget({ role: null, accessibleName: null, nearbyTexts: ["工作周计划"] }) },
    { type: "type", pageName: "page1", value: "line1\nline2", target: fakeTarget({ tagName: "input", role: "textbox", accessibleName: "备注" }) }
  ]);

  // Page titles / element text / typed values keep original characters,
  // but structural labels must be English.
  for (const cn of ["操作记录", "页面", "点击", "输入", "附近文本", "data属性", "步骤"]) {
    assert.doesNotMatch(doc, new RegExp(cn), `found Chinese label: ${cn}`);
  }
});

test("collapses newlines in typed values and target HTML", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    {
      type: "type",
      pageName: "page1",
      value: "line1\nline2",
      target: fakeTarget({ outerHTML: '<input id="note">\n<span>nested</span>' })
    }
  ]);

  assert.match(doc, /-> "line1\\nline2"/);
  assert.doesNotMatch(doc, /<input id="note">\n/);
});

test("describeStep exposes card fields for the UI", () => {
  const generator = loadGenerator();

  const step = generator.describeStep({
    type: "click",
    pageName: "page1",
    target: fakeTarget()
  });
  assert.equal(step.desc, "点击：按钮“发送”");
  assert.match(step.detail, /^click <button id="send-btn"/);
  assert.ok(step.context.some(l => l === "dom context:"));

  const fallback = generator.describeStep({ type: "unknown-op" });
  assert.match(fallback.desc, /执行操作：unknown-op/);
});

/** Maps each numbered step to the indented context lines under it. */
function contextByStep(doc) {
  const blocks = new Map();
  let current = null;
  for (const line of doc.split("\n")) {
    const numbered = /^(\d+)\. \[/.exec(line);
    if (numbered) {
      current = Number(numbered[1]);
      blocks.set(current, []);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("   ")) blocks.get(current).push(line.trim());
    else if (line.trim() === "") current = null;
  }
  return blocks;
}

test("one handle navigating mid-flow keeps its handle and states the new URL", () => {
  const generator = loadGenerator();
  // A login flow inside a single tab: the handle is bound to the tab, so all
  // five steps are page1 even though the document changes three times.
  const doc = generator.generate([
    { type: "navigate", pageName: "page1", url: "https://erp.test/login", title: "Login" },
    { type: "type", pageName: "page1", url: "https://erp.test/login", value: "alice", target: fakeTarget() },
    { type: "click", pageName: "page1", url: "https://erp.test/login", target: fakeTarget() },
    { type: "click", pageName: "page1", url: "https://erp.test/home", target: fakeTarget() },
    { type: "click", pageName: "page1", url: "https://erp.test/order", target: fakeTarget() }
  ]);

  const blocks = contextByStep(doc);
  // The lifecycle step prints its own URL, so it is not restated.
  assert.ok(!blocks.get(1).some(line => line.startsWith("page url:")));
  // Unchanged URLs cost nothing.
  assert.ok(!blocks.get(2).some(line => line.startsWith("page url:")));
  assert.ok(!blocks.get(3).some(line => line.startsWith("page url:")));
  // The two steps that landed on a new document say where they are.
  assert.ok(blocks.get(4).includes("page url: https://erp.test/home"));
  assert.ok(blocks.get(5).includes("page url: https://erp.test/order"));
});

test("the header lists every URL a handle visited, not just its first", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "navigate", pageName: "page1", url: "https://erp.test/login", title: "Login" },
    { type: "click", pageName: "page1", url: "https://erp.test/home", title: "Home", target: fakeTarget() },
    { type: "click", pageName: "page1", url: "https://erp.test/login", title: "Login", target: fakeTarget() }
  ]);

  assert.match(doc, /^\[page1\] https:\/\/erp\.test\/login "Login"$/m);
  assert.match(doc, /^ {5}-> https:\/\/erp\.test\/home "Home"$/m);
  // Returning to an earlier URL is a new visit, not a duplicate to swallow.
  assert.match(doc, /^ {5}-> https:\/\/erp\.test\/login "Login"$/m);
});

test("a handle whose URL was never known does not invent a transition", () => {
  const generator = loadGenerator();
  // Steps recorded before the URL was captured, then one that has it: this
  // identifies the same visit rather than splitting it in two.
  const doc = generator.generate([
    { type: "click", pageName: "page1", target: fakeTarget() },
    { type: "click", pageName: "page1", url: "https://erp.test/only", title: "Only", target: fakeTarget() }
  ]);

  assert.match(doc, /^\[page1\] https:\/\/erp\.test\/only "Only"$/m);
  // One visit, so the header has no continuation line.
  assert.doesNotMatch(doc, /^ {5}-> /m);
  // The step that first carries the URL still states it.
  assert.ok(contextByStep(doc).get(2).includes("page url: https://erp.test/only"));
});

test("steps without a recorded URL produce no location line", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "click", pageName: "page1", target: fakeTarget() },
    { type: "click", pageName: "page1", target: fakeTarget() }
  ]);

  assert.doesNotMatch(doc, /page url:/);
  assert.match(doc, /^\[page1\] $/m);
});

test("a click that opened a child page names the handle that follows", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "navigate", pageName: "page1", url: "https://erp.test/order", title: "Order" },
    { type: "click", pageName: "page1", url: "https://erp.test/order", openedChildPage: true,
      screenshotSkippedReason: "opens-child-page", target: fakeTarget() },
    { type: "click", pageName: "page2", url: "https://report.test/view", title: "Report", target: fakeTarget() }
  ]);

  assert.ok(contextByStep(doc).get(2).includes("-> opens page2"));
  // And that name is the handle the following steps are actually labelled with.
  assert.match(doc, /^3\. \[page2\] /m);
});

test("a click that opened a page nobody used does not invent a handle", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "click", pageName: "page1", url: "https://erp.test/order", openedChildPage: true, target: fakeTarget() }
  ]);

  assert.ok(contextByStep(doc).get(1).includes("-> opens a new page"));
  assert.doesNotMatch(doc, /-> opens page\d/);
});

test("a step whose page was closed says the flow ended there", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "click", pageName: "page1", url: "https://erp.test/order", screenshotStatus: "failed",
      screenshotErrorReason: "pageClosed", target: fakeTarget() }
  ]);

  assert.ok(contextByStep(doc).get(1).includes("page closed after this step"));
});

test("another capture failure says nothing about the page", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    { type: "click", pageName: "page1", url: "https://erp.test/order", screenshotStatus: "failed",
      screenshotErrorReason: "captureFailed", target: fakeTarget() }
  ]);

  // A missing frame is the step panel's to explain; only the page disappearing is
  // a fact about the flow, and only that one belongs in the document.
  assert.doesNotMatch(doc, /page closed/);
  assert.match(doc, /^1\. \[page1\] click /m);
});

test("an element the analyzer left nameless is still named by its own text", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    {
      type: "click",
      pageName: "page1",
      target: fakeTarget({
        tagName: "div", id: null, className: "navText", role: null, accessibleName: null,
        textContent: "新建事项",
        nearbyTexts: ["协同BPM门户", "待发事项", "已发事项"],
        outerHTML: '<div class="navText">新建事项</div>'
      })
    }
  ]);

  assert.match(doc, /click <div class="navText"> -> "新建事项"/);
  // With a name of its own, the sibling text is no longer a substitute for one.
  assert.doesNotMatch(doc, /nearby text/);
});

test("a container's whole paragraph is not used as a name", () => {
  const generator = loadGenerator();
  const doc = generator.generate([
    {
      type: "click",
      pageName: "page1",
      target: fakeTarget({
        role: null, accessibleName: null,
        textContent: "这是一段很长的容器文本，远远超过了一个控件名称应该有的长度限制，不应该被当成名称使用",
        nearbyTexts: ["最近使用"],
        outerHTML: "<div class=\"content\">…</div>"
      })
    }
  ]);

  assert.doesNotMatch(doc, /-> "/);
  assert.match(doc, /nearby text: "最近使用"/);
});

test("the card label and the exported document name an element the same way", () => {
  const generator = loadGenerator();
  const target = fakeTarget({ role: null, accessibleName: null, textContent: "新建事项" });

  assert.equal(generator.renderSemantic(target), '"新建事项"');
  assert.equal(generator.describeStep({ type: "click", target }).desc, "点击：“新建事项”");
});
