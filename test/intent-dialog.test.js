/**
 * Test step ranges and the insert rule.
 *
 * Both decide what the exported document claims, and both are easy to get wrong,
 * so they are tested without a browser: the module is loaded as the plain script
 * the extension ships.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadDialog() {
  const source = fs.readFileSync(path.join(__dirname, "..", "ui", "lib", "intent-dialog.js"), "utf8");
  const context = {
    RecorderDom: { escapeHtml: text => String(text ?? "") },
    RecorderI18n: { t: (key, substitutions, fallback) => fallback }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.RecorderIntentDialog;
}

// The dialog runs in another realm, so its arrays and objects have different
// prototypes; comparing plain copies keeps the assertion about values only.
const plain = value => JSON.parse(JSON.stringify(value));

const steps = () => [
  { id: "a", title: "登录", start: 1, end: 4, open: false, checks: ["进入工作台"] },
  { id: "b", title: "上传", start: 5, end: 10, open: false, checks: ["附件出现"] },
  { id: "c", title: "发送", start: 11, end: 15, open: false, checks: ["回答完成"] }
];

test("each test step reports its own range and grows when it is open", () => {
  const { stepRanges } = loadDialog();
  assert.deepEqual(plain(stepRanges(steps(), 15)), [
    { from: 1, to: 4 },
    { from: 5, to: 10 },
    { from: 11, to: 15 }
  ]);
  // An open test step runs to the end of the recording, so it grows by itself.
  const growing = [{ id: "a", start: 1, end: 4, open: false }, { id: "b", start: 5, end: 8, open: true }];
  assert.deepEqual(plain(stepRanges(growing, 8)).at(-1), { from: 5, to: 8 });
  assert.deepEqual(plain(stepRanges(growing, 12)).at(-1), { from: 5, to: 12 });
  assert.deepEqual(plain(stepRanges(null, 5)), []);
});

test("a new annotation starts right after the last covered recorded step", () => {
  const { nextUnannotatedStart } = loadDialog();

  assert.equal(nextUnannotatedStart([], 15), 1);
  assert.equal(nextUnannotatedStart(steps(), 15), 16);
  // 1-5 is annotated, so the next form starts at 6 rather than carrying 1-5 over.
  assert.equal(nextUnannotatedStart([{ id: "a", start: 1, end: 5, open: false }], 34), 6);
  // A step that is still open covers the whole recording: nothing is left.
  assert.equal(nextUnannotatedStart([{ id: "a", start: 1, end: 3, open: true }], 34), 35);
  // A pending placeholder past the recording covers nothing.
  assert.equal(nextUnannotatedStart([{ id: "a", start: 35, end: 34, open: true }], 34), 35);
  // Ranges that stop short of the end leave the rest for the next save.
  assert.equal(nextUnannotatedStart([
    { id: "a", start: 1, end: 5, open: false },
    { id: "b", start: 6, end: 11, open: false }
  ], 34), 12);
});

test("consistency checks only warn about what the tester typed", () => {
  const { validateIntent } = loadDialog();

  assert.deepEqual(plain(validateIntent({ steps: [{ start: 1, goal: "说明" }] })), []);

  assert.deepEqual(plain(validateIntent({
    steps: [{ id: "s1", start: 1, end: 2, checks: ["附件出现"], ignore: true }]
  })), ["checkOnSkippedStep"]);

  // A skipped step with no checks is a legitimate way to say "this is setup".
  assert.deepEqual(plain(validateIntent({
    steps: [{ id: "s1", start: 1, end: 2, checks: [], ignore: true }]
  })), []);

  assert.deepEqual(plain(validateIntent(null)), []);
});

test("a new range takes its steps out of an existing test step", () => {
  const { placeNewStep } = loadDialog();
  const old = [{
    id: "old", title: "旧步骤", start: 1, end: 12, open: true,
    checks: ["旧验证"], note: "旧说明"
  }];
  const fresh = { id: "new", title: "新步骤", start: 1, end: 5, open: false, checks: [], note: "" };

  // 1-12 annotated as one block, then 1-5 split off: the rest is left
  // unannotated, so the next save describes 6-12 from scratch.
  const front = plain(placeNewStep(old, fresh, 12));
  assert.deepEqual(front.steps.map(step => [step.start, step.end, step.title]), [[1, 5, "新步骤"]]);

  // Splitting the middle keeps the old text only in front of the new range.
  const middle = plain(placeNewStep(old, { ...fresh, start: 6, end: 11 }, 12));
  assert.deepEqual(middle.steps.map(step => [step.start, step.end, step.title]), [
    [1, 5, "旧步骤"],
    [6, 11, "新步骤"]
  ]);

  // The new range replaces the old one outright; the open flag follows the end.
  assert.deepEqual(plain(placeNewStep(old, { ...fresh, start: 1, end: 12 }, 12)).steps,
    [{ id: "new", title: "新步骤", start: 1, end: 12, open: true, checks: [], note: "" }]);

  // An empty new step cannot delete filled text by accident.
  assert.equal(plain(placeNewStep(old, { ...fresh, title: "", start: 1, end: 5 }, 12)).error, "intentEmptySplit");

  // A range that touches nothing is appended in order.
  const appended = plain(placeNewStep([{ ...old[0], end: 5, open: false }], { ...fresh, start: 6, end: 12 }, 12));
  assert.deepEqual(appended.steps.map(step => [step.start, step.end]), [[1, 5], [6, 12]]);
});

test("a purpose or test goal is content worth keeping when splitting", () => {
  const { placeNewStep } = loadDialog();
  const old = {
    id: "old", title: "旧步骤", start: 1, end: 12, open: true,
    purpose: "旧目的", checks: [], note: ""
  };
  const fresh = { id: "new", title: "", start: 1, end: 5, open: false, checks: [], note: "" };

  assert.equal(plain(placeNewStep([{ ...old, goal: "这一段有目标" }], fresh, 12)).error, "intentEmptySplit");
  assert.equal(plain(placeNewStep([{ ...old, purpose: "这一段有目的" }], fresh, 12)).error, "intentEmptySplit");

  // A new split with its own goal keeps the preceding annotation.
  const split = plain(placeNewStep([old], {
    ...fresh,
    start: 6,
    end: 11,
    goal: "新目标"
  }, 12));
  assert.deepEqual(split.steps.map(step => [step.start, step.end, step.id]), [[1, 5, "old"], [6, 11, "new"]]);
});

test("the side panel and the workbench share one test step heading, marker and end rule", () => {
  const { stepLabel, stepMarker, stepEndMarker } = loadDialog();
  assert.equal(stepLabel({ title: "登录" }, 0), "测试步骤 1 · 登录");
  assert.equal(stepLabel({ title: "" }, 1), "测试步骤 2");

  const annotated = [
    { id: "a", title: "登录", start: 1, end: 2, checks: ["", "进入工作台"] },
    { id: "b", title: "", start: 4, end: 5, note: "先试小图", open: false }
  ];
  assert.deepEqual(plain(stepMarker(annotated, 0)), { label: "测试步骤 1 · 登录", detail: "进入工作台" });
  assert.deepEqual(plain(stepMarker(annotated, 3)), { label: "测试步骤 2", detail: "先试小图" });
  assert.equal(stepMarker(annotated, 1), null);
  assert.equal(stepMarker([{ start: 1, end: 1, ignore: true, goal: "x" }], 0).detail, "不参与测试");

  // Step 1 ends before an unannotated step: it gets a rule. Step 2 ends at the
  // recording's last step, which needs none; nor does a step followed directly
  // by the next test step.
  assert.deepEqual(plain(stepEndMarker(annotated, 1, 6)), { label: "测试步骤 1 结束" });
  assert.equal(stepEndMarker(annotated, 4, 5), null);
  assert.equal(stepEndMarker([{ start: 1, end: 2 }, { start: 3, end: 4 }], 1, 6), null);
});

test("a picked range lists the test steps it would replace", () => {
  const { overlappingSteps } = loadDialog();
  const annotated = [
    { id: "a", start: 1, end: 3 },
    { id: "b", start: 4, end: 6 },
    { id: "c", start: 7, end: 7, open: true },
    { id: "pending", start: 11, end: 10 }
  ];
  const ids = steps => steps.map(step => step.id);
  assert.deepEqual(ids(overlappingSteps(annotated, { start: 2, end: 4 }, 10)), ["a", "b"]);
  assert.deepEqual(ids(overlappingSteps(annotated, { start: 9, end: 10 }, 10)), ["c"], "an open step grows to the end");
  assert.deepEqual(ids(overlappingSteps(annotated, { start: 4, end: 6 }, 10, annotated[1])), [], "the edited step is not its own overlap");
  assert.deepEqual(ids(overlappingSteps(annotated, { start: 8, end: 8 }, 7)), []);
});

test("checked steps annotate one contiguous range and report the steps in between", () => {
  const { selectionRange, annotateRangeLabel } = loadDialog();
  assert.equal(selectionRange([]), null);
  assert.deepEqual(plain(selectionRange([3, 1, 2])), { start: 2, end: 4, gaps: false });
  assert.deepEqual(plain(selectionRange([1, 4])), { start: 2, end: 5, gaps: true });
  assert.equal(annotateRangeLabel({ start: 2, end: 5 }), "标注第 2–5 步");
  assert.equal(annotateRangeLabel({ start: 3, end: 3 }), "标注第 3 步");
});
