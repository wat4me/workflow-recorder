/**
 * The annotation dialog as a tester meets it.
 *
 * Both regressions this covers were invisible to the unit tests: the shared
 * dialog shell is a two-column grid, so a dialog without an icon squeezed the
 * whole form into a 36px column (untypeable), and an inserted but not yet
 * annotated test step was dropped on save, which broke "insert, keep recording
 * into it".
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("@playwright/test");

const extensionPath = path.resolve(__dirname, "..");

function seedActions() {
  return [1, 2, 3].map(index => ({
    id: `seed${index}`,
    type: "click",
    timestamp: index,
    pageName: "page1",
    url: "https://example.test/flow",
    target: {
      tagName: "button",
      role: "button",
      accessibleName: `按钮${index}`,
      outerHTML: "<button></button>",
      parentChain: []
    }
  }));
}

test("the annotation dialog is typeable and keeps an inserted test step", async t => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  const actions = seedActions();
  await worker.evaluate(async actions => {
    const writes = { actionOrder: actions.map(action => action.id), isRecording: false, uiLanguage: "zh_CN" };
    for (const action of actions) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
  }, actions);

  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  await page.waitForSelector("#intent-btn:not([disabled])", { timeout: 10000 });
  const baseline = await page.evaluate(() => chrome.runtime.sendMessage({ action: "saveCase", name: "标注回归用例" }));
  assert.equal(baseline.success, true);
  await page.click("#intent-btn");
  await page.waitForSelector(".intent-dialog");

  const goal = page.locator(".intent-step-goal");
  const box = await goal.boundingBox();
  assert.ok(box && box.width > 600, `goal field is ${box?.width}px wide`);

  // The goal, preconditions, verification points and pass criteria all belong
  // to the test step that verifies them.
  const labels = await page.locator(".intent-field-label").allTextContents();
  for (const label of ["阶段名称", "测试目标", "前置条件", "本段目的", "验证点", "通过标准"]) {
    assert.ok(labels.some(text => text.includes(label)), `missing step field ${label}`);
  }

  await goal.click();
  await goal.fill("任务模式下上传本地文件能否被读到");
  assert.equal(await goal.inputValue(), "任务模式下上传本地文件能否被读到");

  // The header starts a new, empty test step at the first unannotated step:
  // no controls for the whole list, and no text carried over from an earlier
  // annotation.
  assert.equal(await page.locator(".intent-step-position").inputValue(), "1");
  assert.equal(await page.locator(".intent-step-end").inputValue(), "3");
  assert.equal(await page.locator(".intent-step-title").inputValue(), "");
  assert.equal(await page.locator(".intent-step-preconditions").inputValue(), "");
  assert.equal(await page.locator(".intent-step-checks").inputValue(), "");
  const extra = page.locator(".intent-extra-section");
  assert.equal(await extra.locator(".intent-step-pass").isVisible(), false);
  assert.equal(await page.getByText("数据取值", { exact: true }).count(), 0);
  await extra.locator("summary").click();
  const dialogWidth = (await page.locator(".intent-dialog").boundingBox()).width;
  for (const selector of [".intent-step-goal", ".intent-step-preconditions", ".intent-step-purpose", ".intent-step-pass"]) {
    const fieldWidth = (await page.locator(selector).boundingBox()).width;
    assert.ok(fieldWidth > dialogWidth * 0.75, `${selector} is only ${fieldWidth}px in a ${dialogWidth}px dialog`);
  }
  await extra.locator("summary").click();
  assert.equal(await page.locator(".intent-step-pass").inputValue(), "");
  assert.equal(await page.locator(".intent-step-note").inputValue(), "");
  assert.equal(await page.locator(".intent-add-step").count(), 0);
  assert.equal(await page.locator(".intent-step-insert").count(), 0);
  assert.equal(await page.locator(".intent-step-remove").count(), 0);

  // The row header carries the range, the start and the end;
  // the name gets a line of its own so nothing is squeezed, and no control may
  // spill outside the dialog.
  const dialog = await page.locator(".intent-dialog").boundingBox();
  const titleBox = await page.locator(".intent-step-title").first().boundingBox();
  assert.ok(titleBox && titleBox.width > 300, `step name field is ${titleBox?.width}px wide`);
  for (const selector of [".intent-step-range", ".intent-step-position", ".intent-step-end"]) {
    const box = await page.locator(selector).first().boundingBox();
    assert.ok(box, `${selector} has no box`);
    assert.ok(box.x + box.width <= dialog.x + dialog.width, `${selector} spills outside the dialog`);
  }

  // The side panel is narrow: at 400px the row header wraps instead of
  // overlapping, and nothing may leave the dialog horizontally.
  await page.setViewportSize({ width: 400, height: 800 });
  const narrowDialog = await page.locator(".intent-dialog").boundingBox();
  for (const selector of [".intent-step-range", ".intent-step-position", ".intent-step-end",
    ".intent-step-title"]) {
    const box = await page.locator(selector).first().boundingBox();
    assert.ok(box && box.x >= narrowDialog.x - 0.5 && box.x + box.width <= narrowDialog.x + narrowDialog.width + 0.5,
      `${selector} leaves the dialog at 400px: ${JSON.stringify(box)}`);
  }

  // Fill the first test step and close it at step 1, leaving 2-3 for later.
  await page.locator(".intent-step-title").fill("登录");
  await page.locator(".intent-step-checks").fill("进入工作台");
  await page.locator(".intent-step-end").fill("1");
  assert.match(await page.locator(".intent-step-range").innerText(), /1–1/);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.click(".confirm-submit");
  await page.waitForSelector(".intent-dialog", { state: "detached" });

  const stored = await worker.evaluate(async () => (await chrome.storage.local.get("workspaceIntent")).workspaceIntent);
  assert.equal(stored.note, undefined);
  assert.equal(stored.steps[0].goal, "任务模式下上传本地文件能否被读到");
  assert.deepEqual(stored.steps.map(step => [step.start, step.end]), [[1, 1]]);
  const savedCase = await page.evaluate(caseId => chrome.runtime.sendMessage({
    action: "getCaseDetails", caseId
  }), baseline.case.id);
  assert.deepEqual(savedCase.case.intent, stored);

  const firstGroup = page.locator(".step-intent-group");
  await firstGroup.waitFor();
  assert.deepEqual(await firstGroup.locator(".step-index").allTextContents(), ["1"]);

  // Opening the header again is a fresh annotation for 2-3: no step content,
  // including the goal, is carried over from step 1.
  await page.click("#intent-btn");
  await page.locator(".intent-picker .confirm-submit").click();
  await page.waitForSelector(".intent-dialog");
  assert.equal(await page.locator(".intent-step-goal").inputValue(), "");
  assert.equal(await page.locator(".intent-step-position").inputValue(), "2");
  assert.equal(await page.locator(".intent-step-end").inputValue(), "3");
  assert.equal(await page.locator(".intent-step-title").inputValue(), "");
  assert.equal(await page.locator(".intent-step-checks").inputValue(), "");
  assert.equal(await page.locator(".intent-step-note").inputValue(), "");
  await page.keyboard.press("Escape");
  await page.waitForSelector(".intent-dialog", { state: "detached" });
});

test("the panel shows the annotation on the steps it describes", async t => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  const actions = Array.from({ length: 6 }, (_, index) => ({
    id: `marker${index}`,
    type: "click",
    timestamp: index,
    pageName: "page1",
    url: "https://example.test/flow",
    target: {
      tagName: "button",
      role: "button",
      accessibleName: `按钮${index}`,
      outerHTML: "<button></button>",
      parentChain: []
    }
  }));
  await worker.evaluate(async actions => {
    const writes = {
      actionOrder: actions.map(action => action.id),
      isRecording: false,
      uiLanguage: "zh_CN",
      workspaceIntent: {
        note: "任务模式下上传本地文件能否被读到",
        steps: [
          { id: "s1", title: "登录", start: 1, end: 3, checks: ["进入工作台"], note: "" },
          { id: "s2", title: "上传", start: 4, end: 6, checks: ["附件出现", "回答完成"], note: "先试小图" }
        ]
      }
    };
    for (const action of actions) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
  }, actions);

  const page = await context.newPage();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  await page.waitForSelector(".step-intent-marker");

  const groups = page.locator(".step-intent-group");
  assert.equal(await groups.count(), 2);
  const firstGroup = groups.first();
  const lastGroup = groups.last();
  const firstToggle = firstGroup.locator(".step-intent-group-toggle");
  assert.equal(await firstToggle.locator(".step-intent-marker-label").innerText(), "登录");
  assert.match(await firstToggle.locator(".step-intent-group-meta").innerText(), /测试步骤 1.*1–3/);
  assert.equal(await lastGroup.locator(".step-intent-marker-label").innerText(), "上传");
  assert.equal(await firstToggle.getAttribute("aria-expanded"), "false");
  assert.equal(await firstGroup.locator(".step-index:visible").count(), 0);
  assert.deepEqual(await lastGroup.locator(".step-index:visible").allTextContents(), ["4", "5", "6"]);
  await firstToggle.click();
  assert.deepEqual(await firstGroup.locator(".step-index:visible").allTextContents(), ["1", "2", "3"]);
  await firstToggle.click();
  assert.equal(await firstGroup.locator(".step-index:visible").count(), 0);

  // The marker owns a full row: it must be as wide as the card and sit above the
  // step number, not squeezed into the flex row beside it.
  const layout = await page.locator(".step-intent-marker").nth(1).evaluate(node => {
    const card = node.closest(".step-card");
    const index = card.querySelector(".step-index");
    return {
      markerWidth: node.getBoundingClientRect().width,
      markerBottom: node.getBoundingClientRect().bottom,
      cardWidth: card.getBoundingClientRect().width,
      indexTop: index.getBoundingClientRect().top
    };
  });
  assert.ok(layout.markerWidth > layout.cardWidth * 0.8,
    `marker is squeezed: ${JSON.stringify(layout)}`);
  assert.ok(layout.indexTop >= layout.markerBottom - 1,
    `step number sits beside the marker: ${JSON.stringify(layout)}`);
  const firstCard = await firstGroup.boundingBox();
  const secondHeader = await lastGroup.locator(".step-intent-marker").boundingBox();
  assert.ok(secondHeader.y - firstCard.y - firstCard.height >= 8, "test-step cards need a visible gap");

  assert.match(await page.locator(".intent-summary-meta").innerText(), /2 个测试步骤/);
  assert.match(await page.locator(".intent-summary-meta").innerText(), /3 个验证点/);
  await page.getByRole("button", { name: /查看标注/ }).click();
  await page.getByRole("dialog", { name: "查看标注" }).getByRole("button", { name: /测试步骤 2.*上传/ }).click();
  assert.equal(await page.locator(".intent-step-title").inputValue(), "上传");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#intent-summary-btn").evaluate(button => document.activeElement === button), true);

  // A marker edits that test step only: the case fields are not even rendered,
  // so annotating step 2 can never look like it still holds step 1.
  await page.locator(".step-intent-marker-edit").first().click();
  await page.waitForSelector(".intent-dialog");
  assert.equal(await page.locator(".intent-input").count(), 0);
  assert.equal(await page.locator(".intent-step-title").inputValue(), "登录");
  assert.match(await page.locator("#intent-title").innerText(), /测试步骤 1/);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".intent-dialog", { state: "detached" });

  await page.locator(".step-intent-marker-edit").nth(1).click();
  await page.waitForSelector(".intent-dialog");
  assert.equal(await page.locator(".intent-step-title").inputValue(), "上传");
  assert.equal(await page.locator(".intent-step-note").inputValue(), "先试小图");
  assert.match(await page.locator("#intent-title").innerText(), /测试步骤 2/);
});

test("annotating 1-5 then 6-11 adds a second, separate test step", async t => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  const actions = Array.from({ length: 11 }, (_, index) => ({
    id: `split${index}`,
    type: "click",
    timestamp: index,
    pageName: "page1",
    url: "https://example.test/flow",
    target: {
      tagName: "button",
      role: "button",
      accessibleName: `按钮${index}`,
      outerHTML: "<button></button>",
      parentChain: []
    }
  }));
  await worker.evaluate(async actions => {
    const writes = { actionOrder: actions.map(action => action.id), isRecording: false, uiLanguage: "zh_CN" };
    for (const action of actions) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
  }, actions);

  const page = await context.newPage();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);

  // First annotation: 1-5.
  await page.waitForSelector("#intent-btn:not([disabled])", { timeout: 10000 });
  await page.click("#intent-btn");
  await page.waitForSelector(".intent-dialog");
  const preview = page.locator(".intent-range-preview");
  const previewNumbers = () => preview.locator(".intent-range-preview-number").allTextContents();
  assert.deepEqual(await previewNumbers(), Array.from({ length: 11 }, (_, index) => String(index + 1)));
  assert.match(await preview.locator("li").last().innerText(), /按钮10/);
  assert.equal(await preview.locator("img").count(), 0);
  assert.equal(await preview.evaluate(list => list.scrollHeight > list.clientHeight && list.clientHeight <= 102), true);
  await preview.focus();
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.querySelector(".intent-range-preview").scrollTop > 0);
  await page.locator(".intent-step-position").fill("9");
  assert.deepEqual(await previewNumbers(), ["9", "10", "11"]);
  assert.equal(await preview.evaluate(list => list.scrollTop), 0);
  await page.locator(".intent-step-end").fill("8");
  assert.equal(await preview.isVisible(), false);
  await page.locator(".intent-step-position").fill("1");
  await page.locator(".intent-step-end").fill("11");
  await page.locator(".intent-step-title").fill("登录");
  await page.locator(".intent-step-checks").fill("进入工作台");
  await page.locator(".intent-step-end").fill("5");
  await page.click(".confirm-submit");
  await page.waitForSelector(".intent-dialog", { state: "detached" });

  // The group contains the recorded actions in its saved range.
  const firstGroup = page.locator(".step-intent-group").first();
  await firstGroup.waitFor();
  assert.deepEqual(await firstGroup.locator(".step-index").allTextContents(), ["1", "2", "3", "4", "5"]);

  // Second annotation: the form is a new, empty step starting at 6. Nothing from
  // 1-5 is shown and a save adds a marker at 6 (below 5), not below the first
  // step's text.
  await page.click("#intent-btn");
  await page.locator(".intent-picker .confirm-submit").click();
  await page.waitForSelector(".intent-dialog");
  assert.equal(await page.locator(".intent-step-position").inputValue(), "6");
  assert.equal(await page.locator(".intent-step-end").inputValue(), "11");
  assert.equal(await page.locator(".intent-step-title").inputValue(), "");
  assert.equal(await page.locator(".intent-step-checks").inputValue(), "");
  assert.equal(await page.locator(".intent-step-note").inputValue(), "");
  await page.locator(".intent-step-title").fill("上传附件");
  await page.locator(".intent-step-checks").fill("附件出现在已发送区");
  await page.locator(".intent-step-end").fill("11");
  await page.click(".confirm-submit");
  await page.waitForSelector(".intent-dialog", { state: "detached" });

  const stored = await worker.evaluate(async () => (await chrome.storage.local.get("workspaceIntent")).workspaceIntent);
  assert.deepEqual(stored.steps.map(step => [step.start, step.end, step.title]), [
    [1, 5, "登录"],
    [6, 11, "上传附件"]
  ]);

  await page.waitForFunction(() => document.querySelectorAll(".step-intent-marker").length === 2);
  const markerSteps = await page.locator(".step-intent-marker").evaluateAll(nodes =>
    nodes.map(node => node.closest(".step-card")?.querySelector(".step-index")?.textContent || ""));
  assert.deepEqual(markerSteps, ["1", "6"]);
  assert.equal(await page.locator(".step-intent-group.is-intent-collapsed").count(), 1);
  assert.match(await page.locator(".intent-summary-meta").innerText(), /2 个测试步骤/);
});

test("a fully annotated recording can still be split from the header", async t => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;

  const actions = Array.from({ length: 12 }, (_, index) => ({
    id: `whole${index}`,
    type: "click",
    timestamp: index,
    pageName: "page1",
    url: "https://example.test/flow",
    target: {
      tagName: "button",
      role: "button",
      accessibleName: `按钮${index}`,
      outerHTML: "<button></button>",
      parentChain: []
    }
  }));
  // The state the old flow leaves behind: one test step covering 1-12.
  await worker.evaluate(async actions => {
    const writes = {
      actionOrder: actions.map(action => action.id),
      isRecording: false,
      uiLanguage: "zh_CN",
      workspaceIntent: {
        note: "旧说明",
        steps: [{ id: "old", title: "旧步骤", start: 1, end: 12, open: true, checks: ["旧验证"], note: "" }]
      }
    };
    for (const action of actions) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
  }, actions);

  const page = await context.newPage();
  await page.setViewportSize({ width: 420, height: 800 });
  await page.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  await page.waitForSelector("#intent-btn:not([disabled])", { timeout: 10000 });

  // The header must offer a blank step; the old note is migrated to the old
  // step, not copied into the new split.
  await page.click("#intent-btn");
  await page.locator(".intent-picker .confirm-submit").click();
  await page.waitForSelector(".intent-dialog");
  assert.equal(await page.locator(".intent-step-row").count(), 1);
  assert.equal(await page.locator(".intent-step-position").inputValue(), "1");
  assert.equal(await page.locator(".intent-step-end").inputValue(), "11");
  assert.equal(await page.locator(".intent-step-title").inputValue(), "");
  assert.equal(await page.locator(".intent-step-goal").inputValue(), "");

  await page.locator(".intent-step-title").fill("登录");
  await page.locator(".intent-step-checks").fill("进入工作台");
  await page.locator(".intent-step-end").fill("5");
  await page.click(".confirm-submit");
  await page.waitForSelector(".intent-dialog", { state: "detached" });

  let stored = await worker.evaluate(async () => (await chrome.storage.local.get("workspaceIntent")).workspaceIntent);
  // The old text described the whole 1-12 block, so the part after the split is
  // left unannotated instead of inheriting it.
  assert.deepEqual(stored.steps.map(step => [step.start, step.end, step.title]), [[1, 5, "登录"]]);
  // The group contains the recorded actions in its saved range.
  const firstGroup = page.locator(".step-intent-group").first();
  await firstGroup.waitFor();
  assert.deepEqual(await firstGroup.locator(".step-index").allTextContents(), ["1", "2", "3", "4", "5"]);

  // The next header is the ordinary blank 6-12 range; set it to 6-11.
  await page.click("#intent-btn");
  await page.locator(".intent-picker .confirm-submit").click();
  await page.waitForSelector(".intent-dialog");
  assert.equal(await page.locator(".intent-step-position").inputValue(), "6");
  assert.equal(await page.locator(".intent-step-end").inputValue(), "12");
  assert.equal(await page.locator(".intent-step-title").inputValue(), "");
  await page.locator(".intent-step-title").fill("上传附件");
  await page.locator(".intent-step-end").fill("11");
  await page.click(".confirm-submit");
  await page.waitForSelector(".intent-dialog", { state: "detached" });

  stored = await worker.evaluate(async () => (await chrome.storage.local.get("workspaceIntent")).workspaceIntent);
  assert.deepEqual(stored.steps.map(step => [step.start, step.end, step.title]), [
    [1, 5, "登录"],
    [6, 11, "上传附件"]
  ]);
  await page.waitForFunction(() => document.querySelectorAll(".step-intent-marker").length === 2);
});


function expectVisible(locator) {
  return locator.waitFor({ state: "visible" });
}

test("workbench edits an annotation beside its recorded steps and saves it to the case", async t => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  await worker.evaluate(async actions => {
    await chrome.storage.local.set({
      uiLanguage: "zh_CN",
      actionOrder: actions.map(action => action.id),
      ...Object.fromEntries(actions.map(action => [`action:${action.id}`, action]))
    });
  }, seedActions());

  const page = await context.newPage({ viewport: { width: 1200, height: 780 } });
  await page.goto(`chrome-extension://${extensionId}/ui/console.html`);
  const saved = await page.evaluate(() => chrome.runtime.sendMessage({ action: "saveCase", name: "联动标注" }));
  assert.equal(saved.success, true);
  await page.reload();
  await page.getByRole("button", { name: /标注意图.*联动标注/ }).click();
  await expectVisible(page.locator("#preview-intent-pane"));
  await page.locator("#preview-add-intent-btn").click();
  const steps = page.locator("#preview-steps-container");
  const editor = page.getByRole("region", { name: "新增测试步骤" });
  await expectVisible(editor);
  const layout = await Promise.all([steps.boundingBox(), editor.boundingBox()]);
  assert.ok(layout[0].x + layout[0].width <= layout[1].x);
  assert.equal(await steps.locator(".is-intent-highlighted").count(), 3);
  await editor.locator(".intent-step-end").fill("2");
  assert.equal(await steps.locator(".is-intent-highlighted").count(), 2);
  await editor.locator(".intent-step-title").fill("登录");
  await editor.locator(".intent-step-goal").fill("检查能否进入工作台");
  await editor.getByRole("button", { name: "保存标注" }).click();
  await expectVisible(page.locator("#preview-intent-list button"));
  assert.match(await steps.locator(".step-intent-marker").innerText(), /登录/);

  await page.reload();
  await page.locator("#preview-intent-list button").click();
  const goal = page.locator(".intent-step-goal");
  assert.equal(await goal.inputValue(), "检查能否进入工作台");
  await page.setViewportSize({ width: 630, height: 780 });
  const narrow = await Promise.all([steps.boundingBox(), goal.boundingBox()]);
  assert.ok(narrow[0].y + narrow[0].height < narrow[1].y);
  await goal.fill("放弃这次修改");
  await page.getByRole("button", { name: "取消" }).click();
  await page.locator("#preview-intent-list button").click();
  assert.equal(await goal.inputValue(), "检查能否进入工作台");
});

test("the workbench picks an annotation range on the step list and warns before replacing one", async t => {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const actions = Array.from({ length: 6 }, (_, index) => ({
    id: `pick${index}`, type: "click", timestamp: index, pageName: "page1", url: "https://example.test/flow",
    target: { tagName: "button", role: "button", accessibleName: `按钮${index + 1}`, outerHTML: "<button></button>", parentChain: [] }
  }));
  await worker.evaluate(async actions => {
    const writes = { actionOrder: actions.map(action => action.id), isRecording: false, uiLanguage: "zh_CN",
      workspaceIntent: { steps: [{ id: "login", title: "登录", start: 1, end: 3, checks: ["进入工作台"] }] } };
    for (const action of actions) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
  }, actions);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  await panel.waitForSelector("#intent-btn:not([disabled])");
  const saved = await panel.evaluate(() => chrome.runtime.sendMessage({ action: "saveCase", name: "范围选择用例" }));
  assert.equal(saved.success, true);

  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/ui/console.html?caseId=${saved.case.id}`);
  await page.waitForSelector("#preview-panel:not([hidden])");
  const card = number => page.locator(`#preview-steps-container .step-card[data-step-index="${number - 1}"] .step-description`);
  const range = async () => [await page.locator(".intent-step-position").inputValue(), await page.locator(".intent-step-end").inputValue()];
  const highlighted = () => page.locator("#preview-steps-container .step-card.is-intent-highlighted").evaluateAll(cards =>
    cards.map(card => Number(card.dataset.stepIndex) + 1));

  // A new test step starts on the first unannotated range; clicking a start and
  // an end card replaces it, and the list highlights what the fields hold.
  await page.click("#preview-add-intent-btn");
  await page.waitForSelector(".preview-range-hint");
  assert.deepEqual(await range(), ["4", "6"]);
  await card(5).click();
  assert.deepEqual(await range(), ["5", "5"]);
  await card(6).click();
  assert.deepEqual(await range(), ["5", "6"]);
  assert.deepEqual(await highlighted(), [5, 6]);

  // Shift+click extends from the start. Reaching into "登录" asks first, and
  // backing out restores the range that was there before.
  await card(2).click({ modifiers: ["Shift"] });
  await page.locator(".confirm-dialog").filter({ hasText: "测试步骤 1 · 登录" }).waitFor();
  await page.click(".confirm-dialog .confirm-cancel");
  assert.deepEqual(await range(), ["5", "6"]);

  // Dragging is a range too. This time the tester accepts the warning.
  const from = await card(2).boundingBox();
  const to = await card(4).boundingBox();
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 20, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  assert.deepEqual(await range(), ["2", "4"]);
  await page.locator(".confirm-dialog").filter({ hasText: "原有的标注会被丢弃" }).waitFor();
  await page.click(".confirm-dialog .confirm-submit");
  await page.locator(".confirm-dialog").waitFor({ state: "detached" });

  // Already confirmed, so saving asks nothing more and drops the old step.
  await page.fill(".intent-step-title", "填写");
  await page.fill(".intent-step-checks", "表单已填写");
  await page.click(".preview-intent-editor .confirm-submit");
  await page.waitForSelector(".preview-intent-editor", { state: "detached" });
  assert.equal(await page.locator(".preview-range-hint").count(), 0);
  assert.equal(await page.locator("#preview-steps-container.is-picking-range").count(), 0);
  const details = await page.evaluate(caseId => chrome.runtime.sendMessage({ action: "getCaseDetails", caseId }), saved.case.id);
  assert.deepEqual(details.case.intent.steps.map(step => [step.title, step.start, step.end]), [["填写", 2, 4]]);
});

async function seedSelectionCase(t, name) {
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const extensionId = new URL(worker.url()).host;
  const actions = Array.from({ length: 6 }, (_, index) => ({
    id: `sel${index}`, type: "click", timestamp: index, pageName: "page1", url: "https://example.test/flow",
    target: { tagName: "button", role: "button", accessibleName: `按钮${index + 1}`, outerHTML: "<button></button>", parentChain: [] }
  }));
  await worker.evaluate(async actions => {
    const writes = { actionOrder: actions.map(action => action.id), isRecording: false, uiLanguage: "zh_CN",
      workspaceIntent: { steps: [{ id: "login", title: "登录", start: 1, end: 2, checks: ["进入工作台"] }] } };
    for (const action of actions) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
  }, actions);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 400, height: 900 });
  await panel.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  await panel.waitForSelector("#intent-btn:not([disabled])");
  const saved = await panel.evaluate(name => chrome.runtime.sendMessage({ action: "saveCase", name }), name);
  assert.equal(saved.success, true);
  return { context, worker, extensionId, panel, caseId: saved.case.id };
}

test("the side panel annotates the checked steps, asking before it replaces an annotation", async t => {
  const { worker, panel } = await seedSelectionCase(t, "侧边栏勾选用例");
  const checkbox = number => panel.locator(`#steps-container .step-card[data-step-index="${number - 1}"] .step-select-checkbox`);
  const button = panel.locator("#intent-btn");
  assert.equal((await button.innerText()).trim(), "标注意图");

  // 3 and 5 checked: the range is 3-5, and step 4 is included and tinted.
  await checkbox(3).check();
  await checkbox(5).check();
  assert.equal((await button.innerText()).trim(), "标注第 3–5 步");
  assert.equal(await button.getAttribute("title"), "包含中间未勾选的步骤");
  assert.equal(await panel.locator("#steps-container.has-range-gaps .step-card.is-intent-highlighted:not(.is-selected)").count(), 1);

  // Shift+click extends the selection back to step 2, which "登录" covers.
  await checkbox(2).click({ modifiers: ["Shift"] });
  assert.equal((await button.innerText()).trim(), "标注第 2–5 步");
  await button.click();
  await panel.locator(".confirm-dialog").filter({ hasText: "测试步骤 1 · 登录" }).waitFor();
  await panel.click(".confirm-dialog .confirm-cancel");
  await panel.locator(".confirm-dialog").waitFor({ state: "detached" });
  assert.equal(await panel.locator(".intent-dialog").count(), 0, "backing out opens no editor");
  assert.equal((await button.innerText()).trim(), "标注第 2–5 步", "and keeps the selection");

  await button.click();
  await panel.click(".confirm-dialog .confirm-submit");
  await panel.waitForSelector(".intent-dialog");
  assert.equal(await panel.locator(".intent-picker").count(), 0, "a selection skips the annotation list");
  assert.equal(await panel.locator(".intent-step-position").inputValue(), "2");
  assert.equal(await panel.locator(".intent-step-end").inputValue(), "5");
  await panel.fill(".intent-step-title", "下单");
  await panel.fill(".intent-step-checks", "订单已提交");
  await panel.click(".intent-dialog .confirm-submit");
  await panel.waitForSelector(".intent-dialog", { state: "detached" });

  const stored = await worker.evaluate(async () => (await chrome.storage.local.get("workspaceIntent")).workspaceIntent);
  assert.deepEqual(stored.steps.map(step => [step.title, step.start, step.end]), [["下单", 2, 5]]);
  await panel.waitForFunction(() => document.querySelector("#intent-btn .intent-btn-range")?.hidden);
  assert.equal(await panel.locator("#steps-container .step-card.is-selected").count(), 0, "saving clears the selection");
});

test("the workbench annotates the checked steps and keeps them adjustable on the list", async t => {
  const { context, extensionId, caseId } = await seedSelectionCase(t, "工作台勾选用例");
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`chrome-extension://${extensionId}/ui/console.html?caseId=${caseId}`);
  await page.waitForSelector("#preview-panel:not([hidden])");
  const checkbox = number => page.locator(`#preview-steps-container .step-card[data-step-index="${number - 1}"] .step-select-checkbox`);
  const add = page.locator("#preview-add-intent-btn");

  await checkbox(4).check();
  await checkbox(6).check();
  assert.equal((await add.innerText()).trim(), "标注第 4–6 步");
  await add.click();
  await page.waitForSelector(".preview-intent-editor");
  assert.equal(await page.locator(".confirm-dialog").count(), 0, "no annotation is in the way");
  assert.equal(await page.locator(".intent-step-position").inputValue(), "4");
  assert.equal(await page.locator(".intent-step-end").inputValue(), "6");
  // While the editor is open the checkboxes give way to picking on the cards.
  assert.equal(await checkbox(1).isVisible(), false);
  await page.locator('#preview-steps-container .step-card[data-step-index="2"] .step-description').click();
  await page.locator('#preview-steps-container .step-card[data-step-index="4"] .step-description').click();
  assert.equal(await page.locator(".intent-step-position").inputValue(), "3");
  assert.equal(await page.locator(".intent-step-end").inputValue(), "5");
  await page.click(".preview-intent-editor .confirm-cancel");
  await page.waitForSelector(".preview-intent-editor", { state: "detached" });
  assert.equal((await add.innerText()).trim(), "新增测试步骤", "the selection was handed to the editor");
});
