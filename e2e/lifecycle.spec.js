const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const test = require("node:test");
const { chromium } = require("@playwright/test");
const { strFromU8, unzipSync } = require("fflate");

function startFixtureServer() {
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    if (req.url === "/self-closing-frame") {
      res.end(`<!doctype html><html><body>
        <style>.my-icon-close {display:inline-block;width:24px;height:24px;cursor:auto}.my-icon-close::before{content:'×'}</style>
        <span id="custom-frame-close" data-v-a506f636="" class="my-icon-close close"></span>
        <button id="native-frame-close">Close frame</button>
        <span id="frame-inert" class="my-icon-close close"></span>
        <script>
          for (const id of ["custom-frame-close", "native-frame-close"]) {
            document.getElementById(id).addEventListener("click", () => window.frameElement.closest(".layui-layer").remove());
          }
        </script>
      </body></html>`);
      return;
    }

    if (req.url === "/child") {
      res.end(`<!doctype html>
        <html><head><title>Child page</title></head>
        <body><button id="child-action">Child action</button><button id="child-resume-action">Child resume action</button><a id="login-submit" href="/logged-in">Log in</a><script>
          document.querySelector("#child-action").addEventListener("click", () => {
            document.body.dataset.clicked = "true";
          });
          document.querySelector("#child-resume-action").addEventListener("click", () => {
            document.body.dataset.resumed = "true";
          });
        </script></body></html>`);
      return;
    }

    if (req.url === "/logged-in") {
      res.end(`<!doctype html><html><head><title>Logged in</title></head>
        <body><h1>Welcome</h1><button id="after-login-action">Continue</button><script>
          document.querySelector("#after-login-action").addEventListener("click", () => {
            document.body.dataset.continued = "true";
          });
        </script></body></html>`);
      return;
    }

    if (req.url === "/frame") {
      res.end(`<!doctype html><html><head><title>Embedded designer</title></head><body>
        <div class="drag-item" id="frame-drag-source" style="position:absolute;left:10px;top:20px;width:100px;height:50px;background:#fde68a;user-select:none;"><span>表格</span></div>
        <div id="frame-drop-target" style="position:absolute;left:160px;top:20px;width:110px;height:70px;background:#ddd6fe;">设计画布</div>
      </body></html>`);
      return;
    }

    if (req.url === "/editor") {
      res.end(`<!doctype html><html><head><title>CKEditor frame</title></head>
        <body contenteditable="true" class="cke_editable cke_editable_themed cke_contents_ltr"><p>初始内容</p></body></html>`);
      return;
    }

    if (req.url === "/unrelated") {
      res.end("<!doctype html><html><body><button id=\"unrelated-action\">Unrelated action</button></body></html>");
      return;
    }

    res.end(`<!doctype html>
      <html><head><title>Base page</title></head>
      <body>
        <div id="wide-layout" style="width: 2400px; height: 1px;"></div>
        <label>Query <input id="query" type="text"></label>
        <label>Scripted <input id="scripted-value" type="text"></label>
        <label>Synthetic <input id="synthetic-value" type="text"></label>
        <button id="open-async-dialog">Open async dialog</button>
        <button id="noop-action">No effect</button>
        <button id="effect-action">Visible effect</button>
        <button id="scripted-click-target">Scripted click target</button>
        <div id="drag-source" style="position:absolute;z-index:10;left:40px;top:320px;width:100px;height:60px;background:#93c5fd;user-select:none;cursor:grab;">Task card</div>
        <div id="drop-target" style="position:absolute;z-index:10;left:260px;top:320px;width:140px;height:80px;background:#bbf7d0;">Done list</div>
        <a id="open-child" href="/child" target="_blank">Open child</a>
        <iframe id="formdesign-frame" src="/frame"></iframe>
        <iframe id="cke-editor-frame" src="/editor"></iframe>
        <script>
          document.querySelector("#open-async-dialog").addEventListener("click", () => {
            const dialog = document.createElement("div");
            dialog.id = "async-dialog";
            dialog.setAttribute("role", "dialog");
            dialog.innerHTML = '<div role="progressbar" aria-label="Loading result" style="width:120px;height:8px">Loading</div>';
            document.body.appendChild(dialog);
            setTimeout(() => {
              dialog.innerHTML = '<p id="async-result">Loaded result</p>';
            }, 700);
          });
          document.querySelector("#effect-action").addEventListener("click", () => {
            document.body.dataset.effectCount = String(Number(document.body.dataset.effectCount || 0) + 1);
            document.body.setAttribute("aria-busy", "true");
            setTimeout(() => document.body.removeAttribute("aria-busy"), 1500);
          });
          document.querySelector("#scripted-click-target").addEventListener("click", () => {
            document.body.dataset.scriptedClickCount = String(Number(document.body.dataset.scriptedClickCount || 0) + 1);
          });
        </script>
      </body></html>`);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => {
          server.closeAllConnections();
          server.close(done);
        })
      });
    });
  });
}

async function waitForCondition(check, description, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${description}`);
}

/**
 * Steps live in one storage record per action with `actionOrder` holding the
 * order, so there is no plain `actions` key to read.
 */
function readActions(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const { actionOrder = [] } = await chrome.storage.local.get("actionOrder");
    if (actionOrder.length === 0) return [];
    const stored = await chrome.storage.local.get(actionOrder.map(id => `action:${id}`));
    return actionOrder.map(id => stored[`action:${id}`]).filter(Boolean);
  });
}

/** Counts strong red pixels in a stored JPEG to prove the target frame was baked in. */
function countRedPixels(serviceWorker, screenshotKey) {
  return serviceWorker.evaluate(async (key) => {
    const blob = await globalThis.RecorderMediaStore.getBlob(key);
    if (!blob) return 0;
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      if (red > 180 && green < 120 && blue < 120 && red - green > 90 && red - blue > 90) count++;
    }
    return count;
  }, screenshotKey);
}

/** Seeds the step list, dropping records the new list no longer references. */
function writeActions(serviceWorker, actions) {
  return serviceWorker.evaluate(async (list) => {
    const { actionOrder = [] } = await chrome.storage.local.get("actionOrder");
    const nextOrder = list.map(action => action.id);
    const writes = { actionOrder: nextOrder };
    for (const action of list) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
    const stale = actionOrder.filter(id => !nextOrder.includes(id)).map(id => `action:${id}`);
    if (stale.length > 0) await chrome.storage.local.remove(stale);
  }, actions);
}

/**
 * Saved cases live behind an index: metadata in `caseIndex`, steps in
 * `case:<id>`, screenshot references in `caseMedia:<id>`. There is no `cases`
 * array to read, and a fixture that wrote one would be invisible to the panel.
 */
function readCases(serviceWorker) {
  return serviceWorker.evaluate(async () => {
    const { caseIndex = [] } = await chrome.storage.local.get("caseIndex");
    if (caseIndex.length === 0) return [];
    const stored = await chrome.storage.local.get(caseIndex.map(entry => `case:${entry.id}`));
    return caseIndex.map(entry => ({ ...entry, ...(stored[`case:${entry.id}`] || {}) }));
  });
}

/** Seeds saved cases in the split layout, replacing whatever was there. */
function writeCases(serviceWorker, cases) {
  return serviceWorker.evaluate(async (list) => {
    const { caseIndex = [] } = await chrome.storage.local.get("caseIndex");
    const writes = {
      caseIndex: list.map(record => ({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        stepCount: record.actions.length,
        readable: true
      })).sort((a, b) => (b.createdAt - a.createdAt) || String(b.id).localeCompare(String(a.id)))
    };
    for (const record of list) {
      writes[`case:${record.id}`] = { id: record.id, actions: record.actions, pages: record.pages };
      writes[`caseMedia:${record.id}`] = [...new Set(record.actions.flatMap(action => [
        action.screenshotBeforeKey,
        action.screenshotKey
      ]).filter(Boolean))];
    }
    await chrome.storage.local.set(writes);
    const stale = caseIndex
      .filter(entry => !list.some(record => record.id === entry.id))
      .flatMap(entry => [`case:${entry.id}`, `caseMedia:${entry.id}`]);
    if (stale.length > 0) await chrome.storage.local.remove(stale);
  }, cases);
}

async function waitForActions(serviceWorker, predicate, timeoutMs = LOADED_MACHINE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let actions = [];

  while (Date.now() < deadline) {
    actions = await readActions(serviceWorker);
    if (predicate(actions)) return actions;
    await new Promise(resolve => setTimeout(resolve, 50));
  }

  try {
    const debug = await serviceWorker.evaluate(() => chrome.storage.local.get("recordingDebugTimeline"));
    fs.writeFileSync(path.join(__dirname, "..", ".local", "e2e-timeout-debug.json"), JSON.stringify(debug, null, 2));
  } catch { /* Keep the original assertion if the failed browser has gone away. */ }
  assert.fail(`Timed out waiting for actions. Last actions: ${JSON.stringify(actions)}`);
}

async function waitForRecorder(serviceWorker, url) {
  // DOMContentLoaded precedes asynchronous extension injection. The old page
  // overlay implicitly waited for it; recorder readiness is the actual contract.
  await waitForCondition(() => serviceWorker.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find(tab => tab.url === url);
    if (!tab) return false;
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { action: "pingRecorder" }, { frameId: 0 });
      return response?.status === "ready";
    } catch {
      return false;
    }
  }, url), `recorder injection into ${url}`);
}

/**
 * A recorded step is read back through the service worker, and the click that
 * produces it waits on the renderer. Both get slow on a loaded machine -- a
 * single storage round trip has been measured at nine seconds -- so the default
 * ten-second budget can expire before the step it waits for is ever read.
 */
const LOADED_MACHINE_TIMEOUT_MS = 30000;

/**
 * Clicks inside the fixture's child page skip the actionability checks: the page
 * is static, and what this asserts is which tabs a paused session re-adopts, not
 * whether Playwright can reach a button. A background tab's throttled animation
 * frames are enough to stall the stability check past its default timeout.
 */
const CLICK_IN_CHILD = { force: true, timeout: LOADED_MACHINE_TIMEOUT_MS };

test("A B C tabs keep independent drafts while recorded child tabs share their parent's steps", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN",
    recordingConsentVersion: 3, captureSettings: { screenshots: true } }));
  const pages = [];
  for (const name of ["A", "B", "C"]) {
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/base?draft=${name}`);
    await page.evaluate(name => { document.title = `Draft ${name}`; }, name);
    pages.push(page);
  }
  const [a, b, c] = pages;
  const ids = await worker.evaluate(async urls => {
    const tabs = await chrome.tabs.query({});
    return urls.map(url => tabs.find(tab => tab.url === url).id);
  }, pages.map(page => page.url()));
  const panel = await context.newPage();
  const extensionId = worker.url().split("/")[2];
  const show = async tabId => {
    await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabId);
    await panel.goto(`chrome-extension://${extensionId}/ui/popup.html?show=${Date.now()}`);
    await panel.waitForFunction(() => !document.getElementById("record-btn").disabled);
    const state = await panel.evaluate(tabId => chrome.runtime.sendMessage({ action: "getDraftState", tabId }), tabId);
    assert.ok(state.draftId);
    assert.equal(await panel.locator("#recording-draft-select").count(), 0);
    return state.draftId;
  };
  const pressRecord = () => panel.evaluate(() => document.getElementById("record-btn").click());
  const draftA = await show(ids[0]);
  await pressRecord();
  await waitForActions(worker, list => list.some(action => action.type === "navigate" && action.screenshotKey));
  await a.locator("#scripted-click-target").click();
  await waitForActions(worker, list => list.some(action => action.target?.id === "scripted-click-target"));
  const childPromise = context.waitForEvent("page");
  await a.locator("#open-child").click();
  const child = await childPromise;
  await child.waitForLoadState();
  await waitForRecorder(worker, child.url());
  const childId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, child.url());
  assert.equal(await show(childId), draftA);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("isRecording"))).isRecording, true, "opening the child panel keeps the shared recording running");
  await child.locator("#child-action").click(CLICK_IN_CHILD);
  await waitForActions(worker, list => list.some(action => action.target?.id === "child-action" && action.screenshotKey));
  await a.locator("#query").fill("pending A input");
  await a.frameLocator("#cke-editor-frame").locator("body").fill("pending iframe A input");
  const draftB = await show(ids[1]);
  assert.notEqual(draftB, draftA);
  assert.equal(await panel.locator(".step-card").count(), 0, JSON.stringify({ actions: await readActions(worker),
    draftB, state: await worker.evaluate(() => chrome.storage.local.get(["isRecording", "recordingDraftIndex", "activeRecordingDraftId"])) }));
  assert.match(await panel.locator("#record-btn-label").innerText(), /开始录制/);
  const aState = await panel.evaluate(tabId => chrome.runtime.sendMessage({ action: "getDraftState", tabId }), ids[0]);
  assert.ok(aState.actions.some(action => action.value === "pending A input"), "switch pauses and flushes pending input before stashing A");
  assert.ok(aState.actions.some(action => action.value === "pending iframe A input"), "every iframe must acknowledge its committed input before the draft switches");
  assert.ok(aState.actions.some(action => action.pageName === "page2" && action.target?.id === "child-action"));
  assert.equal(aState.state.isRecording, false);
  const frameKeysA = aState.actions.flatMap(action => [action.screenshotKey, action.screenshotBeforeKey]).filter(Boolean);
  assert.ok(frameKeysA.length > 0);
  await pressRecord();
  await waitForActions(worker, list => list.some(action => action.type === "navigate" && action.screenshotKey));
  await b.locator("#scripted-click-target").click();
  await waitForActions(worker, list => list.some(action => action.target?.id === "scripted-click-target" && action.screenshotKey));
  const draftC = await show(ids[2]);
  assert.notEqual(draftC, draftB);
  assert.equal(await panel.locator(".step-card").count(), 0);
  await panel.locator("#recover-recordings-btn").waitFor({ state: "visible" });
  const bState = await panel.evaluate(tabId => chrome.runtime.sendMessage({ action: "getDraftState", tabId }), ids[1]);
  assert.equal(bState.actions.length, 2);
  const stale = await panel.evaluate(draftId => chrome.runtime.sendMessage({ action: "clearSteps", workspaceDraftId: draftId }), draftA);
  assert.equal(stale.success, false, "an old A confirmation cannot clear C");
  await panel.evaluate(() => chrome.runtime.sendMessage({ action: "cleanupScreenshots", force: true }));
  assert.ok(await worker.evaluate(async keys => (await Promise.all(keys.map(key => RecorderMediaStore.getBlob(key)))).every(Boolean), frameKeysA));
  // Chrome retains a side-panel document when switching tabs. Exercise that
  // visibility handshake too, rather than only testing freshly opened panels.
  // This tab-hosted test page models the panel's visible state explicitly.
  await panel.evaluate(() => {
    window.retainedDraftPanel = true;
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  });
  await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), ids[0]);
  await panel.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal(await panel.evaluate(() => window.retainedDraftPanel), true, "switching back reuses the panel document");
  await panel.waitForFunction(count => document.querySelectorAll(".step-card").length === count, aState.actions.length);
  assert.match(await panel.locator("#record-btn-label").innerText(), /继续录制/);
  assert.deepEqual((await readActions(worker)).map(action => action.id), aState.actions.map(action => action.id));
  await pressRecord();
  await waitForCondition(async () => (await worker.evaluate(() => chrome.storage.local.get("isRecording"))).isRecording, "A resumed");
  // isRecording is published before recorder injection finishes. Wait for the
  // panel's start request to complete before exercising the resumed page.
  await panel.waitForFunction(() => !document.getElementById("record-btn").disabled);
  await a.locator("#scripted-click-target").click();
  await waitForActions(worker, list => list.length > aState.actions.length);
  await pressRecord();
  await waitForCondition(async () => !(await worker.evaluate(() => chrome.storage.local.get("isRecording"))).isRecording, "A paused");
  await panel.locator("#clear-steps-btn").click();
  await panel.locator(".confirm-submit").click();
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 0);
  assert.equal(await show(ids[1]), draftB);
  assert.deepEqual((await readActions(worker)).map(action => action.id), bState.actions.map(action => action.id));
  assert.match(await panel.locator("#record-btn-label").innerText(), /继续录制/);
  assert.equal((await readCases(worker)).length, 0, "switching drafts does not create unwanted saved cases");
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await panel.setViewportSize({ width: 360, height: 800 });
  assert.equal(await panel.locator("#recover-recordings-btn").isVisible(), false, "only B has unsaved steps after A is cleared");
  const bounds = await panel.locator(".header-utilities").boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360);
  if (process.env.DRAFT_PREVIEW_DIR) {
    const output = path.resolve(process.env.DRAFT_PREVIEW_DIR);
    fs.mkdirSync(output, { recursive: true });
    await panel.screenshot({ path: path.join(output, "independent-drafts.png") });
  }
  assert.deepEqual(errors, []);
  await b.close();
  await show(ids[2]);
  await pressRecord();
  await waitForActions(worker, list => list.some(action => action.type === "navigate" && action.screenshotKey));
  await panel.waitForFunction(() => !document.getElementById("record-btn").disabled);
  await pressRecord();
  await waitForCondition(async () => !(await worker.evaluate(() => chrome.storage.local.get("isRecording"))).isRecording, "C paused");
  await panel.locator("#recover-recordings-btn").waitFor({ state: "visible" });
  await panel.locator("#recover-recordings-btn").click();
  await panel.locator(`[data-draft-id="${draftB}"]`).click();
  await panel.waitForFunction(count => document.querySelectorAll(".step-card").length === count, bState.actions.length);
  assert.deepEqual((await readActions(worker)).map(action => action.id), bState.actions.map(action => action.id), "a closed tab's recording can be recovered through the recovery entry");
});

test("recovery stays hidden until multiple unsaved recordings exist and restores without losing work", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN",
    recordingConsentVersion: 3, captureSettings: { screenshots: false } }));
  const pages = [];
  for (const name of ["A", "B", "C"]) {
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/base?recovery=${name}`);
    await page.evaluate(name => { document.title = `录制 ${name}`; }, name);
    pages.push(page);
  }
  const [a, b, c] = pages;
  const ids = await worker.evaluate(async urls => {
    const tabs = await chrome.tabs.query({});
    return urls.map(url => tabs.find(tab => tab.url === url).id);
  }, pages.map(page => page.url()));
  const panel = await context.newPage();
  const errors = [];
  panel.setDefaultTimeout(15000);
  panel.on("pageerror", error => {
    errors.push(error.message);
    console.error("[Recovery test] Panel error:", error.message);
  });
  const show = async tabId => {
    await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabId);
    await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
    await panel.waitForFunction(() => !document.getElementById("record-btn").disabled);
    return panel.evaluate(tabId => chrome.runtime.sendMessage({ action: "getDraftState", tabId }), tabId);
  };
  const pressRecord = () => panel.evaluate(() => document.getElementById("record-btn").click());
  const recordingIs = async expected => {
    await waitForCondition(async () =>
      (await worker.evaluate(() => chrome.storage.local.get("isRecording"))).isRecording === expected, `recording ${expected}`);
    await panel.waitForFunction(() => !document.getElementById("record-btn").disabled);
  };
  const first = await show(ids[0]);
  assert.equal(await panel.locator("#recording-draft-select").count(), 0);
  assert.doesNotMatch(await panel.locator("body").innerText(), /当前草稿|草稿自动保留/);
  assert.equal(await panel.locator("#recover-recordings-btn").isVisible(), false);
  await panel.setViewportSize({ width: 360, height: 800 });
  if (process.env.RECOVERY_PREVIEW_DIR) {
    fs.mkdirSync(process.env.RECOVERY_PREVIEW_DIR, { recursive: true });
    await panel.screenshot({ path: path.join(process.env.RECOVERY_PREVIEW_DIR, "default.png") });
  }
  await pressRecord();
  await waitForActions(worker, actions => actions.some(action => action.type === "navigate"));
  await recordingIs(true);
  assert.equal(await panel.locator("#recover-recordings-btn").isVisible(), false, "one recording adds no recovery UI");
  await pressRecord();
  await recordingIs(false);
  const aActions = await readActions(worker);
  const second = await show(ids[1]);
  assert.equal(await panel.locator("#recover-recordings-btn").isVisible(), false, "an empty draft does not count");
  await pressRecord();
  await waitForActions(worker, actions => actions.some(action => action.type === "navigate"));
  await recordingIs(true);
  await panel.locator("#recover-recordings-btn").waitFor({ state: "visible" });
  assert.equal(await panel.locator("#recording-recovery-panel").isVisible(), false, "recovery remains collapsed until requested");
  await pressRecord();
  await recordingIs(false);
  const saved = await panel.evaluate(() => chrome.runtime.sendMessage({ action: "saveCase", name: "已保存录制 B" }));
  assert.equal(saved.success, true);
  await panel.locator("#recover-recordings-btn").waitFor({ state: "hidden" });
  await pressRecord();
  await recordingIs(true);
  assert.equal(await panel.locator("#recover-recordings-btn").isVisible(), false, "continuing a saved baseline alone does not make it unsaved");
  await b.locator("#scripted-click-target").click();
  await waitForActions(worker, actions => actions.some(action => action.target?.id === "scripted-click-target"));
  await panel.locator("#recover-recordings-btn").waitFor({ state: "visible" });
  await panel.locator("#recover-recordings-btn").click();
  assert.equal(await panel.locator("#recover-recordings-btn").getAttribute("aria-expanded"), "true");
  await panel.locator("#close-recording-recovery-btn").click();
  assert.equal(await panel.locator("#recording-recovery-panel").isVisible(), false);
  assert.equal(await panel.evaluate(() => document.activeElement.id), "recover-recordings-btn");
  await panel.locator("#recover-recordings-btn").click();
  await panel.locator(".steps-section-head h2").click();
  assert.equal(await panel.locator("#recording-recovery-panel").isVisible(), false, "clicking outside closes the list");
  await panel.locator("#recover-recordings-btn").click();
  // Hold just the recovery request so loading feedback can be verified without
  // adding a fake delay to the product or depending on the worker's speed.
  await panel.evaluate(() => {
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    window.recoveryTest = { failOnce: true };
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.action === "selectDraft") {
        if (window.recoveryTest.failOnce) {
          window.recoveryTest.failOnce = false;
          queueMicrotask(() => args.at(-1)({ success: false, error: "测试恢复失败，请重试" }));
        } else {
          window.recoveryTest.release = () => {
            chrome.runtime.sendMessage = original;
            return original(message, ...args);
          };
        }
        return;
      }
      return original(message, ...args);
    };
  });
  await panel.locator(`[data-draft-id="${first.draftId}"]`).click();
  await panel.locator(".recorder-toast.danger").filter({ hasText: "测试恢复失败" }).waitFor();
  await panel.waitForFunction(() => !document.querySelector(".recording-recovery-item").disabled);
  assert.equal(await panel.locator("#recording-recovery-panel").isVisible(), true, "failure leaves the list open for retry");
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("activeRecordingDraftId"))).activeRecordingDraftId, second.draftId);
  await panel.locator(`[data-draft-id="${first.draftId}"]`).click();
  await panel.waitForFunction(() => document.getElementById("recording-recovery-panel").getAttribute("aria-busy") === "true");
  assert.equal(await panel.locator(".recorder-toast.danger").count(), 0, "retry clears the earlier failure message");
  assert.match(await panel.locator(".is-recovering .recording-recovery-action").innerText(), /恢复中/);
  assert.equal(await panel.locator(".recording-recovery-item:disabled").count(), 1);
  await panel.evaluate(() => { window.recoveringRow = document.querySelector(".is-recovering"); });
  await worker.evaluate(() => chrome.storage.local.set({ screenshotCaptureState: { busy: false, updatedAt: Date.now() } }));
  assert.equal(await panel.evaluate(() => window.recoveringRow === document.querySelector(".is-recovering")), true,
    "storage refreshes preserve loading feedback");
  if (process.env.RECOVERY_PREVIEW_DIR) {
    await panel.screenshot({ path: path.join(process.env.RECOVERY_PREVIEW_DIR, "recovering.png") });
  }
  await panel.locator("#close-recording-recovery-btn").click();
  assert.equal(await panel.locator("#recording-recovery-panel").isVisible(), false, "the list can also close while recovery is pending");
  await panel.locator("#recover-recordings-btn").click();
  assert.equal(await panel.locator(".is-recovering").count(), 1);
  await panel.evaluate(() => window.recoveryTest.release());
  await recordingIs(false);
  await panel.waitForFunction(count => document.querySelectorAll(".step-card").length === count, aActions.length);
  assert.deepEqual((await readActions(worker)).map(action => action.id), aActions.map(action => action.id));
  await panel.locator("#recording-recovery-panel").waitFor({ state: "hidden" });
  await panel.locator(".recorder-toast:not(.danger)").filter({ hasText: "已恢复「录制 A」（1 个步骤）" }).waitFor();
  assert.equal(await panel.evaluate(() => document.activeElement.id), "record-btn");
  if (process.env.RECOVERY_PREVIEW_DIR) {
    await panel.screenshot({ path: path.join(process.env.RECOVERY_PREVIEW_DIR, "recovered.png") });
  }
  const retainedB = await panel.evaluate(tabId => chrome.runtime.sendMessage({ action: "getDraftState", tabId }), ids[1]);
  // B's old recording is now unbound because A was deliberately recovered into B.
  const bSnapshot = await worker.evaluate(id => chrome.storage.local.get(`recordingDraft:${id}`), second.draftId);
  const bActions = bSnapshot[`recordingDraft:${second.draftId}`].actions;
  assert.ok(bActions.some(action => action.target?.id === "scripted-click-target"), "recovery keeps B's unsaved changes");
  assert.equal(retainedB.draftId, first.draftId);
  await a.close();
  await b.close();
  await show(ids[2]);
  await panel.locator("#recover-recordings-btn").waitFor({ state: "visible" });
  await panel.locator("#recover-recordings-btn").click();
  assert.equal(await panel.locator(".recording-recovery-item").count(), 2);
  for (const selector of ["#recover-recordings-btn", "#recording-recovery-panel"]) {
    const bounds = await panel.locator(selector).boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 360, `${selector} fits a narrow panel`);
  }
  if (process.env.RECOVERY_PREVIEW_DIR) {
    await panel.screenshot({ path: path.join(process.env.RECOVERY_PREVIEW_DIR, "recovery.png") });
  }
  await panel.keyboard.press("Escape");
  assert.equal(await panel.locator("#recording-recovery-panel").isVisible(), false);
  assert.equal(await panel.locator("#recover-recordings-btn").getAttribute("aria-expanded"), "false");
  await panel.locator("#recover-recordings-btn").click();
  await panel.locator(`[data-draft-id="${second.draftId}"]`).click();
  await panel.waitForFunction(count => document.querySelectorAll(".step-card").length === count, bActions.length);
  assert.deepEqual((await readActions(worker)).map(action => action.id), bActions.map(action => action.id), "closed-tab recordings stay recoverable");
  assert.equal((await readCases(worker)).length, 1, "recovery does not create cases");
  assert.equal(c.isClosed(), false);
  assert.deepEqual(errors, []);
});

test("retention automatically discards the oldest recording at eleven while preserving active work and saved-case media", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(async () => {
    const writes = { isRecording: false, uiLanguage: "zh_CN", recordingConsentVersion: 3,
      captureSettings: { screenshots: false }, recordingDraftIndex: [],
      caseIndex: [{ id: "retention-saved", name: "保留的用例", createdAt: 1, stepCount: 1, readable: true }],
      "case:retention-saved": { id: "retention-saved", actions: [{ id: "saved-step", type: "click", screenshotKey: "retention-shared" }], pages: [] },
      "caseMedia:retention-saved": ["retention-shared"] };
    for (let number = 1; number <= 10; number++) {
      const id = `retained-${number}`;
      writes.recordingDraftIndex.push({ id, tabIds: [], title: `历史录制 ${number}`, stepCount: 1, savedCaseId: null, updatedAt: number });
      const actions = [{ id: `old-step-${number}`, type: "click" }];
      if (number === 1) Object.assign(actions[0], { screenshotKey: "retention-old", screenshotBeforeKey: "retention-shared" });
      writes[`recordingDraft:${id}`] = { actions, state: {} };
      writes[`recordingDraftMedia:${id}`] = number === 1 ? ["retention-old", "retention-shared"] : [];
    }
    await chrome.storage.local.set(writes);
    await RecorderMediaStore.withWriteLock(async () => {
      await RecorderMediaStore.putBlob("retention-old", new Blob(["discarded screenshot"]));
      await RecorderMediaStore.putBlob("retention-shared", new Blob(["shared saved screenshot"]));
    });
  });
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base?retention=live`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const panel = await context.newPage();
  panel.setDefaultTimeout(15000);
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await worker.evaluate(tabId => chrome.tabs.update(tabId, { active: true }), tabId);
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await panel.waitForFunction(() => !document.getElementById("record-btn").disabled);
  const before = await worker.evaluate(() => chrome.storage.local.get(["recordingDraftIndex", "activeRecordingDraftId"]));
  assert.equal(before.recordingDraftIndex.length, 11, "opening an empty draft does not discard a recording");
  assert.equal(before.recordingDraftIndex[0].id, "retained-1");
  await panel.evaluate(() => document.getElementById("record-btn").click());
  await waitForActions(worker, actions => actions.some(action => action.type === "navigate"));
  await waitForCondition(async () => {
    const state = await worker.evaluate(() => chrome.storage.local.get("recordingDraftIndex"));
    return state.recordingDraftIndex.length === 10 && !state.recordingDraftIndex.some(draft => draft.id === "retained-1");
  }, "automatic ten-recording retention");
  await waitForCondition(async () => !(await worker.evaluate(() => RecorderMediaStore.getBlob("retention-old"))), "discarded screenshot cleanup");
  const after = await worker.evaluate(() => chrome.storage.local.get(["recordingDraftIndex", "activeRecordingDraftId", "isRecording",
    "recordingDraft:retained-1", "recordingDraftMedia:retained-1", "case:retention-saved"]));
  assert.equal(after.activeRecordingDraftId, before.activeRecordingDraftId);
  assert.equal(after.isRecording, true, "retention does not stop the active recording");
  assert.equal(after["recordingDraft:retained-1"], undefined);
  assert.equal(after["recordingDraftMedia:retained-1"], undefined);
  assert.equal(after["case:retention-saved"].actions[0].screenshotKey, "retention-shared");
  assert.equal(await worker.evaluate(async () => (await RecorderMediaStore.getBlob("retention-shared"))?.text()), "shared saved screenshot");
  const current = await panel.evaluate(tabId => chrome.runtime.sendMessage({ action: "getDraftState", tabId }), tabId);
  assert.equal(current.drafts.filter(draft => draft.hasUnsavedChanges).length, 10);
  assert.equal(current.actions.length, 1);
  assert.equal((await readCases(worker)).length, 1);
  assert.deepEqual(errors, []);
});

test("opening the panel fits only the top frame without starting recording or repeated zoom", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, captureSettings: { screenshots: false } }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  await page.evaluate(() => {
    globalThis.zoomWrites = 0;
    // DOM mutations cross isolated worlds; patched JS methods do not.
    new MutationObserver(records => { globalThis.zoomWrites += records.length; })
      .observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
  });
  const tab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  const layout = open => panel.evaluate(({ tabId, windowId, open }) => chrome.runtime.sendMessage({
    action: "setSidePanelLayout", tabId, windowId, open
  }), { tabId: tab.id, windowId: tab.windowId, open });
  assert.equal((await layout(true)).success, true);
  await page.waitForFunction(() => !!document.documentElement.style.zoom);
  const instrumentation = () => worker.evaluate(async tabId => (await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: () => ({ recorder: !!window.hasPlaywrightRecorderInjected,
      analyzer: !!window.SemanticElementAnalyzer, layout: !!globalThis.RecorderPageFit })
  })).map(result => ({ frameId: result.frameId, ...result.result })), tab.id);
  const frames = await instrumentation();
  assert.ok(frames.length >= 3);
  assert.ok(frames.every(frame => !frame.recorder && !frame.analyzer), "opening alone does not install recording scripts");
  assert.ok(frames.find(frame => frame.frameId === 0).layout);
  assert.ok(frames.filter(frame => frame.frameId !== 0).every(frame => !frame.layout), "layout is top-frame only");
  // A resize caused by the zoom itself, or by taller content, must not re-fit.
  await page.evaluate(() => document.body.append(document.createElement("p")));
  assert.equal((await layout(true)).success, true);
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 300)));
  assert.equal(await page.evaluate(() => globalThis.zoomWrites), 1);
  const toggle = start => panel.evaluate(({ tabId, start }) => chrome.runtime.sendMessage({
    action: "toggleRecording", start, rootTabId: tabId
  }), { tabId: tab.id, start });
  assert.equal((await toggle(true)).success, true);
  assert.ok((await instrumentation()).every(frame => frame.recorder && frame.analyzer));
  await page.locator("#scripted-click-target").click();
  await waitForActions(worker, list => list.some(action => action.target?.id === "scripted-click-target"));
  assert.equal((await toggle(false)).success, true);
  assert.ok(await page.evaluate(() => !!document.documentElement.style.zoom), "recording stop preserves panel layout");
  assert.equal((await layout(false)).success, true);
  await page.waitForFunction(() => document.documentElement.style.zoom === "");
  assert.equal((await layout(true)).success, true);
  await page.waitForFunction(() => !!document.documentElement.style.zoom);
});

test("folder trees collapse independently without changing selections or move targets", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: "zh_CN", isRecording: false }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/console.html`);
  await page.locator(".case-folder-button").first().waitFor({ state: "visible" });
  const folders = [
    { id: "root", name: "Root", parentId: null, createdAt: 1 },
    { id: "child", name: "Child", parentId: "root", createdAt: 2 },
    { id: "leaf", name: "Leaf", parentId: "child", createdAt: 3 },
    { id: "sibling", name: "Sibling", parentId: "root", createdAt: 4 },
    { id: "other", name: "Other", parentId: null, createdAt: 5 }
  ];
  await worker.evaluate(folders => chrome.storage.local.set({ caseFolders: folders }), folders);
  await writeCases(worker, [1, 2].map(index => ({
    id: `folder-case-${index}`, name: `Folder case ${index}`, createdAt: index,
    actions: [{ id: `folder-step-${index}`, type: "click", pageName: "page1" }], pages: []
  })));
  await page.waitForFunction(() => document.querySelectorAll(".library-item").length === 2);
  const sidebar = page.locator("#case-folder-list");
  const row = (container, id) => container.locator(`[data-folder-id="${id}"]`);
  const toggle = (container, id) => row(container, id).locator(".folder-toggle");
  assert.equal(await toggle(sidebar, "leaf").count(), 0);
  assert.equal(await toggle(sidebar, "unfiled").count(), 0);
  await row(sidebar, "root").locator(".case-folder-button").click();
  const subfolders = page.locator("#case-library-list");
  assert.equal(await subfolders.isVisible(), true, "folders remain visible even without cases");
  assert.equal(await page.locator("#case-library-select-all").isDisabled(), true);
  assert.equal(await subfolders.locator(".subfolder-card").count(), 2);
  assert.equal(await subfolders.locator('[data-subfolder-id="leaf"]').count(), 0, "only direct children are listed");
  await subfolders.locator('[data-subfolder-id="child"] .subfolder-more').click();
  assert.equal(await page.locator('.folder-menu [role="menuitem"]').count(), 3);
  await page.keyboard.press("Escape");
  await subfolders.locator('[data-subfolder-id="child"] .subfolder-open').click();
  assert.equal(await subfolders.locator(".subfolder-card").count(), 1);
  await subfolders.locator('[data-subfolder-id="leaf"] .subfolder-open').click();
  assert.equal(await subfolders.locator(".subfolder-card").count(), 0);
  assert.equal(await row(sidebar, "leaf").locator(".case-folder-button").evaluate(button => button.classList.contains("is-active")), true);
  const breadcrumb = page.locator("#library-location-title");
  assert.equal(await breadcrumb.innerText(), "Root / Child / Leaf");
  assert.equal(await breadcrumb.locator('[aria-current="location"]').innerText(), "Leaf");
  await breadcrumb.locator('button[data-folder-id="child"]').click();
  assert.equal(await breadcrumb.innerText(), "Root / Child");
  assert.equal(await subfolders.locator('[data-subfolder-id="leaf"]').count(), 1);
  await breadcrumb.locator('button[data-folder-id="root"]').focus();
  await page.keyboard.press("Enter");
  assert.equal(await breadcrumb.innerText(), "Root");
  assert.equal(await breadcrumb.locator("button").count(), 0);
  assert.equal(await row(sidebar, "root").locator(".case-folder-button").evaluate(button => button.classList.contains("is-active")), true);
  await page.locator("#all-cases-btn").click();
  assert.equal(await subfolders.locator(".subfolder-card").count(), 0);
  await page.locator("#case-library-select-all").check();
  const selected = await page.locator("#case-selection-count").innerText();

  async function checkCollapse(container) {
    await toggle(container, "child").click();
    assert.equal(await row(container, "leaf").isHidden(), true);
    await toggle(container, "root").click();
    assert.equal(await row(container, "child").isHidden(), true);
    assert.equal(await row(container, "sibling").isHidden(), true);
    assert.equal(await row(container, "other").isVisible(), true);
    assert.equal(await toggle(container, "root").getAttribute("aria-expanded"), "false");
    await toggle(container, "root").focus();
    await page.keyboard.press("Enter");
    assert.equal(await row(container, "child").isVisible(), true);
    assert.equal(await row(container, "leaf").isHidden(), true, "child keeps its own collapsed state");
    assert.equal(await row(container, "sibling").isVisible(), true);
  }

  await checkCollapse(sidebar);
  assert.equal(await page.locator("#case-selection-count").innerText(), selected);
  assert.equal(await page.locator("#case-search-scope").inputValue(), "all");
  await page.locator("#case-search-input").fill("Folder");
  assert.equal(await row(sidebar, "leaf").isHidden(), true, "filter renders preserve collapse state");
  await page.locator("#case-search-input").fill("");
  await worker.evaluate(folders => chrome.storage.local.set({
    caseFolders: folders.map(folder => folder.id === "other" ? { ...folder, name: "Other renamed" } : folder)
  }), folders);
  await page.waitForFunction(() => document.querySelector('[data-folder-id="other"] .case-folder-button')?.title === "Other renamed");
  assert.equal(await row(sidebar, "leaf").isHidden(), true, "storage refresh preserves collapse state");

  await page.locator("#move-cases-folder-btn").click();
  const choices = page.locator(".move-folder-choices");
  await checkCollapse(choices);
  assert.equal(await row(choices, "unfiled").locator(".is-selected").count(), 1);
  await toggle(choices, "child").click();
  await row(choices, "leaf").locator(".move-folder-choice").click();
  await toggle(choices, "root").click();
  assert.equal(await row(choices, "leaf").locator(".is-selected").count(), 1);
  await page.locator(".confirm-submit").click();
  await page.locator(".move-folder-dialog").waitFor({ state: "detached" });
  assert.ok((await readCases(worker)).every(item => item.folderId === "leaf"));
  assert.equal(await row(sidebar, "leaf").isHidden(), true, "dialog expansion does not expand the sidebar");
  await row(sidebar, "root").locator(".case-folder-button").click();
  assert.equal(await page.locator(".library-item").count(), 2, "parent filter still includes collapsed descendants");
  assert.ok((await page.locator('[data-case-id="folder-case-1"] .library-item-info > span').innerText()).endsWith(" · Root / Child / Leaf"), "nested case metadata includes the complete folder path");
  assert.equal(await subfolders.locator(":scope > :first-child").getAttribute("data-subfolder-id"), "child", "folders precede cases in the shared list");
  assert.equal(await subfolders.locator(".library-folder-item input[type=checkbox]").count(), 0, "batch selection excludes folders");
  assert.equal(await subfolders.locator(".library-folder-item .library-item-symbol").count(), 2);

  const leafColor = await row(sidebar, "leaf").locator(".case-folder-button > svg").evaluate(el => getComputedStyle(el).color);
  assert.equal(await page.locator('[data-case-id="folder-case-1"] .case-folder-label[data-folder-id="leaf"]').evaluate(el => getComputedStyle(el).color), leafColor, "sidebar and case folder colors agree");

  // Single-case moving reveals its current destination even if its parents were collapsed.
  await page.locator('[data-case-id="folder-case-1"] .library-item-btn.move').click();
  assert.equal(await row(choices, "leaf").isVisible(), true);
  assert.equal(await row(choices, "leaf").locator(".is-selected").count(), 1);
  await toggle(choices, "child").click();
  await page.locator(".confirm-cancel").click();
  await page.locator("#case-library-select-all").check();
  await page.locator("#move-cases-folder-btn").click();
  assert.equal(await row(choices, "leaf").isHidden(), true, "reopening keeps dialog collapse state");
  await row(choices, "other").locator(".move-folder-choice").click();
  await page.locator(".confirm-submit").click();
  await page.locator(".move-folder-dialog").waitFor({ state: "detached" });
  assert.ok((await readCases(worker)).every(item => item.folderId === "other"));

  await toggle(sidebar, "root").click();
  await row(sidebar, "root").hover();
  await row(sidebar, "root").locator(".case-folder-add").click();
  await page.locator(".recording-name-field input").fill("New child");
  await page.locator(".confirm-submit").click();
  await page.waitForFunction(() => [...document.querySelectorAll(".case-folder-button")]
    .some(button => button.title === "New child" && button.classList.contains("is-active")));
  assert.equal(await toggle(sidebar, "root").getAttribute("aria-expanded"), "true");
  await page.setViewportSize({ width: 360, height: 800 });
  await toggle(sidebar, "root").click();
  assert.equal(await row(sidebar, "child").isHidden(), true);
  await toggle(sidebar, "root").click();
  assert.equal(await row(sidebar, "child").isVisible(), true);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#case-search-scope").selectOption("all");
  await toggle(sidebar, "root").click();
  await page.locator('[data-case-id="folder-case-1"]').dragTo(row(sidebar, "root").locator(".case-folder-button"));
  await waitForCondition(async () => (await readCases(worker)).find(item => item.id === "folder-case-1")?.folderId === "root", "drop on a collapsed folder");
  assert.equal(await row(sidebar, "child").isHidden(), true);
  assert.equal((await readCases(worker)).find(item => item.id === "folder-case-2").folderId, "other");
  assert.deepEqual(errors, []);
});

test("folders can be renamed and moved by menu or drag without changing their cases", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: "en", isRecording: false }));
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = `chrome-extension://${worker.url().split("/")[2]}/ui/console.html`;
  await page.goto(url);
  await page.locator(".case-folder-button").first().waitFor({ state: "visible" });
  const folders = [
    { id: "source", name: "Source", parentId: null, createdAt: 1 },
    { id: "child", name: "Child", parentId: "source", createdAt: 2 },
    { id: "target", name: "Target", parentId: null, createdAt: 3 },
    { id: "deep", name: "Deep", parentId: "target", createdAt: 4 },
    { id: "deepest", name: "Deepest", parentId: "deep", createdAt: 5 },
    { id: "duplicate-parent", name: "Duplicate parent", parentId: null, createdAt: 6 },
    { id: "duplicate", name: "Renamed", parentId: "duplicate-parent", createdAt: 7 },
    { id: "empty", name: "Empty", parentId: null, createdAt: 8 }
  ];
  await worker.evaluate(folders => chrome.storage.local.set({ caseFolders: folders }), folders);
  await writeCases(worker, [{
    id: "moving-folder-case", name: "Preserved case", createdAt: 1,
    actions: [{ id: "preserved-step", type: "click", pageName: "page1", screenshotKey: "preserved-shot" }], pages: []
  }]);
  const assigned = await page.evaluate(() => chrome.runtime.sendMessage({
    action: "moveCasesToFolder", caseIds: ["moving-folder-case"], folderId: "child"
  }));
  assert.equal(assigned.success, true);
  const beforeCases = await readCases(worker);
  const sidebar = page.locator("#case-folder-list");
  const folder = id => sidebar.locator(`[data-folder-id="${id}"]`);
  const readFolder = id => worker.evaluate(async id =>
    (await chrome.storage.local.get("caseFolders")).caseFolders.find(folder => folder.id === id), id);
  async function openMenu(id) {
    await folder(id).hover();
    await folder(id).locator(".case-folder-more").click();
    await page.locator(".folder-menu").waitFor({ state: "visible" });
  }
  await folder("source").waitFor({ state: "visible" });
  assert.equal(await folder("source").locator(".case-folder-button").getAttribute("draggable"), "true");
  assert.match(await page.locator(".case-folder-heading").getAttribute("title"), /return to the root/);
  assert.match(await page.locator(".case-folder-hint").innerText(), /Drag to move/);
  await openMenu("source");
  assert.equal(await page.getByRole("menuitem", { name: "Delete folder", exact: true }).isDisabled(), true);
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  assert.equal(await page.locator(".recording-name-field input").inputValue(), "Source");
  await page.locator(".recording-name-field input").fill("Renamed");
  await page.locator(".confirm-submit").click();
  await waitForCondition(async () => (await readFolder("source"))?.name === "Renamed", "folder renamed");
  assert.deepEqual(await readFolder("source"), { ...folders[0], name: "Renamed" });
  await openMenu("source");
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.locator(".recording-name-field input").fill("Target");
  await page.locator(".confirm-submit").click();
  await page.locator(".recorder-toast.danger").waitFor({ state: "visible" });
  assert.equal((await readFolder("source")).name, "Renamed");

  await openMenu("source");
  await page.getByRole("menuitem", { name: "Move folder", exact: true }).click();
  const choice = id => page.locator(`.move-folder-row[data-folder-id="${id}"] .move-folder-choice`);
  for (const id of ["source", "child", "deep", "deepest", "duplicate-parent"]) {
    assert.equal(await choice(id).isDisabled(), true, `${id} is an invalid subtree destination`);
  }
  assert.equal(await choice("target").isEnabled(), true);
  assert.equal((await choice("unfiled").innerText()).trim(), "Root folders");
  await page.locator(".confirm-cancel").click();

  await folder("target").locator(".folder-toggle").click();
  await folder("source").locator(".case-folder-button").dragTo(folder("target").locator(".case-folder-button"));
  await waitForCondition(async () => (await readFolder("source")).parentId === "target", "subtree drag move");
  assert.equal((await readFolder("child")).parentId, "source");
  await folder("child").waitFor({ state: "visible" });
  assert.equal(await folder("target").locator(".folder-toggle").getAttribute("aria-expanded"), "true");
  assert.deepEqual(await readCases(worker), beforeCases);
  await folder("source").locator(".case-folder-button").dragTo(page.locator(".case-folder-heading"));
  await waitForCondition(async () => (await readFolder("source")).parentId === null, "drag back to root");
  await folder("source").locator(".case-folder-button").dragTo(folder("child").locator(".case-folder-button"));
  assert.equal((await readFolder("source")).parentId, null, "dropping into its child does nothing");

  await openMenu("source");
  await page.getByRole("menuitem", { name: "Move folder", exact: true }).click();
  await choice("target").click();
  await page.locator(".confirm-submit").click();
  await page.locator(".move-folder-dialog").waitFor({ state: "detached" });
  assert.equal((await readFolder("source")).parentId, "target");
  await openMenu("source");
  await page.getByRole("menuitem", { name: "Move folder", exact: true }).click();
  await choice("unfiled").click();
  await page.locator(".confirm-submit").click();
  await page.locator(".move-folder-dialog").waitFor({ state: "detached" });
  assert.equal((await readFolder("source")).parentId, null);
  await openMenu("empty");
  await page.getByRole("menuitem", { name: "Delete folder", exact: true }).click();
  await page.locator(".confirm-submit").click();
  await waitForCondition(async () => !(await readFolder("empty")), "delete through folder menu");

  await page.setViewportSize({ width: 360, height: 800 });
  await openMenu("source");
  assert.equal(await page.locator(".folder-menu").evaluate(menu => {
    const rect = menu.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight;
  }), true);
  await page.keyboard.press("ArrowDown");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Move folder");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".folder-menu").count(), 0);
  await page.reload();
  await folder("source").waitFor({ state: "visible" });
  assert.equal(await folder("source").locator(".case-folder-button").getAttribute("title"), "Renamed");
  assert.deepEqual(await readCases(worker), beforeCases);
  assert.deepEqual(errors, []);
});

test("side-panel saving selects nested folders and rejects a folder deleted while the dialog is open", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  await writeActions(worker, [{ id: "filed-step", type: "click", timestamp: 1, pageName: "page1",
    target: { tagName: "button", accessibleName: "Confirm" } }]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (request, ...rest) => {
      if (globalThis.simulateLegacySave && request?.action === "saveCase") {
        request = { ...request };
        delete request.folderId;
      }
      return send(request, ...rest);
    };
  });
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await page.locator(".step-card").waitFor();
  const send = request => page.evaluate(request => chrome.runtime.sendMessage(request), request);
  const root = await send({ action: "createCaseFolder", name: "流程分类" });
  const child = await send({ action: "createCaseFolder", name: "登录", parentId: root.folder.id });
  const leaf = await send({ action: "createCaseFolder", name: "提交", parentId: child.folder.id });
  const temporary = await send({ action: "createCaseFolder", name: "临时分类" });
  const workbench = await context.newPage();
  await workbench.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/console.html`);
  await workbench.locator('[data-folder-id="unfiled"] .case-folder-button').click();
  const save = page.locator("#save-current-case-btn");
  const select = page.locator(".save-case-folder");
  await save.click();
  assert.equal(await select.locator('[aria-checked="true"]').getAttribute("data-folder-id"), "");
  assert.equal(await select.locator(`[data-folder-id="${child.folder.id}"]`).getAttribute("title"), "流程分类 / 登录");
  const leafRow = select.locator(`[data-folder-id="${leaf.folder.id}"]`);
  assert.equal(await leafRow.getAttribute("title"), "流程分类 / 登录 / 提交");
  await leafRow.click();
  await leafRow.press("ArrowUp");
  await select.locator(`[data-folder-id="${child.folder.id}"]`).press("Enter");
  assert.equal(await page.locator(".prompt-text-dialog").isVisible(), true);
  assert.equal(await select.locator('[aria-checked="true"]').getAttribute("data-folder-id"), child.folder.id);
  await page.locator(".prompt-text-dialog input").fill("分类用例");
  await select.locator(`[data-folder-id="${child.folder.id}"]`).click();
  await page.setViewportSize({ width: 300, height: 650 });
  const fits = await page.locator(".prompt-text-dialog").evaluate(el => {
    const rect = el.getBoundingClientRect();
    const field = el.querySelector(".folder-picker").getBoundingClientRect();
    return rect.left >= 0 && rect.right <= innerWidth && field.right <= rect.right;
  });
  assert.equal(fits, true);
  await page.locator(".confirm-submit").click();
  await page.waitForFunction(() => document.querySelector("#save-current-case-btn").classList.contains("success"));
  const saved = await send({ action: "listCases" });
  assert.equal(saved.cases.length, 1);
  assert.equal(saved.cases[0].folderId, child.folder.id);
  assert.equal(await workbench.locator(".library-item").count(), 0, "classified save stays out of Unfiled");
  await workbench.locator(`[data-folder-id="${root.folder.id}"] .case-folder-button`).click();
  await workbench.locator(".library-item").waitFor();
  assert.ok((await workbench.locator(".library-item").innerText()).includes("分类用例"));

  await save.click();
  await page.locator(".confirm-submit").click();
  assert.equal(await page.locator(".prompt-text-dialog").isVisible(), true);
  assert.match(await page.locator("#prompt-validation-error").innerText(), /同名用例/);
  assert.equal((await send({ action: "listCases" })).cases.length, 1);
  await select.locator(`[data-folder-id="${leaf.folder.id}"]`).click();
  assert.equal(await page.locator("#prompt-validation-error").isHidden(), true);
  await page.locator(".confirm-cancel").click();

  await page.evaluate(() => RecorderI18n.setLanguage("en"));
  await save.click();
  assert.equal(await select.locator('[aria-checked="true"]').getAttribute("data-folder-id"), child.folder.id);
  assert.equal(await select.locator(".folder-picker-name").first().innerText(), "Unfiled");
  await page.locator(".confirm-submit").click();
  assert.match(await page.locator("#prompt-validation-error").innerText(), /already exists/i);
  await page.locator(".confirm-cancel").click();
  assert.equal((await send({ action: "listCases" })).cases.length, 1);

  await save.click();
  await select.locator(`[data-folder-id="${temporary.folder.id}"]`).click();
  assert.equal((await send({ action: "deleteCaseFolder", folderId: temporary.folder.id })).success, true);
  await page.locator(".confirm-submit").click();
  await page.locator(".recorder-toast.danger").waitFor();
  assert.equal((await send({ action: "listCases" })).cases.length, 1);
  assert.equal(await save.isEnabled(), true);
  await save.click();
  await select.locator('[data-folder-id=""]').click();
  await page.locator(".confirm-submit").click();
  await page.waitForFunction(async () => (await chrome.runtime.sendMessage({ action: "listCases" })).cases.length === 2);
  assert.equal((await send({ action: "listCases" })).cases.filter(item => item.folderId === null).length, 1);
  // Model a stale background save route that drops the new classification argument.
  await page.evaluate(() => { globalThis.simulateLegacySave = true; });
  await save.click();
  await select.locator(`[data-folder-id="${child.folder.id}"]`).click();
  await page.locator(".prompt-text-dialog input").fill("旧后台分类用例");
  await page.locator(".confirm-submit").click();
  await waitForCondition(async () => (await send({action:"listCases"})).cases.some(item =>
    item.name === "旧后台分类用例" && item.folderId === child.folder.id), "legacy save classification corrected");
  await workbench.locator(`[data-folder-id="${root.folder.id}"] .case-folder-button`).click();
  await workbench.waitForFunction(() => document.querySelectorAll(".library-item").length === 2);
  await workbench.locator('[data-folder-id="unfiled"] .case-folder-button').click();
  assert.equal(await workbench.locator(".library-item").count(), 1, "only the explicitly unfiled save appears here");
  await workbench.reload();
  await workbench.locator(`[data-folder-id="${root.folder.id}"] .case-folder-button`).click();
  assert.equal(await workbench.locator(".library-item").count(), 2, "classification persists across reload");
  assert.deepEqual(errors, []);
});

test("public workbench organizes file actions and keeps Bridge records hidden", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: "zh_CN", isRecording: false }));
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(() => {
    window.agentRequests = [];
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (request, ...args) => {
      if (request?.action?.startsWith("agent")) window.agentRequests.push(request.action);
      return send(request, ...args);
    };
  });
  const url = `chrome-extension://${worker.url().split("/")[2]}/ui/console.html`;
  await page.goto(url);
  await page.locator(".case-folder-button").first().waitFor({ state: "visible" });
  const cases = [1, 2].map(index => ({
    id: `public-case-${index}`, name: `Public case ${index}`, createdAt: index,
    actions: [{ id: `public-step-${index}`, type: "click", pageName: "page1", timestamp: index,
      target: { tagName: "button", accessibleName: "Submit" }, screenshotKey: "public-shot" }],
    pages: [{ name: "page1", url: "https://example.test" }]
  }));
  await writeCases(worker, cases);
  await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg"));
    await globalThis.RecorderMediaStore.putBlob("public-shot", blob);
  });
  const storedJobs = {
    "retained-run": { jobId: "retained-run", status: "completed", clientCaseId: cases[0].id, events: [] }
  };
  await worker.evaluate(jobs => chrome.storage.local.set({ recorderAgentJobs: jobs }), storedJobs);
  await page.waitForFunction(() => document.querySelectorAll(".library-item").length === 2);

  for (const language of ["zh_CN", "en"]) {
    await page.evaluate(language => globalThis.RecorderI18n.setLanguage(language), language);
    for (const width of [1280, 900, 760, 600, 360]) {
      await page.setViewportSize({ width, height: 900 });
      const plus = page.locator("#create-case-folder-btn");
      assert.equal(await plus.isVisible(), true);
      assert.equal(await plus.evaluate(button => button.parentElement.classList.contains("case-folder-heading")), true);
      assert.equal((await plus.innerText()).trim(), "");
      assert.equal(await plus.getAttribute("aria-label"), language === "zh_CN" ? "新建文件夹" : "New folder");
      assert.equal(await page.locator("#view-records-btn").isHidden(), true);
      assert.equal(await page.locator(".library-head-actions #create-case-folder-btn").count(), 0);
      assert.equal(await page.locator(".library-head-actions #import-case-package-btn").count(), 1);
      assert.equal(await page.locator("#import-case-package-btn").isEnabled(), true);
      for (const selector of ["#create-case-folder-btn", "#import-case-package-btn", "#batch-export-cases-btn", "#export-case-package-btn", "#batch-delete-cases-btn"]) {
        const button = page.locator(selector);
        await button.hover();
        const fits = await button.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight &&
            element.scrollWidth <= element.clientWidth;
        });
        assert.equal(fits, true, `${selector} fits at ${width}px in ${language}`);
        assert.ok((await button.getAttribute("title"))?.length > 0);
      }
      assert.match(await page.locator("#batch-export-cases-btn").getAttribute("title"), /Markdown.*ZIP|ZIP.*Markdown/);
      assert.match(await page.locator("#export-case-package-btn").getAttribute("title"), /\.swrcase/);
      assert.match(await page.locator("#import-case-package-btn").getAttribute("title"), /\.swrcase/);
      assert.equal((await page.locator("#batch-delete-cases-btn").innerText()).trim(), language === "zh_CN" ? "删除" : "Delete");
    }
  }

  await page.evaluate(() => globalThis.RecorderI18n.setLanguage("zh_CN"));
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#create-case-folder-btn").click();
  await page.locator(".recording-name-field input").fill("Public folder");
  await page.locator(".confirm-submit").click();
  await waitForCondition(async () => (await worker.evaluate(() => chrome.storage.local.get("caseFolders")))
    .caseFolders?.some(folder => folder.name === "Public folder"), "folder created from heading plus");
  const folder = (await worker.evaluate(() => chrome.storage.local.get("caseFolders")))
    .caseFolders.find(item => item.name === "Public folder");
  assert.equal(folder.parentId, null);
  assert.equal(await page.locator("#library-location-title").innerText(), "Public folder");
  await page.locator("#all-cases-btn").click();
  assert.equal(await page.locator("#case-library-count").count(), 1);
  assert.equal(await page.locator("#library-location-title").innerText(), "全部用例");
  assert.equal(await page.locator("#library-location-meta").innerText(), "2 个用例");
  await page.waitForFunction(() => document.querySelectorAll(".library-item").length === 2);
  for (const selector of ["#batch-export-cases-btn", "#export-case-package-btn", "#batch-delete-cases-btn"]) {
    assert.equal(await page.locator(selector).isDisabled(), true);
  }
  await page.locator("#case-library-select-all").check();
  await page.locator("#batch-delete-cases-btn").click();
  assert.equal((await page.locator("#confirm-title").innerText()).trim(), "删除用例");
  assert.match(await page.locator("#confirm-message").innerText(), /2.*用例/);
  // The confirmation quotes counts rather than bytes, and the deletable count comes
  // from a preview that runs the same reference check the deletion itself will.
  assert.match(await page.locator("#confirm-message").innerText(), /共 \d+ 个步骤、\d+ 张截图，其中 \d+ 张/);
  await page.locator(".confirm-cancel").click();
  assert.equal((await readCases(worker)).length, 2);

  let sharedBytes;
  for (const [selector, extension] of [["#batch-export-cases-btn", ".zip"], ["#export-case-package-btn", ".swrcase"]]) {
    const pending = page.waitForEvent("download");
    await page.locator(selector).click();
    const download = await pending;
    assert.equal(download.suggestedFilename().endsWith(extension), true);
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const files = unzipSync(bytes);
    if (extension === ".zip") {
      assert.equal(Object.keys(files).filter(name => name.endsWith(".md")).length, 2);
      assert.equal(Object.keys(files).some(name => name.endsWith(".jpg")), true);
      assert.equal(files["workflow-recorder-case-package.json"], undefined);
    } else {
      const manifest = JSON.parse(strFromU8(files["workflow-recorder-case-package.json"]));
      assert.equal(manifest.cases.length, 2);
      sharedBytes = bytes;
    }
  }
  const chooser = page.waitForEvent("filechooser");
  await page.locator("#import-case-package-btn").click();
  await (await chooser).setFiles({ name: "shared.swrcase", mimeType: "application/zip", buffer: sharedBytes });
  await waitForCondition(async () => (await readCases(worker)).length === 4, "shared package imported");
  const imported = (await readCases(worker)).filter(item => !cases.some(original => original.id === item.id));
  assert.ok(imported.every(item => !item.folderId));

  // A bookmark from a build that had the execution-records view, or that named a
  // stored run, has to degrade to the library and the case preview: this build
  // ships none of those surfaces, and none of their messages may be sent.
  for (const query of ["?view=records", `?view=records&caseId=${cases[0].id}&caseTab=runs&jobId=retained-run`]) {
    await page.goto(url + query);
    for (const selector of [
      "#view-records-btn", "#execution-records-panel", "#preview-runs-tab", "#preview-runs-view",
      "#ai-execution-panel", "#agent-provider-field", "#agent-execute-btn", "#agent-mode-hint"
    ]) {
      assert.equal(await page.locator(selector).count(), 0, `${selector} should not ship`);
    }
    if (query.includes("caseId")) {
      await page.locator("#preview-panel").waitFor({ state: "visible" });
      // An unknown detail tab falls back to the steps rather than to nothing.
      assert.equal(await page.locator("#preview-steps-view").isVisible(), true);
      await page.locator("#preview-back-btn").click();
    }
    await page.locator("#case-library-panel").waitFor({ state: "visible" });
    assert.doesNotMatch(page.url(), /view=records|caseTab=runs|jobId=/);
    assert.deepEqual(await page.evaluate(() => window.agentRequests), []);
  }
  assert.deepEqual((await worker.evaluate(() => chrome.storage.local.get("recorderAgentJobs"))).recorderAgentJobs, storedJobs);
  assert.deepEqual(pageErrors, []);
});

test("side-panel preview shows full titles and navigates before and after screenshots", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  const panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  const steps = [
    { id: "preview-1", screenshotBeforeKey: "preview-before", screenshotKey: "preview-after" },
    { id: "preview-2", screenshotKey: "preview-missing" },
    { id: "preview-3", screenshotKey: "preview-last" }
  ].map((step, index) => ({ ...step, timestamp: index, type: "click", pageName: "page1",
    target: { tagName: "button", accessibleName: `A long operation description ${index}: ${"example ".repeat(12)}` }
  }));
  await writeActions(worker, steps);
  await panel.evaluate(async () => {
    for (const [index, key] of ["preview-before", "preview-after", "preview-last"].entries()) {
      const canvas = document.createElement("canvas");
      canvas.width = 640 + index * 100;
      canvas.height = 480;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg"));
      await globalThis.RecorderMediaStore.putBlob(key, blob);
    }
  });
  // Reload after seeding media so thumbnail loads cannot race their writes.
  await panel.reload();
  const thumbnails = panel.locator("[data-screenshot-key]");
  await panel.waitForFunction(() => document.querySelectorAll("[data-screenshot-key]").length === 4);
  await panel.waitForFunction(() => {
    const images = [...document.querySelectorAll(".step-screenshot")];
    return images.length === 3 && images.every(image => image.complete && image.naturalWidth > 0);
  });
  const titles = await thumbnails.evaluateAll(items => items.map(item => item.dataset.screenshotAlt));
  await panel.evaluate(() => {
    const create = URL.createObjectURL.bind(URL);
    const revoke = URL.revokeObjectURL.bind(URL);
    window.previewUrls = new Set();
    URL.createObjectURL = blob => {
      const url = create(blob);
      window.previewUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = url => { window.previewUrls.delete(url); revoke(url); };
  });
  const tabCount = context.pages().length;
  await thumbnails.nth(1).click();
  const overlay = panel.locator(".image-preview-overlay");
  const image = overlay.locator(".image-preview-full");
  const title = overlay.locator(".image-preview-title");
  const previous = overlay.locator('[data-action="previous"]');
  const next = overlay.locator('[data-action="next"]');
  const zoom = overlay.locator('[data-action="reset-zoom"]');
  await image.waitFor({ state: "visible" });
  await panel.waitForFunction(() => document.querySelector(".image-preview-full")?.naturalWidth === 740);
  assert.equal(context.pages().length, tabCount);
  assert.equal(await title.getAttribute("title"), titles[1]);
  assert.equal(await overlay.locator('[data-action="fit"]').count(), 0);
  for (const width of [300, 360, 1000]) {
    await panel.setViewportSize({ width, height: 720 });
    await title.hover();
    assert.equal(await title.getAttribute("title"), titles[1]);
    assert.equal(await overlay.locator(".image-preview-toolbar").evaluate((toolbar, width) => {
      const label = toolbar.querySelector(".image-preview-title");
      const actions = toolbar.querySelector(".image-preview-actions");
      return label.clientWidth > 16 && (width > 360 || label.scrollWidth > label.clientWidth) &&
        getComputedStyle(label).textOverflow === "ellipsis" &&
        label.getBoundingClientRect().right <= actions.getBoundingClientRect().left &&
        toolbar.scrollWidth <= toolbar.clientWidth;
    }, width), true, `preview toolbar fits at ${width}px`);
  }
  await panel.setViewportSize({ width: 360, height: 720 });
  await previous.click();
  await panel.waitForFunction(() => document.querySelector(".image-preview-full")?.naturalWidth === 640);
  assert.equal(await title.getAttribute("title"), titles[0]);
  assert.equal(await previous.isDisabled(), true);
  await panel.keyboard.press("ArrowLeft");
  assert.equal(await title.getAttribute("title"), titles[0]);
  await panel.keyboard.press("ArrowRight");
  await panel.waitForFunction(() => document.querySelector(".image-preview-full")?.naturalWidth === 740);
  const zoomBefore = await zoom.innerText();
  await overlay.locator('[data-action="zoom-in"]').click();
  assert.notEqual(await zoom.innerText(), zoomBefore);
  await zoom.click();
  assert.equal(await zoom.innerText(), "100%");
  assert.equal(await image.evaluate(element => element.draggable), false);
  await panel.evaluate(() => {
    window.nativePreviewDrags = 0;
    document.querySelector(".image-preview-full").addEventListener("dragstart", () => window.nativePreviewDrags++);
  });
  const position = () => image.evaluate(element => {
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    return { x: transform.m41, y: transform.m42 };
  });
  for (const [dx, dy] of [[100, 0], [-100, 0], [0, 80], [0, -80]]) {
    const before = await position();
    await panel.mouse.move(180, 380);
    await panel.mouse.down();
    await panel.mouse.move(180 + dx, 380 + dy, { steps: 12 });
    await panel.mouse.up();
    const after = await position();
    assert.ok(Math.abs(after.x - before.x - dx) < 1);
    assert.ok(Math.abs(after.y - before.y - dy) < 1);
    assert.equal(await overlay.locator(".image-preview-stage").evaluate(stage => stage.classList.contains("is-dragging")), false);
  }
  assert.equal(await panel.evaluate(() => window.nativePreviewDrags), 0);
  await next.click();
  await panel.waitForFunction(() => document.querySelector(".image-preview-message")?.textContent.includes("不存在"));
  assert.equal(await image.isHidden(), true);
  assert.equal(await title.getAttribute("title"), titles[2]);
  await next.click();
  await panel.waitForFunction(() => document.querySelector(".image-preview-full")?.naturalWidth === 840);
  assert.equal(await title.getAttribute("title"), titles[3]);
  assert.equal(await next.isDisabled(), true);

  // Resolve an earlier read after a later selection, then close with a read pending.
  await panel.evaluate(() => {
    const getBlob = globalThis.RecorderBridge.getBlob;
    window.restorePreviewRead = () => { globalThis.RecorderBridge.getBlob = getBlob; };
    globalThis.RecorderBridge.getBlob = key => key === "preview-missing"
      ? new Promise(resolve => { window.releasePreviewRead = async () => resolve(await getBlob("preview-after")); })
      : getBlob(key);
  });
  await previous.click();
  await panel.waitForFunction(() => typeof window.releasePreviewRead === "function");
  await previous.click();
  await panel.waitForFunction(() => document.querySelector(".image-preview-full")?.naturalWidth === 740);
  await panel.evaluate(() => window.releasePreviewRead());
  assert.equal(await title.getAttribute("title"), titles[1]);
  assert.equal(await image.evaluate(element => element.naturalWidth), 740);
  await next.click();
  await panel.keyboard.press("Escape");
  await panel.evaluate(() => window.releasePreviewRead());
  assert.equal(await overlay.count(), 0);
  assert.equal(await panel.evaluate(() => window.previewUrls.size), 0);
  await panel.evaluate(() => window.restorePreviewRead());

  // A previously rendered step gets its current number when reopened.
  await writeActions(worker, steps.slice(2));
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 1);
  await panel.locator('[data-screenshot-key="preview-last"]').click();
  await image.waitFor({ state: "visible" });
  assert.match(await title.getAttribute("title"), /^步骤 1/);
  assert.equal(await previous.isHidden(), true);
  assert.equal(await next.isHidden(), true);
  await panel.keyboard.press("Escape");

  // The shared reader still offers Fit in the workbench's read-only case preview.
  await writeCases(worker, [{ id: "preview-case", name: "Preview case", createdAt: 1, actions: steps.slice(0, 1), pages: [] }]);
  const workbench = await context.newPage();
  await workbench.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/console.html?caseId=preview-case`);
  await workbench.locator('[data-screenshot-key="preview-after"]').click();
  const casePreview = workbench.locator(".image-preview-overlay");
  await casePreview.locator(".image-preview-full").waitFor({ state: "visible" });
  assert.equal(await casePreview.locator('[data-action="fit"]').isVisible(), true);
  await casePreview.locator('[data-action="previous"]').click();
  await workbench.waitForFunction(() => document.querySelector(".image-preview-full")?.naturalWidth === 640);
  assert.equal(await casePreview.locator(".image-preview-title").getAttribute("title"), titles[0]);
  await workbench.keyboard.press("Escape");
  assert.deepEqual(errors, []);
});

test("step header controls share one center line in the recorder and preview", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const base = `chrome-extension://${worker.url().split("/")[2]}/ui/`;
  const panel = await context.newPage();
  await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: "zh_CN", isRecording: false }));
  await panel.goto(`${base}popup.html`);
  const actions = Array.from({ length: 12 }, (_, index) => ({
    id: `aligned-step-${index}`, timestamp: index, pageName: "page1",
    type: ["click", "type", "select", "pressKey"][index % 4], key: "Enter", value: "example",
    target: { tagName: "input", accessibleName: "Example field" },
    ...[
      { screenshotStatus: "captured", screenshotKey: "alignment-shot" },
      { screenshotStatus: "pending" },
      { screenshotStatus: "failed", screenshotKey: "alignment-shot" },
      {}
    ][index % 4]
  }));
  await writeActions(worker, actions);
  await writeCases(worker, [{
    id: "alignment-case", name: "Aligned steps", createdAt: 1, actions, pages: []
  }]);
  const preview = await context.newPage();
  for (const language of ["zh_CN", "en"]) {
    await worker.evaluate(language => chrome.storage.local.set({ uiLanguage: language }), language);
    await panel.reload();
    await preview.goto(`${base}console.html?caseId=alignment-case`);
    for (const [page, container] of [[panel, "#steps-container"], [preview, "#preview-steps-container"]]) {
      await page.waitForFunction(selector => document.querySelectorAll(`${selector} .step-card`).length === 12, container);
      for (const width of [300, 360, 600, 1000]) {
        await page.setViewportSize({ width, height: 800 });
        const rows = await page.locator(`${container} .step-card`).evaluateAll(cards => cards.map(card => {
          const controls = [...card.querySelectorAll(
            ".step-select-checkbox, .step-index, .step-type-badge, .step-page-tag, .step-status-tag, .step-delete-btn"
          )].filter(element => element.getClientRects().length);
          const rects = controls.map(element => element.getBoundingClientRect());
          const centers = rects.map(rect => rect.top + rect.height / 2);
          const header = card.querySelector(".step-header").getBoundingClientRect();
          return {
            centered: centers.every(center => Math.abs(center - header.top - header.height / 2) < 0.5),
            separated: rects.every((rect, index) => index === 0 || rect.left >= rects[index - 1].right),
            contained: rects.every(rect => rect.right <= card.getBoundingClientRect().right),
            headerHeight: header.height
          };
        }));
        for (const [index, row] of rows.entries()) {
          assert.deepEqual(row, { centered: true, separated: true, contained: true, headerHeight: 24 },
            `${language} ${container} row ${index + 1} at ${width}px`);
        }
      }
    }
  }
  await panel.locator(".step-select-checkbox").first().check();
  assert.equal(await panel.locator(".step-card").first().evaluate(card => card.classList.contains("is-selected")), true);
  await panel.locator(".step-delete-btn").first().click();
  await panel.locator(".confirm-cancel").click();
  assert.equal(await panel.locator(".step-card").count(), 12);
  assert.equal(await preview.locator(".step-select-checkbox, .step-delete-btn").count(), 0);
});

test("recording download fits the icon toolbar and stays available at every width", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  const panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  const download = panel.locator("#download-doc-compact-btn");
  const more = panel.locator("#more-actions-btn");
  const menuDownload = panel.locator("#download-doc-btn");
  assert.equal(await download.isHidden(), true);
  assert.equal(await more.isHidden(), true);
  await writeActions(worker, [{
    id: "download-step", timestamp: 1, type: "click", pageName: "page1",
    url: "https://example.test", target: { tagName: "button", accessibleName: "Download test" }
  }]);
  await more.waitFor({ state: "visible" });

  // The name is asked for on the first download and remembered afterwards, so the
  // prompt has to be answered once before the layout loop starts.
  await panel.setViewportSize({ width: 360, height: 720 });
  const primedDownload = panel.waitForEvent("download");
  await download.click();
  await panel.locator(".prompt-text-dialog input").fill("responsive-download");
  // The prompt has to say that the download banks the recording too, because that
  // is where the case the user will look for later comes from.
  assert.match(await panel.locator(".prompt-text-dialog #prompt-message").innerText(), /工作台/);
  await panel.locator(".prompt-text-dialog .confirm-submit").click();
  assert.equal((await primedDownload).suggestedFilename(), "responsive-download.zip");
  assert.deepEqual(
    (await readCases(worker)).map(item => item.name),
    ["responsive-download"],
    "the download saved the recording as a case"
  );

  let iconDownloadChecked = false;
  for (const language of ["zh_CN", "en"]) {
    await panel.evaluate(language => globalThis.RecorderI18n.setLanguage(language), language);
    const downloadWidths = new Map();
    for (const width of [1000, 561, 560, 420, 380, 360, 340, 330, 320, 300, 1000]) {
      await panel.setViewportSize({ width, height: 720 });
      // Wait for the responsive toolbar layout.
      await panel.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const narrow = width <= 560;
      assert.equal(await download.isVisible(), narrow);
      assert.equal(await more.isVisible(), !narrow);
      const layout = await (narrow ? download : more).evaluate(button => {
        const record = document.querySelector("#record-btn");
        const label = button.querySelector(".btn-label");
        const recordRect = record.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const utilities = document.querySelector(".header-utilities").getBoundingClientRect();
        return {
          fits: recordRect.left >= 0 && recordRect.right <= buttonRect.left &&
            buttonRect.right <= utilities.left && utilities.right <= innerWidth &&
            record.scrollWidth <= record.clientWidth && button.scrollWidth <= button.clientWidth &&
            Math.abs(recordRect.top - buttonRect.top) < 1,
          labelVisible: !!label && label.getBoundingClientRect().width > 1 && getComputedStyle(label).display !== "none",
          title: button.title,
          accessibleName: button.getAttribute("aria-label")
        };
      });
      assert.equal(layout.fits, true, `${language} toolbar fits at ${width}px`);
      const name = language === "zh_CN" ? "下载录制结果" : "Download recording";
      if (narrow) {
        assert.equal(layout.title, name);
        assert.equal(layout.accessibleName, name);
        assert.equal(layout.labelVisible, false);
        downloadWidths.set(layout.labelVisible, width);
      } else {
        await more.click();
        assert.equal(await menuDownload.isVisible(), true);
        assert.equal((await menuDownload.innerText()).trim(), name);
        await panel.keyboard.press("Escape");
        assert.equal(await menuDownload.isHidden(), true);
      }
    }

    assert.equal(downloadWidths.has(true), false);
    iconDownloadChecked ||= downloadWidths.has(false);
    for (const width of [1000, ...downloadWidths.values()]) {
      await panel.setViewportSize({ width, height: 720 });
      const pending = panel.waitForEvent("download");
      if (width > 560) {
        await more.click();
        await menuDownload.click();
        assert.equal(await menuDownload.isHidden(), true);
      } else {
        await download.click();
      }
      const archive = await pending;
      assert.equal(archive.suggestedFilename(), "responsive-download.zip");
      const stream = await archive.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
      assert.match(strFromU8(files["responsive-download/responsive-download.md"]), /Download test/);
    }
  }

  assert.equal(iconDownloadChecked, true, "the narrow layout exercises an icon-only download");
  // Every repeat exported the same unchanged workspace, so none of them banked a
  // second case.
  assert.equal((await readCases(worker)).length, 1, "a download does not save the same workspace twice");
  await panel.setViewportSize({ width: 1000, height: 720 });
  await more.click();
  await panel.setViewportSize({ width: 360, height: 720 });
  await panel.waitForFunction(() => document.querySelector("#more-actions-menu").hidden);
  assert.equal(await more.getAttribute("aria-expanded"), "false");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: true }));
  await download.waitFor({ state: "hidden" });
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false }));
  await download.waitFor({ state: "visible" });
  await writeActions(worker, []);
  await download.waitFor({ state: "hidden" });
  await panel.setViewportSize({ width: 1000, height: 720 });
  assert.equal(await more.isHidden(), true);
  // Starting a different workspace must not reuse the previous download name.
  await worker.evaluate(() => chrome.storage.local.set({ activeCaseId: null, workspaceOrigin: null }));
  await writeActions(worker, [{ id:"another-workspace-step",timestamp:2,type:"click",pageName:"page1",
    target:{tagName:"button",accessibleName:"Another workspace"} }]);
  await panel.setViewportSize({width:360,height:720});
  await download.waitFor({state:"visible"});
  await download.click();
  await panel.locator(".prompt-text-dialog input").waitFor();
  assert.equal(await panel.locator(".prompt-text-dialog input").inputValue(), "");
  await panel.locator(".prompt-text-dialog input").fill("new-workspace");
  const newDownload = panel.waitForEvent("download");
  await panel.locator(".prompt-text-dialog .confirm-submit").click();
  assert.equal((await newDownload).suggestedFilename(), "new-workspace.zip");

  // Loading a saved case after that uses the saved case's name, including after reload.
  const savedCase = (await readCases(worker)).find(item=>item.name==="responsive-download");
  await panel.evaluate(id=>chrome.runtime.sendMessage({action:"loadCase",caseId:id}),savedCase.id);
  await panel.reload();
  await download.waitFor({state:"visible"});
  const loadedDownload = panel.waitForEvent("download");
  await download.click();
  assert.equal((await loadedDownload).suggestedFilename(), "responsive-download.zip");
  assert.deepEqual(errors, []);
});

test("recording controls use the light theme and expose icon descriptions at every width", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({
    isRecording: false, uiLanguage: "zh_CN", recordingTabIds: []
  }));
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await writeActions(worker, [{
    id: "hover-style-step", timestamp: 1, type: "click", pageName: "page1",
    target: { tagName: "button", accessibleName: "Save" }
  }]);
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 1);

  const manual = panel.locator("#manual-screenshot-btn");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: true }));
  await manual.waitFor({ state: "visible" });
  let checkedIcon = false;
  for (const language of ["zh_CN", "en"]) {
    await panel.evaluate(language => globalThis.RecorderI18n.setLanguage(language), language);
    for (const width of [1000, 600, 560, 360, 340, 300, 1000]) {
      await panel.setViewportSize({ width, height: 720 });
      await panel.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const layout = await manual.evaluate(button => {
        const record = document.querySelector("#record-btn");
        const rect = button.getBoundingClientRect();
        const recordRect = record.getBoundingClientRect();
        const utilities = document.querySelector(".header-utilities").getBoundingClientRect();
        return {
          fits: rect.width > 0 && recordRect.right <= rect.left && rect.right <= utilities.left &&
            utilities.right <= innerWidth && record.scrollWidth <= record.clientWidth &&
            button.scrollWidth <= button.clientWidth,
          iconOnly: button.classList.contains("icon-only")
        };
      });
      assert.equal(layout.fits, true, `${language} screenshot control fits at ${width}px: ${JSON.stringify(layout)}`);
      assert.equal(layout.iconOnly, true);
      assert.ok(await panel.locator("#record-btn").evaluate(button =>
        button.clientWidth <= 36 && button.title === button.getAttribute("aria-label") &&
        button.title === globalThis.RecorderI18n.t("stopRecording")));
      checkedIcon ||= layout.iconOnly;
      const label = language === "zh_CN" ? "更新操作后截图" : "Update after-action screenshot";
      assert.equal(await manual.getAttribute("aria-label"), label);
      assert.equal((await manual.locator(".btn-label").textContent()).trim(), label);
      assert.match(await manual.getAttribute("title"), /当前页面最后一个操作.*不改变操作前截图|last operation on the current page, without changing its before-action screenshot/);
    }
  }
  assert.equal(checkedIcon, true, "the screenshot action always uses its icon");

  async function checkHover(page, selector, enabled = true) {
    const button = page.locator(selector).first();
    const readStyle = element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color, shadow: style.boxShadow };
    };
    await page.mouse.move(0, 0);
    const before = await button.evaluate(readStyle);
    await button.hover();
    if (enabled) {
      await waitForCondition(async () => (await button.evaluate(readStyle)).shadow.includes("inset"), `${selector} shared hover`);
      assert.notDeepEqual(await button.evaluate(readStyle), before, `${selector} has visible feedback`);
    } else {
      await page.waitForTimeout(200);
      assert.deepEqual(await button.evaluate(readStyle), before, `${selector} stays unchanged while disabled`);
    }
    await page.mouse.move(0, 0);
    await waitForCondition(async () => !(await button.evaluate(readStyle)).shadow.includes("inset"), `${selector} releases hover`);
  }

  async function checkLightSurface(page, selector) {
    const colors = await page.locator(selector).first().evaluate(element => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, color: style.color };
    });
    const channels = colors.background.match(/[\d.]+/g).map(Number);
    assert.ok(channels.slice(0, 3).every(channel => channel >= 220), `${selector}: ${colors.background}`);
    assert.notEqual(colors.background, colors.color, `${selector} has readable text`);
  }

  await checkHover(panel, "#manual-screenshot-btn");
  await checkHover(panel, "#record-btn");
  await checkLightSurface(panel, "#record-btn");
  await worker.evaluate(() => chrome.storage.local.set({
    screenshotCaptureState: { busy: true, pendingCount: 1, updatedAt: Date.now() }
  }));
  await panel.waitForFunction(() => document.querySelector("#manual-screenshot-btn").disabled);
  await checkHover(panel, "#manual-screenshot-btn", false);

  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false }));
  const save = panel.locator("#save-current-case-btn");
  await panel.waitForFunction(() => document.querySelector("#record-btn").dataset.recordingMode === "continue");
  const tokenBackground = async name => panel.evaluate(token => {
    const sample = document.createElement("span");
    sample.style.backgroundColor = `var(${token})`;
    document.body.append(sample);
    const color = getComputedStyle(sample).backgroundColor;
    sample.remove();
    return color;
  }, name);
  const accentBackground = await tokenBackground("--accent-color");
  for (const [selector, background] of [["#record-btn", "rgb(22, 163, 74)"], ["#copy-task-btn", accentBackground]]) {
    assert.deepEqual(await panel.locator(selector).evaluate(button => ({
      background: getComputedStyle(button).backgroundColor,
      color: getComputedStyle(button).color
    })), { background, color: "rgb(255, 255, 255)" });
  }
  assert.equal(await panel.locator(".copy-task-info").evaluate(button => getComputedStyle(button).color), await tokenBackground("--text-muted"));
  for (const selector of ["#record-btn", "#save-current-case-btn", "#copy-task-btn", "#more-actions-btn", "#open-console-btn", "#language-btn", ".copy-task-info"]) {
    await checkHover(panel, selector);
  }
  await save.click();
  await panel.locator(".prompt-text-dialog input").fill("Light theme test");
  await panel.locator(".prompt-text-dialog .confirm-submit").click();
  await panel.waitForFunction(() => document.querySelector("#save-current-case-btn").classList.contains("success"));
  await checkHover(panel, "#save-current-case-btn");
  await checkLightSurface(panel, "#save-current-case-btn");
  await panel.locator("#more-actions-btn").click();
  await checkHover(panel, "#download-doc-btn");
  await checkLightSurface(panel, "#more-actions-menu");
  await panel.keyboard.press("Escape");
  await panel.setViewportSize({ width: 360, height: 720 });
  await checkHover(panel, "#download-doc-compact-btn");
  await checkHover(panel, ".step-delete-btn");
  await panel.locator("#clear-steps-btn").click();
  await checkHover(panel, ".confirm-cancel");
  await checkHover(panel, ".confirm-submit");
  await checkLightSurface(panel, ".confirm-dialog");
  assert.deepEqual(await panel.locator(".confirm-submit").evaluate(button => ({
    background: getComputedStyle(button).backgroundColor,
    color: getComputedStyle(button).color
  })), { background: await tokenBackground("--danger-color"), color: "rgb(255, 255, 255)" });
  await panel.locator(".confirm-cancel").click();
  await checkLightSurface(panel, "#copy-task-tooltip");
  if (process.env.CAPTURE_RECORDER_ICONS === "1") {
    await panel.evaluate(() => globalThis.RecorderI18n.setLanguage("zh_CN"));
    await panel.mouse.move(0, 0);
    await panel.screenshot({ path: path.join(__dirname, "..", ".local", "recorder-icon-controls.png") });
  }

  // Motion is opt-in to the normal preference, not required for visible hover.
  await panel.emulateMedia({ reducedMotion: "no-preference" });
  await panel.locator("#record-btn").hover();
  await waitForCondition(async () => await panel.locator("#record-btn").evaluate(button => getComputedStyle(button).translate) === "0px -1px", "shared hover lift");
  await panel.mouse.down();
  await waitForCondition(async () => await panel.locator("#record-btn").evaluate(button => getComputedStyle(button).translate) === "0px", "pressed button returns to its baseline");
  await panel.mouse.move(0, 0);
  await panel.mouse.up();
  // The actionbar no longer opens with a text field, so reach the save button
  // from whatever precedes it in the tab order.
  await panel.evaluate(() => {
    const save = document.querySelector("#save-current-case-btn");
    const tabbables = [...document.querySelectorAll("button, [href], input, select, textarea, [tabindex]")]
      .filter(element => !element.disabled && element.getClientRects().length);
    tabbables[tabbables.indexOf(save) - 1]?.focus();
  });
  await panel.keyboard.press("Tab");
  assert.equal(await save.evaluate(button => button.matches(":focus-visible") && getComputedStyle(button).outlineStyle === "solid"), true);
  await panel.emulateMedia({ reducedMotion: "reduce", colorScheme: "dark" });
  assert.equal(await panel.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "light");
  await checkLightSurface(panel, "body");

  await panel.setViewportSize({ width: 1000, height: 720 });
  await panel.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 8;
    canvas.toBlob(blob => globalThis.RecorderImagePreview.openImagePreview(blob, "Light preview"));
  });
  await panel.locator(".image-preview-toolbar").waitFor({ state: "visible" });
  await checkLightSurface(panel, ".image-preview-toolbar");
  await checkLightSurface(panel, ".image-preview-stage");
  await checkHover(panel, ".image-preview-tool:not([hidden])");
  if (process.env.CAPTURE_LIGHT_THEME === "1") {
    await panel.screenshot({ path: path.join(process.env.TEMP, "opencode", "light-theme-preview.png") });
  }
  await panel.locator(".image-preview-close").click();

  const workbench = await context.newPage();
  await workbench.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/console.html`);
  await workbench.locator(".library-item-info").first().waitFor({ state: "visible" });
  for (const selector of ["#create-case-folder-btn", ".case-folder-button", ".library-item-btn"]) {
    await checkHover(workbench, selector);
  }
  await workbench.locator(".library-item-info").first().click();
  await workbench.locator("#preview-panel").waitFor({ state: "visible" });
  assert.equal(await workbench.locator("#preview-steps-container").isVisible(), true);
  await checkHover(workbench, "#preview-back-btn");
  await workbench.evaluate(() => {
    document.querySelector("#console-image-preview").hidden = false;
  });
  for (const selector of [".console-preview-toolbar", ".console-preview-stage"]) {
    await checkLightSurface(workbench, selector);
  }
  await checkHover(workbench, "#console-zoom-in");
  if (process.env.CAPTURE_LIGHT_THEME === "1") {
    await panel.setViewportSize({ width: 360, height: 720 });
    await panel.locator(".copy-task-info").hover();
    await panel.screenshot({ path: path.join(process.env.TEMP, "opencode", "light-theme-panel.png") });
  }
});

test("copy-to-AI reads committed steps, reports read failures and stays busy across UI refreshes", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  const oldStep = { id: "copy-old", timestamp: 1, type: "click", pageName: "page1",
    target: { tagName: "button", accessibleName: "Original action" } };
  const newStep = { ...oldStep, id: "copy-new", target: { tagName: "button", accessibleName: "Latest committed action" } };
  await writeActions(worker, [oldStep]);
  const panel = await context.newPage();
  await panel.addInitScript(() => {
    window.clipboardWrites = [];
    Object.defineProperty(navigator, "clipboard", { value: {
      writeText: async text => {
        clipboardWrites.push(text);
        if (window.blockClipboard) await new Promise(resolve => { window.finishClipboard = resolve; });
      }
    } });
    // Delay only step notifications to reproduce a real lagging render cache.
    const addListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
    chrome.storage.onChanged.addListener = listener => addListener((changes, area) => {
      if (window.holdStepUpdates && (changes.actionOrder || Object.keys(changes).some(key => key.startsWith("action:")))) return;
      listener(changes, area);
    });
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.action === "getActions" && window.failCopyReads) {
        args.at(-1)({ success: false, error: "Injected read failure" });
        return;
      }
      return send(message, ...args);
    };
  });
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 1);
  await panel.evaluate(() => { window.holdStepUpdates = true; });
  await writeActions(worker, [oldStep, newStep]);
  assert.equal(await panel.locator(".step-card").count(), 1);
  await panel.locator("#copy-task-btn").click();
  await panel.waitForFunction(() => clipboardWrites.length === 1);
  const copied = await panel.evaluate(() => clipboardWrites[0]);
  assert.match(copied, /Steps: 2/);
  assert.match(copied, /Latest committed action/);

  await panel.evaluate(() => { window.blockClipboard = true; });
  await panel.locator("#copy-task-btn").click();
  await panel.waitForFunction(() => window.finishClipboard);
  await panel.evaluate(() => { window.holdStepUpdates = false; });
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: true }));
  await panel.waitForFunction(() => document.querySelector("#record-btn").classList.contains("recording-state"));
  assert.equal(await panel.locator("#copy-task-btn").isDisabled(), true);
  await panel.locator("#copy-task-btn").dispatchEvent("click");
  assert.equal(await panel.evaluate(() => clipboardWrites.length), 2, "refresh cannot allow duplicate clipboard writes");
  await panel.evaluate(() => { window.blockClipboard = false; finishClipboard(); });
  await panel.waitForFunction(() => !document.querySelector("#copy-task-btn").disabled);

  await panel.evaluate(() => { window.failCopyReads = true; });
  await panel.locator("#copy-task-btn").click();
  await panel.locator(".recorder-toast.danger").filter({ hasText: "Injected read failure" }).waitFor();
  assert.equal(await panel.evaluate(() => clipboardWrites.length), 2, "read failure must not copy cached steps");
  await panel.evaluate(() => { window.failCopyReads = false; window.holdStepUpdates = true; });
  await writeActions(worker, []);
  await panel.locator("#copy-task-btn").click();
  await panel.locator(".recorder-toast.danger").filter({ hasText: "暂无录制步骤" }).waitFor();
  assert.equal(await panel.evaluate(() => clipboardWrites.length), 2, "an emptied workspace must not copy cached steps");
});

test("side-panel screenshot defaults collapse long recordings while keeping images and export intact", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  const panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await panel.setViewportSize({ width: 360, height: 720 });
  const panelUrl = `chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`;
  await panel.goto(panelUrl);
  await panel.evaluate(() => chrome.runtime.sendMessage({ action: "getSchemaState" }));
  await panel.locator("#capture-settings-btn").click();
  const expandedDefault = panel.locator("#sidebar-screenshots-expanded");
  assert.equal(await expandedDefault.isChecked(), true, "existing users keep the expanded default");
  assert.equal(await panel.locator("#capture-screenshots-enabled").isChecked(), true);
  await expandedDefault.uncheck();
  await panel.locator(".capture-settings-dialog .confirm-submit").click();
  await panel.locator(".capture-settings-dialog").waitFor({ state: "detached" });
  const preferences = await worker.evaluate(() => chrome.storage.local.get(["captureSettings", "stepDisplaySettings"]));
  assert.deepEqual(preferences.captureSettings, { screenshots: true });
  assert.deepEqual(preferences.stepDisplaySettings, { screenshotsExpanded: false });
  await panel.evaluate(() => {
    window.thumbnailRequests = 0;
    const getThumbnail = RecorderScreenshotMedia.getThumbnail;
    RecorderScreenshotMedia.getThumbnail = (...args) => { thumbnailRequests++; return getThumbnail(...args); };
  });

  const actions = Array.from({ length: 50 }, (_, index) => ({
    id: `fold-${index}`, timestamp: index + 1, type: "click", pageName: `page${index % 4 + 1}`,
    target: { tagName: "button", accessibleName: `Recorded action ${index + 1}` },
    screenshotBeforeKey: "fold-before", screenshotKey: "fold-after", screenshotStatus: "captured"
  }));
  await worker.evaluate(list => RecorderMediaStore.withWriteLock(async () => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    for (const key of ["fold-before", "fold-after"]) await RecorderMediaStore.putBlob(key, new Blob([bytes], { type: "image/png" }));
    const writes = { actionOrder: list.map(action => action.id) };
    for (const action of list) writes[`action:${action.id}`] = action;
    await chrome.storage.local.set(writes);
  }), actions);
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 50);
  assert.equal(await panel.locator(".step-media-row:visible").count(), 0);
  assert.equal(await panel.locator("img.step-screenshot").count(), 0, "collapsed cards do not load thumbnails");
  assert.equal(await panel.evaluate(() => thumbnailRequests), 0);
  assert.equal(await panel.locator(".step-screenshots-toggle:visible").count(), 50);
  const first = panel.locator(".step-card").first();
  await first.locator(".step-screenshots-toggle").click();
  await first.locator("img.step-screenshot").first().waitFor();
  assert.equal(await first.locator(".step-screenshots-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(await first.locator(".step-media-row:visible").count(), 1);
  assert.equal(await panel.locator(".step-media-row:visible").count(), 1);
  const appended = { ...actions[0], id: "fold-appended" };
  await writeActions(worker, [...await readActions(worker), appended]);
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 51);
  assert.equal(await panel.locator(".step-card").last().locator(".step-screenshots-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(await first.locator(".step-screenshots-toggle").getAttribute("aria-expanded"), "true");
  await writeActions(worker, (await readActions(worker)).filter(action => action.id !== "fold-appended"));
  await worker.evaluate(() => chrome.storage.local.set({ "action:fold-0": {
    id: "fold-0", timestamp: 1, type: "click", pageName: "page1",
    target: { tagName: "button", accessibleName: "Updated first action" },
    screenshotBeforeKey: "fold-before", screenshotKey: "fold-after", screenshotStatus: "captured"
  } }));
  await first.locator(".step-description").filter({ hasText: "Updated first action" }).waitFor();
  assert.equal(await first.locator(".step-screenshots-toggle").getAttribute("aria-expanded"), "true");
  await first.locator(".step-media").first().click();
  await panel.locator(".image-preview-close").waitFor();
  await panel.locator(".image-preview-close").click();
  await first.locator(".step-screenshots-toggle").click();
  assert.equal(await first.locator("img.step-screenshot").count(), 0);
  await panel.reload();
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 50);
  assert.equal(await panel.locator(".step-media-row:visible").count(), 0, "the default persists after reload");
  if (process.env.SCREENSHOT_FOLD_PREVIEW_DIR) {
    fs.mkdirSync(process.env.SCREENSHOT_FOLD_PREVIEW_DIR, { recursive: true });
    await panel.screenshot({ path: path.join(process.env.SCREENSHOT_FOLD_PREVIEW_DIR, "collapsed-steps.png") });
  }

  const saved = await panel.evaluate(() => chrome.runtime.sendMessage({ action: "saveCase", name: "Folded workflow" }));
  assert.equal(saved.success, true);
  const details = await panel.evaluate(id => chrome.runtime.sendMessage({ action: "getCaseDetails", caseId: id }), saved.case.id);
  assert.equal(details.case.actions.length, 50);
  assert.equal(details.case.actions[0].screenshotBeforeKey, "fold-before");
  const pendingDownload = panel.waitForEvent("download");
  await panel.evaluate(list => RecorderExport.exportWorkflow(list, "folded-export"), details.case.actions.slice(0, 1));
  const download = await pendingDownload;
  const chunks = [];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
  assert.ok(files["folded-export/screenshots/step-001-click-before.jpg"]);
  assert.ok(files["folded-export/screenshots/step-001-click-after.jpg"]);

  const preview = await context.newPage();
  await preview.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/console.html?caseId=${saved.case.id}`);
  await preview.locator("#preview-steps-container .step-card").first().waitFor();
  await preview.locator("#preview-steps-container img.step-screenshot").first().waitFor();
  assert.equal(await preview.locator(".step-screenshots-toggle:visible").count(), 0, "the preference only changes the side panel");

  await panel.locator("#capture-settings-btn").click();
  if (process.env.SCREENSHOT_FOLD_PREVIEW_DIR) {
    await panel.screenshot({ path: path.join(process.env.SCREENSHOT_FOLD_PREVIEW_DIR, "screenshot-settings.png") });
  }
  await panel.locator("#sidebar-screenshots-expanded").check();
  await panel.locator(".capture-settings-dialog .confirm-submit").click();
  await panel.waitForFunction(() => document.querySelectorAll(".step-media-row[hidden]").length === 0);
  await panel.locator(".step-card img.step-screenshot").first().waitFor();
  assert.deepEqual(errors, []);
});

test("copy-to-AI tooltip stays fully visible above the step list", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    reducedMotion: "reduce",
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  await writeActions(worker, Array.from({ length: 8 }, (_, index) => ({
    id: `tooltip-step-${index}`, timestamp: index, type: "click", pageName: "page1",
    target: { tagName: "button", accessibleName: `Recorded action ${index}` }
  })));
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length === 8);

  for (const language of ["zh_CN", "en"]) {
    await panel.evaluate(language => globalThis.RecorderI18n.setLanguage(language), language);
    for (const width of [1000, 600, 360, 300]) {
      await panel.setViewportSize({ width, height: 500 });
      for (const interaction of ["hover", "focus"]) {
        await panel.mouse.move(0, 0);
        await panel.locator("#record-btn").focus();
        const trigger = panel.locator(".copy-task-info");
        if (interaction === "hover") await trigger.hover();
        else await trigger.focus();
        const tooltip = panel.locator("#copy-task-tooltip");
        await tooltip.waitFor({ state: "visible" });
        assert.doesNotMatch(await tooltip.innerText(), /test-base|\bskills?\b/i);
        const visibility = await tooltip.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          const lines = [...range.getClientRects()];
          // Enable hit testing only for the measurement: z-index alone cannot
          // prove that a transformed ancestor is above the later step cards.
          const previous = element.style.pointerEvents;
          element.style.pointerEvents = "auto";
          const coveredBy = lines.map(line => document.elementFromPoint(
            line.left + line.width / 2, line.top + line.height / 2
          )).filter(hit => hit !== element && !element.contains(hit))
            .map(hit => hit?.className || "outside viewport");
          element.style.pointerEvents = previous;
          return {
            insideViewport: rect.left >= 0 && rect.right <= innerWidth &&
              rect.top >= 0 && rect.bottom <= innerHeight,
            coveredBy
          };
        });
        assert.deepEqual(visibility, { insideViewport: true, coveredBy: [] },
          `${language} tooltip at ${width}px with ${interaction}`);
      }
    }
  }
});

test("clearing steps leaves saved cases intact and waits for an explicit start", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const extensionId = worker.url().split("/")[2];
  await worker.evaluate(() => chrome.storage.local.set({
    uiLanguage: "zh_CN", recordingConsentVersion: 3, isRecording: false
  }));

  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/ui/popup.html`);
  const savedStep = {
    id: "saved-step", timestamp: Date.now(), type: "click", pageName: "page1",
    url: `${fixture.origin}/base`, title: "Base page",
    target: { tagName: "button", id: "effect-action", accessibleName: "Visible effect" }
  };
  await writeActions(worker, [savedStep]);
  await panel.locator("#save-current-case-btn").click();
  await panel.locator(".prompt-text-dialog input").fill("Saved recording");
  await panel.locator(".prompt-text-dialog .confirm-submit").click();
  await waitForCondition(async () => (await readCases(worker)).length === 1, "saved case");
  const savedCases = await readCases(worker);
  const baseline = await worker.evaluate(() => chrome.storage.local.get(["activeCaseId", "workspaceOrigin"]));
  assert.equal(baseline.activeCaseId, savedCases[0].id);
  assert.equal(baseline.workspaceOrigin.caseId, savedCases[0].id);
  const draft = [savedStep, { ...savedStep, id: "unsaved-step" }];
  await writeActions(worker, draft);
  await panel.waitForFunction(() =>
    document.querySelectorAll(".step-card").length === 2 &&
    document.querySelector("#record-btn-label")?.textContent.trim() === "继续录制"
  );
  assert.equal(await panel.locator("#restart-record-btn").count(), 0);

  for (const width of [1000, 360]) {
    await panel.setViewportSize({ width, height: 800 });
    assert.equal(await panel.evaluate(() => {
      const record = document.querySelector("#record-btn").getBoundingClientRect();
      const utilities = document.querySelector(".header-utilities").getBoundingClientRect();
      return record.width > 0 && record.left >= 0 && record.right <= utilities.left &&
        utilities.right <= innerWidth && Math.abs(record.top - utilities.top) < 5;
    }), true, `recording toolbar fits at ${width}px`);
  }

  await panel.locator("#clear-steps-btn").click();
  await panel.locator(".confirm-dialog").waitFor({ state: "visible" });
  assert.match(await panel.locator("#confirm-message").innerText(), /不会自动保存.*已保存用例不受影响.*不会开始录制/);
  await panel.locator(".confirm-cancel").click();
  await panel.locator(".confirm-dialog").waitFor({ state: "detached" });
  assert.deepEqual(await readActions(worker), draft);

  await panel.locator("#clear-steps-btn").click();
  await panel.locator(".confirm-submit").click();
  await panel.waitForFunction(() =>
    document.querySelectorAll(".step-card").length === 0 &&
    document.querySelector("#record-btn-label")?.textContent.trim() === "开始录制"
  );
  assert.deepEqual(await readActions(worker), []);
  assert.equal((await worker.evaluate(() => chrome.storage.local.get("isRecording"))).isRecording, false);
  assert.deepEqual(await readCases(worker), savedCases);
  assert.equal(await panel.locator("#clear-steps-btn").isDisabled(), true);

  // The panel is hosted in a tab for this test; keep the recordable page active
  // while invoking the real button handler, as it would be with a side panel.
  await page.bringToFront();
  await panel.evaluate(() => document.querySelector("#record-btn").click());
  const fresh = await waitForActions(worker, actions => actions.length === 1 && actions[0].type === "navigate");
  assert.equal(fresh[0].pageName, "page1");
  await panel.waitForFunction(() =>
    document.querySelector("#record-btn-label")?.textContent.trim() === "停止录制"
  );
  assert.equal(await panel.locator("#clear-steps-btn").isDisabled(), true);
  assert.deepEqual(await readCases(worker), savedCases);
  await panel.locator("#record-btn").click();
  await panel.waitForFunction(() =>
    document.querySelector("#record-btn-label")?.textContent.trim() === "继续录制"
  );
});

test("input recording ignores unchanged fields and editor fillers while preserving a real clear", async t => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ recordingConsentVersion: 3, captureSettings: { screenshots: false } }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  await page.evaluate(() => {
    const wrap = document.createElement("div");
    wrap.innerHTML = '<input id="filler-input"><input id="unchanged-input" value="existing">' +
      '<div id="filler-editor" contenteditable="true" role="textbox" aria-label="输入内容" style="min-height:30px;border:1px solid">\u200b</div>';
    wrap.querySelector("input").value = "\u200b";
    document.body.prepend(wrap);
  });
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  const controller = await context.newPage();
  await controller.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  const toggle = (start, recordingMode) => controller.evaluate(({ tabId, start, recordingMode }) =>
    chrome.runtime.sendMessage({ action: "toggleRecording", start, rootTabId: tabId, recordingMode }), { tabId, start, recordingMode });
  assert.equal((await toggle(true)).success, true);
  await waitForActions(worker, actions => actions.length === 1);
  await page.bringToFront();
  for (const selector of ["#filler-input", "#unchanged-input", "#filler-editor", "#query"]) {
    await page.locator(selector).click();
  }
  assert.equal((await toggle(false)).success, true);
  assert.equal((await readActions(worker)).length, 1, "click/blur of an unchanged field adds no typing step");
  assert.equal((await toggle(true, "continue")).success, true);
  await page.locator("#filler-editor").fill("visible content");
  await page.locator("#query").fill("separate step");
  await waitForActions(worker, actions => actions.some(action => action.value === "visible content") &&
    actions.some(action => action.value === "separate step"));
  await page.locator("#filler-editor").fill("\u200b");
  assert.equal((await toggle(false)).success, true);
  const actions = await readActions(worker);
  assert.ok(actions.some(action => action.type === "type" && action.target?.id === "filler-editor" && action.value === ""),
    "clearing a populated editor back to its filler is still recorded");
  assert.equal(actions.some(action => action.type === "type" && action.value === "\u200b"), false);
});

test("stopping releases the debugger before slow saves and preserves final iframe input", async t => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: "zh_CN", recordingConsentVersion: 3 }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  const panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await panel.setViewportSize({ width: 300, height: 720 });
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await panel.locator("#capture-settings-btn").click();
  assert.equal(await panel.locator(".capture-settings-dialog").isVisible(), true);
  assert.equal(await panel.locator(".recording-debug-tools, #export-recording-debug, #clear-recording-debug").count(), 0);
  await panel.locator(".capture-settings-dialog .confirm-cancel").click();
  await panel.evaluate(tabId => chrome.runtime.sendMessage({ action: "toggleRecording", start: true, rootTabId: tabId }), tabId);
  await waitForActions(worker, actions => actions.some(action => action.screenshotKey));
  await panel.waitForFunction(() => document.querySelector("#record-btn").getAttribute("aria-label") === "停止录制");
  await worker.evaluate(() => {
    const putBlob = RecorderMediaStore.putBlob.bind(RecorderMediaStore);
    const gate = new Promise(resolve => { globalThis.releaseStopSaves = resolve; });
    globalThis.heldStopSaves = 0;
    RecorderMediaStore.putBlob = async (key, blob) => {
      const id = key.split(":")[1];
      const action = (await chrome.storage.local.get(`action:${id}`))[`action:${id}`];
      if (action && key !== action.screenshotBeforeKey) {
        globalThis.heldStopSaves++;
        await gate;
      }
      return putBlob(key, blob);
    };
  });
  await page.bringToFront();
  await page.locator("#query").fill("final top input");
  await page.frameLocator("#cke-editor-frame").locator("body").fill("final iframe input");
  await panel.locator("#record-btn").click();
  await panel.waitForFunction(() => document.querySelector("#record-btn").title === "正在停止…");
  assert.equal(await panel.locator("#record-btn").isDisabled(), true);
  assert.equal(await panel.locator("#manual-screenshot-btn").isHidden(), true);
  assert.ok(await panel.locator("#record-btn-label").isVisible());
  assert.ok(await panel.locator(".header-utilities").evaluate(element => element.getBoundingClientRect().right <= innerWidth));
  try {
    await waitForCondition(() => worker.evaluate(tabId => chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" })
      .then(() => false, () => true), tabId), "debugger release before the blocked saves finish");
    await waitForCondition(() => worker.evaluate(() => globalThis.heldStopSaves > 0), "media saves to remain blocked after detach");
    const pending = await readActions(worker);
    assert.ok(pending.some(action => action.value === "final top input"));
    assert.ok(pending.some(action => action.value === "final iframe input"));
    assert.equal(await panel.locator("#record-btn").isDisabled(), true);
    // Reload/activation during local persistence must not reattach the debugger.
    await page.bringToFront();
    await page.reload();
    assert.equal(await worker.evaluate(tabId => chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" })
      .then(() => true, () => false), tabId), false);
  } finally {
    await worker.evaluate(() => globalThis.releaseStopSaves());
  }
  await panel.waitForFunction(() => !document.querySelector("#record-btn").disabled &&
    document.querySelector("#record-btn").getAttribute("aria-label") === "继续录制");
  const saved = await readActions(worker);
  for (const value of ["final top input", "final iframe input"]) {
    assert.equal(saved.find(action => action.value === value).screenshotStatus, "captured");
  }
  assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get("recordingDebugTimeline")).recordingDebugTimeline), undefined);
  await panel.locator("#record-btn").click();
  await panel.waitForFunction(() => !document.querySelector("#record-btn").disabled && document.querySelector("#record-btn").title === "停止录制");
  await page.bringToFront();
  await page.locator("#query").fill("continued after stop");
  await page.locator("#effect-action").click();
  await waitForActions(worker, actions => actions.some(action => action.value === "continued after stop"));
  await panel.locator("#record-btn").click();
  await panel.waitForFunction(() => document.querySelector("#record-btn").title === "继续录制");
  assert.deepEqual(errors, []);
});

test("screenshot queues let a ready child finish while its parent is still loading", async t => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ uiLanguage: "zh_CN", recordingConsentVersion: 3 }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  const rootTabId = await worker.evaluate(async url =>
    (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, page.url());
  const controller = await context.newPage();
  await controller.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  assert.equal((await controller.evaluate(rootTabId => chrome.runtime.sendMessage({
    action: "toggleRecording", start: true, rootTabId
  }), rootTabId)).success, true);
  await controller.close();
  await waitForActions(worker, actions => actions.some(action => action.screenshotKey));
  const childPromise = context.waitForEvent("page");
  await page.locator("#open-child").click();
  const child = await childPromise;
  await child.waitForLoadState("domcontentloaded");
  try {
    await waitForRecorder(worker, child.url());
  } catch (error) {
    t.diagnostic(JSON.stringify(await worker.evaluate(async () => ({
      tabs: (await chrome.tabs.query({})).map(({ id, openerTabId, url }) => ({ id, openerTabId, url })),
      state: await chrome.storage.local.get(["isRecording", "recordingTabIds", "tabsMapping", "recordingDebugTimeline"])
    }))));
    throw error;
  }
  await child.locator("#child-action").click();
  await waitForActions(worker, actions => actions.some(action => action.target?.id === "child-action" && action.screenshotKey));
  await waitForCondition(async () => !(await worker.evaluate(async () =>
    (await chrome.storage.local.get("screenshotCaptureState")).screenshotCaptureState?.pendingCount)), "initial captures to drain");

  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "hold-loading";
    button.textContent = "Load parent result";
    button.onclick = () => {
      document.body.setAttribute("aria-busy", "true");
      document.body.style.backgroundColor = "rgb(255, 0, 0)";
    };
    document.body.prepend(button);
  });
  await page.bringToFront();
  await page.locator("#hold-loading").click();
  await waitForActions(worker, actions => actions.some(action => action.target?.id === "hold-loading" && action.screenshotStatus === "pending"));
  await child.bringToFront();
  await child.locator("#child-resume-action").click();
  const concurrent = await waitForActions(worker, actions => actions.some(action =>
    action.target?.id === "child-resume-action" && action.screenshotKey));
  assert.equal(await page.locator("body").getAttribute("aria-busy"), "true");
  assert.equal(concurrent.find(action => action.target?.id === "hold-loading").screenshotStatus, "pending",
    "the child capture must finish before the loading parent capture");

  await page.evaluate(() => {
    document.body.removeAttribute("aria-busy");
    document.body.style.backgroundColor = "rgb(0, 255, 0)";
  });
  const completed = await waitForActions(worker, actions => actions.some(action => action.target?.id === "hold-loading" && action.screenshotKey));
  const parent = completed.find(action => action.target?.id === "hold-loading");
  assert.equal(parent.screenshotCapturedTabId, rootTabId);
  const pixel = await worker.evaluate(async key => {
    const bitmap = await createImageBitmap(await RecorderMediaStore.getBlob(key));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    return [...ctx.getImageData(20, 500, 1, 1).data];
  }, parent.screenshotKey);
  assert.ok(pixel[1] > 200 && pixel[0] < 50 && pixel[2] < 50,
    `parent screenshot must show the green loaded result: ${pixel}`);
  const stopController = await context.newPage();
  await stopController.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  const stopped = await stopController.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));
  assert.equal(stopped.success, true);
  const capture = await worker.evaluate(async () => (await chrome.storage.local.get("screenshotCaptureState")).screenshotCaptureState);
  assert.equal(capture.pendingCount, 0);
  assert.equal(capture.busy, false);
});

test("records only the session-opening page navigation", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());

  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    // Larger than the recorder's former 1440x900 ceiling so the lifecycle test
    // proves that screencast frames are no longer silently downscaled.
    viewport: { width: 1920, height: 1080 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  t.after(() => context.close());

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker");
  const extensionId = serviceWorker.url().split("/")[2];

  // Pin the UI language. Without this the extension falls back to the host
  // machine's Chrome UI language, so the Chinese assertions below would only
  // hold on a zh-CN workstation and would fail on an en-US CI runner.
  // Recording consent is granted up front too; the dialog that gates the first
  // start has its own focused coverage further down.
  await serviceWorker.evaluate(() => chrome.storage.local.set({
    uiLanguage: "zh_CN",
    recordingConsentVersion: 3
  }));

  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);

  const rootTabId = await serviceWorker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === url)?.id;
  }, `${fixture.origin}/base`);
  assert.ok(Number.isInteger(rootTabId));

  const controller = await context.newPage();
  await controller.goto(`chrome-extension://${extensionId}/ui/popup.html`, { waitUntil: "domcontentloaded" });
  const rootWindowId = await serviceWorker.evaluate(async (tabId) => (await chrome.tabs.get(tabId)).windowId, rootTabId);
  const recorderBeforeInvocation = await serviceWorker.evaluate(async (tabId) => {
    try {
      await chrome.tabs.sendMessage(tabId, { action: "pingRecorder" });
      return true;
    } catch (error) {
      return false;
    }
  }, rootTabId);
  assert.equal(recorderBeforeInvocation, false);
  const layoutResponse = await controller.evaluate(({ tabId, windowId }) => chrome.runtime.sendMessage({
    action: "setSidePanelLayout",
    open: true,
    tabId,
    windowId
  }), { tabId: rootTabId, windowId: rootWindowId });
  assert.equal(layoutResponse.success, true);
  const recorderAfterInvocation = await serviceWorker.evaluate(
    tabId => chrome.tabs.sendMessage(tabId, { action: "pingRecorder" }).then(response => response?.status),
    rootTabId
  );
  assert.equal(recorderAfterInvocation, undefined, "layout alone does not load recording listeners");
  await page.waitForFunction(() => document.querySelector("#wide-layout").getBoundingClientRect().width <= window.innerWidth + 1);
  assert.ok(await page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).zoom) < 1));

  const restoreResponse = await controller.evaluate(({ tabId, windowId }) => chrome.runtime.sendMessage({
    action: "setSidePanelLayout",
    open: false,
    tabId,
    windowId
  }), { tabId: rootTabId, windowId: rootWindowId });
  assert.equal(restoreResponse.success, true);
  await page.waitForFunction(() => document.querySelector("#wide-layout").getBoundingClientRect().width === 2400);

  const startResponse = await controller.evaluate((targetTabId) => chrome.runtime.sendMessage({
    action: "toggleRecording",
    start: true,
    rootTabId: targetTabId
  }), rootTabId);
  assert.equal(startResponse.success, true);
  await controller.close();

  let actions = await waitForActions(
    serviceWorker,
    current => current.length === 1 && current[0].type === "navigate"
  );
  assert.equal(actions[0].pageName, "page1");

  // Manual screenshots are controlled from the side panel, not the recorded page.
  assert.equal(await page.locator("#playwright-recorder-overlay").count(), 0);
  const firstCaptured = await waitForActions(
    serviceWorker,
    current => current.length === 1 && current[0].screenshotKey
  );
  assert.equal(await page.locator("#playwright-recorder-overlay").count(), 0);

  // Every blob gets its own key. The old `screenshot:<actionId>` was overwritten
  // in place, so re-capturing a step loaded from a saved case rewrote that case's
  // screenshot.
  assert.match(firstCaptured[0].screenshotKey, /^screenshot:[^:]+:[a-z0-9]+$/);
  assert.equal(firstCaptured[0].screenshotStatus, "captured");

  // Stability is available after recording starts. Trigger fixture setup through
  // its page handler without adding a user step, after the opening capture drains.
  await page.evaluate(() => document.querySelector("#open-async-dialog").click());
  await page.locator('[role="progressbar"]').waitFor({ state: "visible" });
  const stability = await serviceWorker.evaluate((tabId) => chrome.tabs.sendMessage(
    tabId,
    { action: "waitForPageStable", options: { timeoutMs: 2500, quietMs: 300 } },
    { frameId: 0 }
  ), rootTabId);
  assert.equal(stability.stable, true);
  assert.ok(Date.now() - stability.lastChangeAt >= 300, JSON.stringify(stability));
  assert.equal(await page.locator("#async-result").innerText(), "Loaded result");

  // Reloads and redirects are browser/application effects, not user steps.
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(await page.locator("#playwright-recorder-overlay").count(), 0);
  const afterReload = await readActions(serviceWorker);
  assert.equal(
    afterReload.filter(action => action.type === "navigate" || action.type === "newPage").length,
    1,
    JSON.stringify(afterReload.map(action => ({ type: action.type, pageName: action.pageName, url: action.url })))
  );

  const queryInput = page.locator("#query");
  await queryInput.click();
  await queryInput.pressSequentially("hello", { delay: 20 });
  actions = await waitForActions(
    serviceWorker,
    current => current.length === 2 && current[1].type === "type" && current[1].screenshotKey
  );
  assert.equal(actions[1].value, "hello");
  assert.equal(actions.filter(action => action.type === "type").length, 1);
  assert.equal(actions[1].target.boundingBox.coordinateSpace, "top-viewport");
  assert.equal(actions[1].target.boundingBox.viewportWidth, 1920);
  assert.ok(
    await countRedPixels(serviceWorker, actions[1].screenshotBeforeKey) === 0,
    "the original before screenshot should not bake in a target frame"
  );
  assert.deepEqual(actions[1].screenshotBeforeHighlight, actions[1].target.boundingBox);

  await page.locator("#noop-action").click();
  await new Promise(resolve => setTimeout(resolve, 1400));
  assert.equal((await readActions(serviceWorker)).length, 2);

  // A value the user never entered must not become a step. Marking a field as
  // touched on a trusted input event is what lets browser autofill be recorded,
  // and these are the two cases that must stay excluded by it: a page script
  // assigning .value fires no event at all, and framework synthetic events are
  // untrusted. Recording either would flood a workflow with noise.
  await page.evaluate(() => {
    document.querySelector("#scripted-value").value = "written-by-script";
    const synthetic = document.querySelector("#synthetic-value");
    synthetic.value = "synthetic-value";
    synthetic.dispatchEvent(new Event("input", { bubbles: true }));
    synthetic.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const afterUnattendedFill = await readActions(serviceWorker);
  assert.equal(afterUnattendedFill.length, 2);
  assert.equal(
    afterUnattendedFill.some(action => /written-by-script|synthetic-value/.test(action.value || "")),
    false
  );

  // A page script may click a hidden/helper submit button while handling a real
  // login click. Synthetic clicks are not user actions and must not become a
  // second recorded button click.
  await page.evaluate(() => {
    document.querySelector("#scripted-click-target").click();
    document.querySelector("#scripted-click-target").dispatchEvent(new MouseEvent("click", {
      bubbles: true,
      cancelable: true
    }));
  });
  await new Promise(resolve => setTimeout(resolve, 1400));
  const afterSyntheticClicks = await readActions(serviceWorker);
  assert.equal(afterSyntheticClicks.length, 2);
  assert.equal(afterSyntheticClicks.some(action => action.target?.id === "scripted-click-target"), false);
  assert.equal(await page.locator("body").getAttribute("data-scripted-click-count"), "2");

  await page.locator("#effect-action").click();
  actions = await waitForActions(
    serviceWorker,
    current => current.length === 3 && current[2].type === "click"
  );
  assert.equal(await page.locator("body").getAttribute("data-effect-count"), "1");
  assert.equal(actions[2].pointer.coordinateSpace, "top-viewport");
  assert.ok(actions[2].pointer.viewportX >= actions[2].target.boundingBox.x);
  assert.ok(actions[2].pointer.viewportX <= actions[2].target.boundingBox.x + actions[2].target.boundingBox.width);

  assert.equal(await page.locator("#playwright-recorder-overlay").count(), 0);
  actions = await waitForActions(
    serviceWorker,
    current => current.length === 3 && current[2].type === "click" && current[2].screenshotKey
  );
  assert.equal(actions[2].screenshotSource, "automatic");
  // One semantic step owns the frame from the moment of the action and the
  // settled result frame. The second image must not create a fourth step.
  assert.ok(actions[2].screenshotBeforeKey);
  assert.equal(actions.length, 3);

  await page.locator("#drag-source").hover({ position: { x: 20, y: 20 } });
  await page.mouse.down();
  await page.locator("#drop-target").hover({ position: { x: 40, y: 30 } });
  await page.mouse.up();
  actions = await waitForActions(
    serviceWorker,
    current => current.length === 4 && current[3].type === "drag"
  );
  assert.equal(actions[3].source.id, "drag-source");
  assert.equal(actions[3].target.id, "drop-target");
  assert.ok(actions[3].path.length >= 2);
  assert.equal(actions.some(action => action.type === "click" && action.target?.id === "drag-source"), false);

  const designerFrame = page.frameLocator("#formdesign-frame");
  await designerFrame.locator("#frame-drag-source span").hover();
  await page.mouse.down();
  await designerFrame.locator("#frame-drop-target").hover({ position: { x: 40, y: 30 } });
  await page.mouse.up();
  actions = await waitForActions(
    serviceWorker,
    current => current.length === 5 && current[4].type === "drag"
  );
  assert.equal(actions[4].source.id, "frame-drag-source");
  assert.equal(actions[4].target.id, "frame-drop-target");
  assert.equal(actions[4].source.frameInfo.frameName, "formdesign-frame");
  assert.equal(actions[4].source.frameInfo.frameId, "formdesign-frame");
  assert.equal(actions[4].source.boundingBox.coordinateSpace, "top-viewport");
  assert.ok(actions[4].source.boundingBox.x > 10, "iframe-local coordinates should include the iframe offset");

  const editorFrame = page.frameLocator("#cke-editor-frame");
  await editorFrame.locator("body").fill("123123123123");
  actions = await waitForActions(
    serviceWorker,
    current => current.length === 6 && current[5].type === "type"
  );
  assert.equal(actions[5].value, "123123123123");
  assert.equal(actions[5].target.tagName, "body");
  assert.equal(actions[5].target.frameInfo.frameId, "cke-editor-frame");

  const unrelatedPromise = context.waitForEvent("page");
  await serviceWorker.evaluate((url) => chrome.tabs.create({ url, active: true }), `${fixture.origin}/unrelated`);
  const unrelated = await unrelatedPromise;
  await unrelated.waitForLoadState("domcontentloaded");
  await unrelated.locator("#unrelated-action").click();
  await new Promise(resolve => setTimeout(resolve, 300));
  const scopeState = await serviceWorker.evaluate(async () => chrome.storage.local.get("recordingTabIds"));
  assert.deepEqual(scopeState.recordingTabIds, [rootTabId]);
  assert.equal((await readActions(serviceWorker)).length, 6);
  await unrelated.close();

  const childPromise = context.waitForEvent("page");
  await page.locator("#open-child").click();
  const child = await childPromise;
  await child.waitForLoadState("domcontentloaded");
  await waitForRecorder(serviceWorker, child.url());
  assert.equal(await child.locator("#playwright-recorder-overlay").count(), 0);
  await child.locator("#child-action").click();

  actions = await waitForActions(
    serviceWorker,
    current => current.length === 8 &&
      current.some(action => action.type === "click" && action.pageName === "page2")
  );

  assert.deepEqual(
    actions.map(action => [action.type, action.pageName]),
    [
      ["navigate", "page1"],
      ["type", "page1"],
      ["click", "page1"],
      ["drag", "page1"],
      ["drag", "page1"],
      ["type", "page1"],
      ["click", "page1"],
      ["click", "page2"]
    ]
  );

  // A login click is the user action. The resulting document navigation is not
  // another step, even though the content script is re-injected in that document.
  await child.locator("#login-submit").click();
  await child.waitForURL(`${fixture.origin}/logged-in`);
  actions = await waitForActions(
    serviceWorker,
    current => current.length === 9 && current[8].type === "click" && current[8].target?.id === "login-submit"
  );
  assert.equal(actions[8].pageName, "page2");

  await child.reload({ waitUntil: "domcontentloaded" });
  await new Promise(resolve => setTimeout(resolve, 300));
  actions = await readActions(serviceWorker);
  assert.equal(actions.length, 9);
  const screenshotAction = actions.find(action => action.screenshotKey);
  const screenshotSize = await serviceWorker.evaluate(async (key) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("PlaywrightRecorderDB");
      request.onsuccess = event => resolve(event.target.result);
      request.onerror = event => reject(event.target.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("blobs", "readonly").objectStore("blobs").get(key);
        request.onsuccess = event => resolve(event.target.result?.size || 0);
        request.onerror = event => reject(event.target.error);
      });
    } finally {
      db.close();
    }
  }, screenshotAction.screenshotKey);
  assert.ok(screenshotSize > 0);

  const childLifecycle = actions.filter(action =>
    action.pageName === "page2" && (action.type === "newPage" || action.type === "navigate")
  );
  assert.deepEqual(childLifecycle, []);

  await serviceWorker.evaluate(() => chrome.storage.local.set({
    isRecording: false,
    recordingTabIds: []
  }));

  // Side-panel smoke test at a narrow Chrome panel width.
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 340, height: 720 });
  await popup.goto(`chrome-extension://${extensionId}/ui/popup.html`, { waitUntil: "domcontentloaded" });
  assert.equal(await popup.title(), "流程录制 - 侧边栏");
  assert.equal(await popup.locator(".logo-area").count(), 0);
  assert.equal(await popup.locator("#record-btn").isVisible(), true);
  await popup.waitForFunction(() => document.getElementById("record-btn").dataset.recordingMode === "continue");
  assert.equal((await popup.locator("#record-btn-label").innerText()).trim(), "继续录制");
  assert.equal(await popup.locator("#manual-screenshot-btn").isHidden(), true);
  assert.equal(await popup.locator("#history-btn").count(), 0);
  assert.equal(await popup.locator("#recording-counts").count(), 0);
  assert.equal(await popup.locator("#recording-summary-status").count(), 0);
  assert.equal(await popup.locator(".app-footer").count(), 0);
  assert.equal(await popup.locator(".case-actionbar").isVisible(), true);
  assert.equal(await popup.locator("#save-current-case-btn").isVisible(), true);
  assert.equal(await popup.locator("#download-doc-compact-btn").isVisible(), true);
  assert.ok(await popup.locator(".case-actionbar").evaluate(element =>
    element.getBoundingClientRect().top < document.querySelector(".steps-section-head").getBoundingClientRect().top
  ));
  const manifestState = await serviceWorker.evaluate(() => chrome.runtime.getManifest());
  const manifestPermissions = manifestState.permissions;
  assert.ok(!manifestPermissions.includes("desktopCapture"));
  assert.ok(!manifestPermissions.includes("offscreen"));
  assert.ok(manifestPermissions.includes("sidePanel"));
  assert.equal(manifestState.side_panel.default_path, "ui/popup.html");
  assert.equal(manifestState.action.default_popup, undefined);
  const panelBehavior = await serviceWorker.evaluate(() => chrome.sidePanel.getPanelBehavior());
  assert.equal(panelBehavior.openPanelOnActionClick, false);
  const unrelatedPanelOptions = await serviceWorker.evaluate(async (tabId) => {
    await chrome.sidePanel.setOptions({ tabId, path: "ui/popup.html", enabled: true });
    return chrome.sidePanel.getOptions({ tabId });
  }, rootTabId);
  assert.equal(unrelatedPanelOptions.enabled, true);
  const defaultPanelOptions = await serviceWorker.evaluate(() => chrome.sidePanel.getOptions({}));
  assert.equal(defaultPanelOptions.enabled, false);
  assert.equal(await popup.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  const languageButton = popup.locator("#language-btn");
  assert.equal((await languageButton.innerText()).trim(), "EN");
  await languageButton.click();
  await popup.waitForFunction(() => document.documentElement.lang === "en");
  assert.equal((await popup.locator("#language-btn").innerText()).trim(), "中");
  assert.equal((await popup.locator("#save-current-case-btn").innerText()).trim(), "Save case");
  const languagePreference = await serviceWorker.evaluate(async () => chrome.storage.local.get("uiLanguage"));
  assert.equal(languagePreference.uiLanguage, "en");
  await popup.locator("#language-btn").click();
  await popup.waitForFunction(() => document.documentElement.lang === "zh-CN");
  assert.equal((await popup.locator("#language-btn").innerText()).trim(), "EN");
  assert.equal((await popup.locator("#save-current-case-btn").innerText()).trim(), "保存用例");
  assert.equal(await popup.locator("#settings-btn").count(), 0);
  assert.equal(await popup.locator("#capture-mode-select").count(), 0);
  assert.equal(await popup.locator("#quality-select").count(), 0);

  const firstStep = popup.locator(".step-card").first();
  assert.match(await firstStep.locator(".step-type-badge").innerText(), /打开页面|点击|输入/);
  assert.equal(await firstStep.locator(".step-technical").count(), 0);
  // Cards report the capture state, not just whether an image showed up. The
  // recording has stopped by now, so every step has reached a terminal state.
  assert.match(
    (await firstStep.locator(".step-status-tag").innerText()).trim(),
    /已截图|无需截图|截图不可用/
  );
  // Steps read as one connected flow. Asserted on the connector's computed height
  // because the alternative -- eyeballing a screenshot -- catches nothing when the
  // rule is dropped by a stylesheet edit.
  assert.ok(await popup.locator(".step-card").count() > 1);
  assert.equal(
    await firstStep.evaluate(card => getComputedStyle(card, "::after").height),
    "8px"
  );
  assert.equal(
    await popup.locator(".step-card").last().evaluate(card => getComputedStyle(card, "::after").content),
    "none",
    "the last step must not trail a connector into nothing"
  );
  const stepCountBeforeDelete = await popup.locator(".step-card").count();
  await firstStep.locator(".step-delete-btn").click();
  await popup.locator(".confirm-dialog").waitFor({ state: "visible" });
  assert.equal((await popup.locator("#confirm-title").innerText()).trim(), "删除步骤");
  await popup.locator(".confirm-cancel").click();
  await popup.locator(".confirm-dialog").waitFor({ state: "detached" });
  assert.equal(await popup.locator(".step-card").count(), stepCountBeforeDelete);
  assert.equal(await popup.locator("#clear-steps-btn").count(), 1);
  const screenshotPreview = popup.locator(".step-media:not(.is-loading)").first();
  await screenshotPreview.locator(".step-screenshot").waitFor({ state: "visible" });
  assert.equal((await screenshotPreview.innerText()).trim(), "");
  if (process.env.CAPTURE_SIDE_PANEL === "1") {
    const outputDir = path.resolve(__dirname, "..", "test-results");
    fs.mkdirSync(outputDir, { recursive: true });
    await popup.screenshot({ path: path.join(outputDir, "side-panel-340.png") });
  }
  const pageCountBeforePreview = context.pages().length;
  await screenshotPreview.click();
  assert.equal(context.pages().length, pageCountBeforePreview);
  const imagePreview = popup.locator(".image-preview-overlay");
  await imagePreview.waitFor({ state: "visible" });
  await imagePreview.locator(".image-preview-full").waitFor({ state: "visible" });
  assert.ok(await imagePreview.locator(".image-preview-full").evaluate(image => image.complete && image.naturalWidth > 0));
  assert.match(
    (await imagePreview.locator(".image-preview-title").innerText()).trim(),
    /^步骤 1 · 打开页面：Base page · 操作后$/
  );
  assert.ok(
    await imagePreview.locator(".image-preview-full").evaluate(image => image.naturalWidth > 1440),
    "the screenshot should retain the viewport's native width instead of the former 1440px cap"
  );

  assert.equal(await imagePreview.locator('[data-action="fit"]').count(), 0);
  assert.equal(await imagePreview.locator('[data-action="previous"]').isDisabled(), true);
  assert.equal(await imagePreview.locator('[data-action="next"]').isDisabled(), false);
  assert.equal(await imagePreview.locator(".image-preview-title").getAttribute("title"),
    (await imagePreview.locator(".image-preview-title").innerText()).trim());
  const zoomBefore = await imagePreview.locator('[data-action="reset-zoom"]').innerText();
  await imagePreview.locator('[data-action="zoom-in"]').click();
  assert.notEqual(await imagePreview.locator('[data-action="reset-zoom"]').innerText(), zoomBefore);
  await imagePreview.locator('[data-action="zoom-out"]').click();
  await imagePreview.locator('[data-action="next"]').click();
  await popup.waitForFunction(() => document.querySelector(".image-preview-title")?.textContent.includes("步骤 2"));
  await popup.keyboard.press("ArrowLeft");
  await popup.waitForFunction(() => document.querySelector(".image-preview-title")?.textContent.includes("步骤 1"));
  await popup.keyboard.press("Escape");
  await imagePreview.waitFor({ state: "detached" });

  const exportButton = popup.locator("#download-doc-compact-btn");
  assert.equal(await exportButton.getAttribute("aria-label"), "下载录制结果");
  await popup.waitForFunction(() => !document.querySelector("#download-doc-compact-btn")?.disabled);
  const packagePromise = popup.waitForEvent("download");
  await exportButton.click();
  await popup.locator(".prompt-text-dialog input").fill("采购审批:2026");
  await popup.locator(".prompt-text-dialog .confirm-submit").click();
  const packageDownload = await packagePromise;
  assert.equal(packageDownload.suggestedFilename(), "采购审批-2026.zip");

  const packageStream = await packageDownload.createReadStream();
  const packageChunks = [];
  for await (const chunk of packageStream) packageChunks.push(chunk);
  const archiveFiles = unzipSync(new Uint8Array(Buffer.concat(packageChunks)));
  assert.ok(archiveFiles["采购审批-2026/采购审批-2026.md"]);
  assert.equal(archiveFiles["采购审批-2026.json"], undefined);
  const screenshotFiles = Object.keys(archiveFiles).filter(name => name.startsWith("采购审批-2026/screenshots/"));
  assert.ok(screenshotFiles.some(name => /-before\.jpg$/.test(name)));
  assert.ok(screenshotFiles.some(name => /-after\.jpg$/.test(name)));
  const exportedMarkdown = strFromU8(archiveFiles["采购审批-2026/采购审批-2026.md"]);
  assert.match(exportedMarkdown, /## Step screenshots/);
  assert.match(exportedMarkdown, /Step \d+ before:/);
  assert.match(exportedMarkdown, /Step \d+ after:/);

  const stepsBeforeSnapshot = actions.length;
  await serviceWorker.evaluate(() => chrome.storage.local.set({ isRecording: true, activeCaseId: null }));
  const saveCurrentCaseButton = popup.locator("#save-current-case-btn");
  await saveCurrentCaseButton.click();
  await popup.locator(".prompt-text-dialog input").fill("菜单基础步骤");
  await popup.locator(".prompt-text-dialog .confirm-submit").click();
  await popup.waitForFunction(() => document.querySelector("#save-current-case-btn .btn-label")?.textContent === "已保存");
  const savedSnapshotState = await serviceWorker.evaluate(async () => chrome.storage.local.get(["isRecording", "activeCaseId"]));
  assert.equal(savedSnapshotState.isRecording, true);
  assert.equal(savedSnapshotState.activeCaseId, null);
  const savedSnapshot = (await readCases(serviceWorker)).find(item => item.name === "菜单基础步骤");
  assert.ok(savedSnapshot);
  assert.equal(savedSnapshot.actions.length, stepsBeforeSnapshot);
  assert.equal(savedSnapshot.stepCount, stepsBeforeSnapshot);

  await writeActions(serviceWorker, [
    ...(await readActions(serviceWorker)),
    { id: "after-snapshot", type: "click", pageName: "page1", timestamp: Date.now() }
  ]);
  const snapshotAfterMoreWork = {
    workspaceCount: (await readActions(serviceWorker)).length,
    snapshotCount: (await readCases(serviceWorker))
      .find(item => item.name === "菜单基础步骤")?.actions.length
  };
  assert.equal(snapshotAfterMoreWork.workspaceCount, stepsBeforeSnapshot + 1);
  assert.equal(snapshotAfterMoreWork.snapshotCount, stepsBeforeSnapshot);

  await writeCases(serviceWorker, [
    ...(await readCases(serviceWorker)),
    {
      id: "second-export-case",
      name: "第二个基础用例",
      createdAt: Date.now(),
      actions: [{
        id: "second-export-step",
        timestamp: Date.now(),
        type: "navigate",
        pageName: "page1",
        url: "https://example.test/second",
        title: "Second"
      }],
      pages: [{ name: "page1", url: "https://example.test/second", title: "Second" }]
    }
  ]);
  const workbenchPage = await context.newPage();
  await workbenchPage.goto(`chrome-extension://${extensionId}/ui/console.html`, {
    waitUntil: "domcontentloaded"
  });
  await workbenchPage.waitForFunction(() => document.querySelectorAll(".library-item").length >= 2);
  await workbenchPage.locator("#case-library-select-all").check();
  const batchDownloadPromise = workbenchPage.waitForEvent("download");
  await workbenchPage.locator("#batch-export-cases-btn").click();
  const batchDownload = await batchDownloadPromise;
  assert.match(batchDownload.suggestedFilename(), /^批量用例-\d{4}-\d{2}-\d{2}\.zip$/);
  const batchStream = await batchDownload.createReadStream();
  const batchChunks = [];
  for await (const chunk of batchStream) batchChunks.push(chunk);
  const batchFiles = unzipSync(new Uint8Array(Buffer.concat(batchChunks)));
  assert.ok(batchFiles["菜单基础步骤/菜单基础步骤.md"]);
  assert.ok(batchFiles["第二个基础用例/第二个基础用例.md"]);
  assert.ok(Object.keys(batchFiles).some(name => name.startsWith("菜单基础步骤/screenshots/")));

  // A collaboration package is distinct from the human-readable document ZIP:
  // it carries structured steps and media references, and can be imported into
  // another profile without replacing the open workspace.
  await workbenchPage.locator("#case-library-select-all").uncheck();
  const sharedHistoryItem = workbenchPage.locator(".library-item", { hasText: "菜单基础步骤" }).first();
  await sharedHistoryItem.locator(".library-case-checkbox").check();
  const casePackageDownloadPromise = workbenchPage.waitForEvent("download");
  await workbenchPage.locator("#export-case-package-btn").click();
  const casePackageDownload = await casePackageDownloadPromise;
  assert.equal(casePackageDownload.suggestedFilename(), "菜单基础步骤.swrcase");
  const casePackageStream = await casePackageDownload.createReadStream();
  const casePackageChunks = [];
  for await (const chunk of casePackageStream) casePackageChunks.push(chunk);
  const casePackageBuffer = Buffer.concat(casePackageChunks);
  const casePackageFiles = unzipSync(new Uint8Array(casePackageBuffer));
  const casePackageManifest = JSON.parse(strFromU8(
    casePackageFiles["workflow-recorder-case-package.json"]
  ));
  assert.equal(casePackageManifest.format, "workflow-recorder-case-package");
  assert.equal(casePackageManifest.version, 1);
  assert.equal(casePackageManifest.cases.length, 1);
  assert.ok(casePackageManifest.assets.length > 0);
  assert.equal(casePackageManifest.cases[0].actions.some(action => action.screenshotKey), false);

  const casesBeforeImport = (await readCases(serviceWorker)).length;
  await workbenchPage.locator("#case-package-file-input").setInputFiles({
    name: "菜单基础步骤.swrcase",
    mimeType: "application/zip",
    buffer: casePackageBuffer
  });
  await workbenchPage.waitForFunction(expected => new Promise(resolve => {
    const check = () => chrome.storage.local.get("caseIndex", data => {
      if ((data.caseIndex || []).length === expected) resolve(true);
      else setTimeout(check, 50);
    });
    check();
  }), casesBeforeImport + 1);
  const importedCase = (await readCases(serviceWorker)).find(item =>
    /^case_import_/.test(item.id) && item.name === "菜单基础步骤（2）"
  );
  assert.ok(importedCase);
  assert.equal(importedCase.actions.length, savedSnapshot.actions.length);
  const importedScreenshotKey = importedCase.actions
    .flatMap(action => [action.screenshotBeforeKey, action.screenshotKey])
    .find(Boolean);
  assert.ok(importedScreenshotKey);
  assert.equal(
    await serviceWorker.evaluate(key => globalThis.RecorderMediaStore.getBlob(key).then(Boolean), importedScreenshotKey),
    true
  );
  if (process.env.CAPTURE_CASE_SHARING === "1") {
    const outputDir = path.resolve(__dirname, "..", "test-results");
    fs.mkdirSync(outputDir, { recursive: true });
    await workbenchPage.screenshot({ path: path.join(outputDir, "case-sharing-340.png") });
  }
  await workbenchPage.close();

  const historyAction = {
    id: "history-login-step",
    timestamp: Date.now() - 10000,
    type: "click",
    pageName: "page1",
    url: `${fixture.origin}/base`,
    title: "Base page",
    target: {
      tagName: "button",
      id: "login-menu",
      role: "button",
      accessibleName: "进入业务菜单",
      domPath: "button#login-menu",
      outerHTML: '<button id="login-menu">进入业务菜单</button>'
    }
  };
  const currentDraftAction = {
    id: "current-draft-step",
    timestamp: Date.now(),
    type: "click",
    pageName: "page1",
    url: `${fixture.origin}/base`,
    title: "Base page",
    target: {
      tagName: "button",
      id: "effect-action",
      role: "button",
      accessibleName: "Visible effect",
      domPath: "button#effect-action",
      outerHTML: '<button id="effect-action">Visible effect</button>'
    }
  };
  await writeActions(serviceWorker, [currentDraftAction]);
  const rootTabInfo = await serviceWorker.evaluate(async ({ rootTabId }) => {
    const rootTab = await chrome.tabs.get(rootTabId);
    await chrome.storage.local.set({
      isRecording: true,
      tabsMapping: { [rootTabId]: "page1" },
      recordingTabIds: [rootTabId],
      nextPageNumber: 2,
      activeCaseId: null
    });
    return { url: rootTab.url, title: rootTab.title };
  }, { rootTabId });
  await writeCases(serviceWorker, [{
    id: "history-login-case",
    name: "登录后业务菜单",
    createdAt: Date.now() - 20000,
    actions: [historyAction],
    pages: [{ name: "page1", url: rootTabInfo.url, title: rootTabInfo.title }]
  }]);

  const loadedHistoryCase = await popup.evaluate(async () => {
    const stopped = await chrome.runtime.sendMessage({ action: "toggleRecording", start: false });
    if (!stopped?.success) return stopped;
    const saved = await chrome.runtime.sendMessage({ action: "saveCase", name: "登录准备" });
    if (!saved?.success) return saved;
    return chrome.runtime.sendMessage({ action: "loadCase", caseId: "history-login-case" });
  });
  assert.equal(loadedHistoryCase.success, true);
  await waitForActions(serviceWorker, current =>
    current.length === 1 && current[0].id === "history-login-step"
  );
  await popup.waitForFunction(() => {
    const descriptions = Array.from(document.querySelectorAll(".step-card .step-description"));
    return descriptions.length === 1 && descriptions[0].textContent.includes("进入业务菜单");
  });
  assert.match(await popup.locator(".step-card .step-description").innerText(), /进入业务菜单/);

  const historyState = await serviceWorker.evaluate(async () => chrome.storage.local.get("isRecording"));
  assert.equal(historyState.isRecording, false);
  assert.deepEqual((await readActions(serviceWorker)).map(action => action.id), ["history-login-step"]);
  assert.ok((await readCases(serviceWorker))
    .some(item => item.name === "登录准备" && item.actions[0].id === "current-draft-step"));
  assert.equal((await popup.locator("#record-btn-label").innerText()).trim(), "继续录制");
  assert.equal(await popup.locator("#restart-record-btn").count(), 0);
  // Clearing is the quiet control beside the step list: always present, so it is
  // reachable at every panel width.
  assert.equal((await popup.locator("#clear-steps-btn").innerText()).trim(), "清空步骤");
  assert.equal(await popup.locator("#clear-steps-btn").isVisible(), true);
  await popup.locator("#clear-steps-btn").click();
  await popup.locator(".confirm-dialog").waitFor({ state: "visible" });
  assert.equal((await popup.locator("#confirm-title").innerText()).trim(), "清空步骤");
  assert.match(await popup.locator("#confirm-message").innerText(), /不会自动保存.*已保存用例不受影响.*不会开始录制/);
  await popup.locator(".confirm-cancel").click();
  await popup.locator(".confirm-dialog").waitFor({ state: "detached" });
  assert.deepEqual((await readActions(serviceWorker)).map(action => action.id), ["history-login-step"]);
  const stateAfterClearCancel = await serviceWorker.evaluate(async () => chrome.storage.local.get("isRecording"));
  assert.equal(stateAfterClearCancel.isRecording, false);

  // Starting a fresh workspace remains a background capability even though case
  // management has moved out of the side panel.
  const newCaseResult = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "newCase" }));
  assert.equal(newCaseResult.success, true);
  await popup.waitForFunction(() => document.querySelectorAll(".step-card").length === 0);
  assert.deepEqual(await readActions(serviceWorker), []);
  // The steps that were open are banked as a case rather than discarded.
  assert.ok((await readCases(serviceWorker))
    .some(item => item.actions?.some(action => action.id === "history-login-step")));

  // Recording must not start until the data disclosure has been accepted.
  await serviceWorker.evaluate(() => chrome.storage.local.remove("recordingConsentVersion"));
  await popup.locator("#record-btn").click();
  const consentDialog = popup.locator(".consent-dialog");
  await consentDialog.waitFor({ state: "visible" });
  assert.equal((await popup.locator("#consent-title").innerText()).trim(), "开始录制前请确认");
  assert.match(await consentDialog.innerText(), /表单输入值/);
  assert.doesNotMatch(await consentDialog.innerText(), /密码输入框除外|不会被记录/);
  assert.equal(await popup.locator(".consent-list li").count(), 5);

  // Declining leaves the session untouched and stores no consent.
  await consentDialog.locator(".confirm-cancel").click();
  await consentDialog.waitFor({ state: "detached" });
  const declined = await serviceWorker.evaluate(async () => chrome.storage.local.get([
    "isRecording",
    "recordingConsentVersion"
  ]));
  assert.equal(declined.isRecording, false);
  assert.equal(declined.recordingConsentVersion, undefined);

  // Accepting records consent so later starts are not gated again.
  await popup.locator("#record-btn").click();
  await consentDialog.waitFor({ state: "visible" });
  await consentDialog.locator(".confirm-submit").click();
  await consentDialog.waitFor({ state: "detached" });
  // Consent is now on record. Whether the recording itself starts depends on
  // which tab is active and is covered by the clear-then-start flow below; this block
  // only pins down the gate.
  await waitForCondition(
    async () => (await serviceWorker.evaluate(
      async () => chrome.storage.local.get("recordingConsentVersion")
    )).recordingConsentVersion === 3,
    "recording consent to be stored"
  );
  await popup.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));
  await writeActions(serviceWorker, [{
    id: "history-login-step",
    timestamp: Date.now() - 10000,
    type: "click",
    pageName: "page1",
    target: { tagName: "button", id: "login-menu", role: "button", accessibleName: "进入业务菜单" }
  }]);
  await serviceWorker.evaluate(() => chrome.storage.local.set({ isRecording: false }));
  await popup.waitForFunction(() => document.querySelector("#record-btn-label")?.textContent.trim() === "继续录制");

  const continueResponse = await popup.evaluate((targetTabId) => chrome.runtime.sendMessage({
    action: "toggleRecording",
    start: true,
    recordingMode: "continue",
    rootTabId: targetTabId
  }), rootTabId);
  assert.equal(continueResponse.success, true);
  let continuedActions = await waitForActions(
    serviceWorker,
    current => current.length === 1 && current[0].id === "history-login-step"
  );
  assert.equal(continuedActions.length, 1);

  await page.bringToFront();
  await page.locator("#effect-action").click();
  continuedActions = await waitForActions(
    serviceWorker,
    current => current.length === 2 && current[0].id === "history-login-step" && current[1].type === "click"
  );
  assert.equal(continuedActions[1].pageName, "page1");
  await popup.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));
  await popup.waitForFunction(() => document.querySelector("#record-btn-label")?.textContent.trim() === "继续录制");

  const casesBeforeClear = await readCases(serviceWorker);
  await popup.locator("#clear-steps-btn").click();
  await popup.locator(".confirm-dialog").waitFor({ state: "visible" });
  await popup.locator(".confirm-submit").click();
  await popup.locator(".confirm-dialog").waitFor({ state: "detached" });
  await popup.waitForFunction(() =>
    document.querySelectorAll(".step-card").length === 0 &&
    document.querySelector("#record-btn-label")?.textContent.trim() === "开始录制"
  );
  assert.deepEqual(await readActions(serviceWorker), []);
  assert.equal(await popup.locator("#clear-steps-btn").isDisabled(), true);
  const clearedState = await serviceWorker.evaluate(async () => chrome.storage.local.get([
    "isRecording", "activeCaseId", "workspaceOrigin", "nextPageNumber"
  ]));
  assert.equal(clearedState.isRecording, false);
  assert.equal(clearedState.activeCaseId, null);
  assert.equal(clearedState.workspaceOrigin, null);
  assert.equal(clearedState.nextPageNumber, 1);
  // Clearing discards the draft without saving a new case or changing saved cases.
  assert.deepEqual(await readCases(serviceWorker), casesBeforeClear);

  await page.bringToFront();
  await popup.evaluate(() => document.querySelector("#record-btn").click());
  // Starting after a clear records the new session's own opening step. The
  // content script's already-recorded latch must not survive the previous stop.
  const freshActions = await waitForActions(
    serviceWorker,
    current => current.length === 1 && current[0].type === "navigate"
  );
  assert.equal(freshActions[0].pageName, "page1");
  await popup.waitForFunction(() => document.querySelectorAll(".step-card").length === 1);
  assert.equal((await popup.locator("#record-btn-label").innerText()).trim(), "停止录制");
  assert.equal(await popup.locator("#clear-steps-btn").isDisabled(), true);
  await popup.locator("#manual-screenshot-btn").waitFor({ state: "visible" });
  const freshState = await serviceWorker.evaluate(async () => chrome.storage.local.get([
    "isRecording",
    "activeCaseId"
  ]));
  assert.equal(freshState.isRecording, true);
  assert.equal(freshState.activeCaseId, null);
  assert.deepEqual(await readCases(serviceWorker), casesBeforeClear);

  await popup.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));
  const burstStart = await popup.evaluate((targetTabId) => chrome.runtime.sendMessage({
    action: "toggleRecording",
    start: true,
    rootTabId: targetTabId
  }), rootTabId);
  assert.equal(burstStart.success, true);
  // Restarting in the same document must still record its own opening step. The
  // content script's guard is scoped to the document's script world, not to the
  // recording session, so without a reset on stop the second session silently
  // loses its first step -- the mirror image of the duplicate above.
  await waitForActions(serviceWorker, current => current.length === 1 && current[0].type === "navigate");
  await page.bringToFront();
  await page.evaluate(() => {
    for (let index = 1; index <= 3; index++) {
      const button = document.createElement("button");
      button.id = `burst-action-${index}`;
      button.textContent = `Burst action ${index}`;
      button.addEventListener("click", () => {
        document.body.dataset[`burst${index}`] = String(Date.now());
      });
      document.body.appendChild(button);
    }
  });
  for (let index = 1; index <= 3; index++) {
    await page.locator(`#burst-action-${index}`).click();
  }
  await waitForActions(serviceWorker, current =>
    current.filter(action => action.target?.id?.startsWith("burst-action-")).length === 3
  );
  assert.equal(await page.locator("#playwright-recorder-overlay").count(), 0);

  const fallbackChildPromise = context.waitForEvent("page");
  await page.locator("#open-child").click();
  const fallbackChild = await fallbackChildPromise;
  await fallbackChild.waitForLoadState("domcontentloaded");
  await waitForRecorder(serviceWorker, fallbackChild.url());
  assert.equal(await fallbackChild.locator("#playwright-recorder-overlay").count(), 0);
  await fallbackChild.locator("#child-action").click();
  await waitForActions(serviceWorker, current =>
    current.some(action => action.target?.id === "child-action" && action.pageName !== "page1")
  );
  await fallbackChild.close();
  await page.bringToFront();

  // Stopping is gated on the screenshot queue draining, and the CDP screencast
  // stays attached until it does, so Chrome keeps showing its "started debugging
  // this browser" infobar for the whole time. This point in the run has a
  // deliberate backlog, which makes it the worst case. The bound is loose enough
  // for a loaded CI runner but still fails the multi-second regression it guards:
  // draining used to cost a page-stability wait per pending step.
  const burstStopStartedAt = Date.now();
  const burstStop = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));
  const burstStopMs = Date.now() - burstStopStartedAt;
  assert.equal(burstStop.success, true);
  assert.ok(burstStopMs < 2500, `stopping with a screenshot backlog took ${burstStopMs}ms`);

  const burstState = await readActions(serviceWorker);
  const burstActions = burstState.filter(action => action.target?.id?.startsWith("burst-action-"));
  assert.equal(burstActions.length, 3);
  assert.equal(
    burstActions.every(action => action.screenshotKey),
    true,
    JSON.stringify(burstActions.map(action => ({ id: action.target?.id, screenshotKey: action.screenshotKey, screenshotSource: action.screenshotSource })))
  );
  // The click that opened the child page records that fact in its own field, so
  // it survives a re-capture of the step, and its card says the frame was never
  // going to exist rather than that it went missing.
  const openChildAction = burstState.find(action => action.target?.id === "open-child");
  assert.ok(openChildAction, "the click that opened the child page should be recorded");
  assert.equal(openChildAction.openedChildPage, true);
  assert.equal(openChildAction.screenshotSkippedReason, "opens-child-page");
  const openChildCardText = await popup.locator(".step-card")
    .nth(burstState.findIndex(action => action.id === openChildAction.id)).innerText();
  assert.match(openChildCardText, /无需截图/);
  assert.match(openChildCardText, /点击打开了新页面/);

  const closedChildAction = burstState.find(action => action.target?.id === "child-action" && action.pageName !== "page1");
  assert.equal(closedChildAction?.screenshotKey, undefined);
  assert.ok(closedChildAction?.screenshotError);
  const closedChildIndex = burstState.findIndex(action => action.id === closedChildAction.id);
  await popup.waitForFunction(expected => document.querySelectorAll(".step-card").length === expected, burstState.length);
  const closedChildCardText = await popup.locator(".step-card").nth(closedChildIndex).innerText();
  assert.match(closedChildCardText, /无截图/);
  // A step whose page went away is a failure with a cause, not the deliberate
  // skip that "无需截图" names, and the cause is the reason code rather than the
  // raw message the capture pipeline happened to throw.
  assert.doesNotMatch(closedChildCardText, /无需截图|截图不可用/);
  assert.match(closedChildCardText, /页面已关闭|未能读取页面画面/);

  const sharedScreenshotKey = "screenshot:shared-deletion-test";
  await serviceWorker.evaluate(async (key) => {
    await globalThis.RecorderMediaStore.putBlob(key, new Blob(["shared screenshot"], { type: "image/jpeg" }));
    const action = {
      id: "shared-deletion-test",
      timestamp: Date.now(),
      type: "click",
      pageName: "page1",
      screenshotKey: key,
      target: { tagName: "button", id: "shared-delete", accessibleName: "Shared delete" }
    };
    await chrome.storage.local.set({
      isRecording: false,
      actionOrder: [action.id],
      [`action:${action.id}`]: action,
      activeCaseId: null
    });
    return action;
  }, sharedScreenshotKey);
  // The same screenshot is referenced by the workspace step and by a saved case,
  // so neither deletion on its own may reclaim the blob.
  await writeCases(serviceWorker, [{
    id: "shared-deletion-case",
    name: "Shared screenshot case",
    createdAt: Date.now(),
    actions: [{
      id: "shared-deletion-test",
      timestamp: Date.now(),
      type: "click",
      pageName: "page1",
      screenshotKey: sharedScreenshotKey
    }],
    pages: [{ name: "page1", url: "https://example.test", title: "Example" }]
  }]);
  await popup.waitForFunction(() => document.querySelectorAll(".step-card").length === 1);
  await popup.locator(".step-card .step-delete-btn").click();
  await popup.locator(".confirm-dialog .confirm-submit").click();
  await popup.waitForFunction(() => document.querySelectorAll(".step-card").length === 0);
  assert.equal(await serviceWorker.evaluate(key => globalThis.RecorderMediaStore.getBlob(key).then(Boolean), sharedScreenshotKey), true);

  const deleteCaseResponse = await popup.evaluate(caseId => chrome.runtime.sendMessage({ action: "deleteCase", caseId }), "shared-deletion-case");
  assert.equal(deleteCaseResponse.success, true);
  assert.equal(await serviceWorker.evaluate(key => globalThis.RecorderMediaStore.getBlob(key).then(Boolean), sharedScreenshotKey), false);

  const orphanScreenshotKey = "screenshot:orphan-cleanup-test";
  await serviceWorker.evaluate(
    key => globalThis.RecorderMediaStore.putBlob(key, new Blob(["orphan screenshot"], { type: "image/jpeg" })),
    orphanScreenshotKey
  );
  assert.equal(await serviceWorker.evaluate(key => globalThis.RecorderMediaStore.getBlob(key).then(Boolean), orphanScreenshotKey), true);
  const cleanupResponse = await popup.evaluate(() => chrome.runtime.sendMessage({ action: "cleanupScreenshots", force: true }));
  assert.equal(cleanupResponse.pending, false);
  assert.ok(cleanupResponse.deletedCount >= 1);
  assert.equal(await serviceWorker.evaluate(key => globalThis.RecorderMediaStore.getBlob(key).then(Boolean), orphanScreenshotKey), false);

});

test("a paused recording re-adopts the window it opened before the pause", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());

  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) serviceWorker = await context.waitForEvent("serviceworker");
  await serviceWorker.evaluate(() => chrome.storage.local.set({
    uiLanguage: "zh_CN",
    recordingConsentVersion: 3,
    isRecording: false
  }));

  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  const rootTabId = await serviceWorker.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === url)?.id;
  }, `${fixture.origin}/base`);
  assert.ok(Number.isInteger(rootTabId));

  // The side panel is the real entry point. The root tab is pinned explicitly so
  // the assertions cannot depend on which window happens to be focused.
  const controller = await context.newPage();
  await controller.goto(
    `chrome-extension://${serviceWorker.url().split("/")[2]}/ui/popup.html`,
    { waitUntil: "domcontentloaded" }
  );
  const toggle = (start, recordingMode) => controller.evaluate(
    request => chrome.runtime.sendMessage({ action: "toggleRecording", ...request }),
    { start, recordingMode, rootTabId }
  );

  assert.equal((await toggle(true, "restart")).success, true);
  await waitForActions(serviceWorker, current => current.some(action => action.type === "navigate"));

  await page.bringToFront();
  const childPromise = context.waitForEvent("page");
  await page.locator("#open-child").click();
  const child = await childPromise;
  await child.waitForLoadState("domcontentloaded");
  await waitForRecorder(serviceWorker, child.url());
  await child.locator("#child-action").click(CLICK_IN_CHILD);
  const firstSession = await waitForActions(
    serviceWorker,
    current => current.some(action => action.target?.id === "child-action"),
    LOADED_MACHINE_TIMEOUT_MS
  );
  const childPageName = firstSession.find(action => action.target?.id === "child-action").pageName;
  assert.notEqual(childPageName, "page1");

  assert.equal((await toggle(false)).success, true);

  // Second session: the child page is still open, and continuing has to bring it
  // back. A tab opened mid-recording raises no event of its own that would.
  assert.equal((await toggle(true, "continue")).success, true);
  await child.bringToFront();
  await child.locator("#child-resume-action").click(CLICK_IN_CHILD);
  const secondSession = await waitForActions(
    serviceWorker,
    current => current.some(action => action.target?.id === "child-resume-action"),
    LOADED_MACHINE_TIMEOUT_MS
  );
  // The handle it already had: the resumed tab is the same page of the workflow
  // rather than a second one describing the same window.
  assert.equal(
    secondSession.find(action => action.target?.id === "child-resume-action").pageName,
    childPageName
  );

  // The page the recording started from is still in scope too.
  await page.bringToFront();
  await page.locator("#effect-action").click();
  const bothPages = await waitForActions(
    serviceWorker,
    current => current.some(action => action.target?.id === "effect-action"),
    LOADED_MACHINE_TIMEOUT_MS
  );
  assert.equal(bothPages.find(action => action.target?.id === "effect-action").pageName, "page1");

  assert.equal((await toggle(false)).success, true);
  assert.deepEqual(
    [...new Set(bothPages.map(action => action.pageName))].sort(),
    ["page1", childPageName]
  );
});

test("recording debug export explains filtered backgrounds and valid custom controls without input values", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  // Run this diagnostic-only flow against an explicit opt-in copy. The shared
  // extension must keep diagnostics disabled and its settings controls hidden.
  const sourceRoot = path.resolve(__dirname, "..");
  const localRoot = path.join(sourceRoot, ".local");
  fs.mkdirSync(localRoot, { recursive: true });
  const extensionPath = fs.mkdtempSync(path.join(localRoot, "debug-extension-"));
  for (const entry of ["manifest.json", "_locales", "background", "content", "shared", "ui", "icons", "vendor"]) {
    fs.cpSync(path.join(sourceRoot, entry), path.join(extensionPath, entry), { recursive: true });
  }
  const protocolPath = path.join(extensionPath, "shared", "protocol.js");
  fs.writeFileSync(protocolPath, fs.readFileSync(protocolPath, "utf8")
    .replace("const RECORDING_DEBUG_ENABLED = false;", "const RECORDING_DEBUG_ENABLED = true;"));
  fs.mkdirSync(path.join(extensionPath, ".local"));
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(async () => {
    try {
      const worker = context.serviceWorkers()[0];
      if (worker) {
        const debug = await worker.evaluate(() => chrome.storage.local.get("recordingDebugTimeline"));
        fs.writeFileSync(path.join(extensionPath, ".local", "background-filter-test-debug.json"), JSON.stringify(debug, null, 2));
      }
    } finally {
      await context.close();
      const resolved = path.resolve(extensionPath);
      assert.equal(path.dirname(resolved), localRoot);
      assert.ok(path.basename(resolved).startsWith("debug-extension-"));
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, captureSettings: { screenshots: false } }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base?token=debug-private-token`);
  await page.evaluate(() => {
    document.body.innerHTML = `<input id="debug-account" value="private-input-value">
      <ul><li id="login-background" style="width:300px;height:80px;user-select:none">Background</li></ul>
      <div id="carousel" style="width:300px;height:30px">Carousel</div>
      <div id="debug-dialog"><span id="debug-close">Close dialog</span></div>
      <div id="debug-drag" class="drag-item" style="width:100px;height:50px;user-select:none">Drag card</div>
      <div id="debug-js-drag" style="position:relative;left:0;width:100px;height:50px;user-select:none">JS drag card</div>`;
    document.querySelector("#debug-close").addEventListener("click", () => document.querySelector("#debug-dialog").remove());
    document.querySelector("#debug-account").addEventListener("focus", () => {
      document.querySelector("#carousel").style.backgroundColor = "white";
    });
    let dragStart = null;
    const card = document.querySelector("#debug-js-drag");
    card.addEventListener("mousedown", event => { dragStart = event.clientX; });
    document.addEventListener("mousemove", event => {
      if (dragStart !== null) card.style.left = `${event.clientX - dragStart}px`;
    });
    document.addEventListener("mouseup", () => { dragStart = null; });
    window.addEventListener("resize", () => {
      document.querySelector("#carousel").style.width = `${window.innerWidth}px`;
      const replacement = document.createElement("span");
      replacement.textContent = "Responsive background";
      document.querySelector("#carousel").replaceChildren(replacement);
    });
  });
  const rootTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await panel.locator("#capture-settings-btn").click();
  await panel.locator("#clear-recording-debug").click();
  await panel.locator(".confirm-cancel").click();
  const toggle = start => panel.evaluate(({ tabId, start }) => chrome.runtime.sendMessage({ action: "toggleRecording", start, rootTabId: tabId }), { tabId: rootTabId, start });
  assert.equal((await toggle(true)).success, true);
  await page.bringToFront();
  await page.locator("#login-background").click();
  await page.setViewportSize({ width: 1100, height: 760 });
  const getLog = () => panel.evaluate(() => chrome.runtime.sendMessage({ action: "exportRecordingDebug" }));
  await waitForCondition(async () => (await getLog()).log.events.some(entry => entry.event === "click-decision"), "inert click debug decision");
  assert.equal((await getLog()).log.events.find(entry => entry.event === "click-decision").detail.decision, "filtered");
  await page.evaluate(() => {
    window.debugBackgroundTimer = setInterval(() => {
      const background = document.querySelector("#login-background");
      background.setAttribute("class", background.className === "active" ? "next-slide" : "active");
      background.setAttribute("class", background.className);
    }, 80);
  });
  for (let i = 0; i < 7; i++) await page.locator("#login-background").click();
  await page.locator("#debug-account").focus();
  await waitForCondition(async () => (await getLog()).log.events.filter(entry => entry.event === "click-decision").length >= 8, "rapid background clicks finish validation");
  await page.evaluate(() => clearInterval(window.debugBackgroundTimer));
  assert.equal((await readActions(worker)).filter(action => action.type === "click").length, 0);
  await page.locator("#login-background").hover({ position: { x: 20, y: 20 } });
  await page.mouse.down();
  await page.mouse.move(100, 80, { steps: 3 });
  await page.mouse.up();
  await waitForCondition(async () => (await getLog()).log.events.some(entry => entry.event === "drag-filtered"), "background drag rejected");
  await page.locator("#debug-close").click();
  await waitForActions(worker, list => list.some(action => action.target?.id === "debug-close"));
  await page.locator("#debug-drag").hover({ position: { x: 20, y: 20 } });
  await page.mouse.down();
  await page.mouse.move(180, 230, { steps: 3 });
  await page.mouse.up();
  await waitForCondition(async () => (await getLog()).log.events.some(entry => entry.event === "drag-recorded"), "real control drag debug evidence");
  const jsCard = page.locator("#debug-js-drag");
  const jsBox = await jsCard.boundingBox();
  await jsCard.hover({ position: { x: 20, y: 20 } });
  await page.mouse.down();
  await page.mouse.move(jsBox.x + 80, jsBox.y + 20, { steps: 4 });
  await page.mouse.up();
  await waitForActions(worker, list => list.some(action => action.type === "drag" && action.source?.id === "debug-js-drag"));
  assert.equal((await toggle(false)).success, true);
  await panel.bringToFront();
  await panel.setViewportSize({ width: 420, height: 820 });
  await panel.locator("#capture-settings-btn").click();
  const downloadPromise = panel.waitForEvent("download");
  await panel.locator("#export-recording-debug").click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /^workflow-recorder-debug-.*\.json$/);
  const output = path.join(extensionPath, ".local", "recording-debug-export.json");
  await download.saveAs(output);
  const exported = JSON.parse(fs.readFileSync(output, "utf8"));
  const recorded = exported.events.find(entry => entry.event === "click-decision" && entry.detail.decision === "recorded");
  const domResult = exported.events.find(entry => entry.event === "click-dom-result" && entry.detail.clickId === recorded.detail.clickId);
  assert.equal(recorded.detail.evidence.domChanged, true);
  assert.ok(domResult.detail.acceptedMutations.some(sample => sample.type === "childList"));
  assert.equal(exported.events.filter(entry => entry.event === "click-decision" && entry.detail.decision === "recorded").length, 1);
  assert.ok(exported.events.some(entry => entry.event === "viewport-resize" && entry.detail.viewport.width === 1100));
  assert.ok(exported.events.some(entry => entry.event === "debugger-attached"));
  assert.doesNotMatch(JSON.stringify(exported), /private-input-value|debug-private-token/);
  await panel.screenshot({ path: path.join(extensionPath, ".local", "recording-debug-settings.png") });
  await panel.locator("#clear-recording-debug").click();
  assert.equal((await getLog()).log.events.length, 0);
});

test("unannotated JS close controls record their effect while inert and synthetic clicks stay filtered", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, captureSettings: { screenshots: false } }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  await page.evaluate(() => {
    const controls = document.createElement("div");
    controls.innerHTML = `<style>.my-icon-close {display:inline-block;width:24px;height:24px;cursor:auto}.my-icon-close::before{content:'×'}</style>
      <div id="custom-dialog"><span id="custom-close" data-v-a506f636="" class="my-icon-close close"></span></div>
      <div id="hidden-dialog"><span id="hidden-close" data-v-a506f636="" class="my-icon-close close"></span></div>
      <span id="inert-close" data-v-a506f636="" class="my-icon-close close"></span>`;
    controls.querySelector("#custom-close").addEventListener("click", () => controls.querySelector("#custom-dialog").remove());
    controls.querySelector("#hidden-close").addEventListener("click", () => { controls.querySelector("#hidden-dialog").style.display = "none"; });
    document.body.prepend(controls);
  });
  const rootTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  const toggle = start => panel.evaluate(({ tabId, start }) => chrome.runtime.sendMessage({ action: "toggleRecording", start, rootTabId: tabId }), { tabId: rootTabId, start });
  assert.equal((await toggle(true)).success, true);
  const diagnostics = [];
  page.on("console", message => diagnostics.push(message.text()));
  worker.on("console", message => diagnostics.push(message.text()));
  assert.equal(await page.locator("#custom-close").evaluate(element => getComputedStyle(element).cursor), "auto");
  await page.locator("#custom-close").click();
  await waitForActions(worker, list => list.some(action => action.target?.id === "custom-close"));
  assert.equal(await page.locator("#custom-dialog").count(), 0);
  await page.locator("#hidden-close").click();
  await waitForActions(worker, list => list.some(action => action.target?.id === "hidden-close"));
  assert.equal(await page.locator("#hidden-dialog").isVisible(), false);
  await page.locator("#inert-close").click();
  await waitForCondition(() => diagnostics.some(line => line.includes("no-observable-effect")), "inert click effect rejection");
  await page.evaluate(() => document.querySelector("#inert-close").click());
  await waitForCondition(() => diagnostics.some(line => line.includes("untrusted-event")), "synthetic click rejection");
  assert.equal((await toggle(false)).success, true);
  const actions = await readActions(worker);
  const clicks = actions.filter(action => action.type === "click");
  assert.deepEqual(clicks.map(action => action.target.id), ["custom-close", "hidden-close"]);
  assert.equal(clicks[0].target.role, null, "a JS handler does not fabricate a button role");
  assert.match(clicks[0].target.outerHTML, /my-icon-close close/);
});

test("closing a layui-style dialog from inside its iframe records the source click and keeps the parent recording", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, captureSettings: { screenshots: true } }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  const topUrl = page.url();
  await page.evaluate(() => {
    for (const [layerId, frameId] of [["layui-layer4", "layui-layer-iframe4"], ["native-layer", "native-close-frame"]]) {
      const layer = document.createElement("div");
      layer.className = "layui-layer layui-layer-iframe";
      layer.id = layerId;
      layer.innerHTML = `<div class="layui-layer-content"><iframe id="${frameId}" name="${frameId}" src="/self-closing-frame" style="height:100px"></iframe></div>`;
      document.body.prepend(layer);
    }
  });
  const customFrame = page.frameLocator("#layui-layer-iframe4");
  const nativeFrame = page.frameLocator("#native-close-frame");
  await customFrame.locator("#custom-frame-close").waitFor();
  await nativeFrame.locator("#native-frame-close").waitFor();
  const rootTabId = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url).id, topUrl);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  const toggle = start => panel.evaluate(({ tabId, start }) => chrome.runtime.sendMessage({ action: "toggleRecording", start, rootTabId: tabId }), { tabId: rootTabId, start });
  assert.equal((await toggle(true)).success, true);
  const diagnostics = [];
  worker.on("console", message => diagnostics.push(message.text()));
  await customFrame.locator("#frame-inert").click();
  await waitForCondition(() => diagnostics.some(line => line.includes("no-observable-effect")), "inert iframe click rejection");
  await customFrame.locator("#custom-frame-close").click();
  let actions = await waitForActions(worker, list => list.some(action => action.target?.id === "custom-frame-close" && action.screenshotKey));
  const custom = actions.find(action => action.target?.id === "custom-frame-close");
  assert.equal(custom.frameClosedAfterClick, true);
  assert.equal(custom.target.frameInfo.frameName, "layui-layer-iframe4");
  assert.equal(custom.screenshotSkippedReason, undefined);
  assert.equal(await page.locator("#layui-layer4").count(), 0);
  assert.equal(page.url(), topUrl);
  await nativeFrame.locator("#native-frame-close").click();
  actions = await waitForActions(worker, list => list.some(action => action.target?.id === "native-frame-close" && action.screenshotKey));
  assert.equal(actions.find(action => action.target?.id === "native-frame-close").frameClosedAfterClick, true);
  await page.locator("#effect-action").click();
  actions = await waitForActions(worker, list => list.some(action => action.target?.id === "effect-action" && action.screenshotKey));
  assert.equal(actions.some(action => action.target?.id === "frame-inert"), false);
  assert.equal(actions.find(action => action.target?.id === "effect-action").pageName, "page1");
  assert.equal((await toggle(false)).success, true);
  const doc = await panel.evaluate(list => StepDocGenerator.generate(list), actions);
  assert.match(doc, /in iframe\[name=layui-layer-iframe4\]/);
  assert.match(doc, /source iframe closed after this step/);
  assert.doesNotMatch(doc, /^   page closed after this step$/m);
});

test("branch menu recording normalizes SVG and text hits without inventing hover steps", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, captureSettings: { screenshots: false } }));
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  await page.evaluate(() => {
    const container = document.createElement("div");
    container.innerHTML = `<button id="branch-toggle" style="cursor:pointer" aria-expanded="false">
      <svg id="branch-icon" class="branch-icon" width="20" height="20"><rect width="20" height="20"/></svg>
      <span id="branch-label">standard-V11.x-develop</span>
    </button><div class="dropdown-menu" hidden>
      <div class="dropdown-input"><input placeholder="Search branches"></div>
      <div class="dropdown-content"><ul><li><a id="branch-option" href="#selected">standard-V10.x-develop-bap</a></li></ul></div>
    </div>`;
    const button = container.querySelector("button");
    button.setAttribute("title", "Branch menu details ".repeat(30));
    button.setAttribute("data-testid", "branch-picker");
    const menu = container.querySelector(".dropdown-menu");
    button.addEventListener("click", () => {
      menu.hidden = !menu.hidden;
      button.setAttribute("aria-expanded", String(!menu.hidden));
    });
    container.querySelector("a").addEventListener("click", () => { menu.hidden = true; });
    document.body.prepend(container);
  });
  const rootTabId = await worker.evaluate(async url =>
    (await chrome.tabs.query({})).find(tab => tab.url === url).id, page.url());
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await panel.waitForFunction(() => window.StepDocGenerator);
  const toggle = start => panel.evaluate(({ tabId, start }) => chrome.runtime.sendMessage({
    action: "toggleRecording", start, rootTabId: tabId
  }), { tabId: rootTabId, start });
  assert.equal((await toggle(true)).success, true);
  await page.locator("#branch-icon").click({ position: { x: 5, y: 5 } });
  await waitForActions(worker, actions => actions.some(action => action.hitTarget?.tagName === "rect"));
  await page.locator("#branch-option").click();
  await waitForActions(worker, actions => actions.some(action => action.target?.id === "branch-option"));
  await page.locator("#branch-label").click();
  await waitForActions(worker, actions => actions.some(action => action.hitTarget?.id === "branch-label"));
  let steps = await readActions(worker);
  assert.equal(steps.filter(action => action.type === "hover").length, 0, "menu structure cannot invent user actions");
  const buttonClicks = steps.filter(action => action.target?.id === "branch-toggle");
  assert.equal(buttonClicks.length, 2);
  for (const action of buttonClicks) {
    assert.equal(action.target.tagName, "button");
    assert.equal(action.accessibility.role, "button", JSON.stringify(action.accessibility));
    assert.equal(action.accessibility.name, "standard-V11.x-develop");
  }
  const svgClasses = await worker.evaluate(tabId => chrome.scripting.executeScript({
    target: { tabId }, world: "ISOLATED",
    func: () => window.SemanticElementAnalyzer.analyze(document.querySelector("#branch-icon")).className
  }), rootTabId);
  assert.equal(svgClasses[0].result, "branch-icon");
  await page.locator("#branch-icon").hover({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Alt+h");
  await waitForActions(worker, actions => actions.some(action => action.type === "hover"));
  assert.equal((await toggle(false)).success, true);
  steps = await readActions(worker);
  assert.equal(steps.filter(action => action.type === "hover").length, 1, "explicit hover shortcut still records");
  const doc = await panel.evaluate(actions => window.StepDocGenerator.generateTask("Branch menu", actions), steps);
  assert.match(doc, /recorded hit: <rect>/);
  assert.match(doc, /recorded hit: <span id="branch-label">/);
  assert.match(doc, /DOM attribute hints: .*"data-testid":"branch-picker"/);
  assert.match(doc, /HTML snapshot truncated/);
  assert.doesNotMatch(doc, /\[object Object\]/);
});

test("a recording can be configured to save no screenshots at all", async (t) => {
  const fixture = await startFixtureServer();
  t.after(() => fixture.close());

  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  await worker.evaluate(() => chrome.storage.local.set({
    isRecording: false, uiLanguage: "zh_CN", recordingConsentVersion: 3
  }));

  const page = await context.newPage();
  await page.goto(`${fixture.origin}/base`);
  const rootTabId = await worker.evaluate(async url => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === url)?.id;
  }, `${fixture.origin}/base`);

  const panel = await context.newPage();
  const errors = [];
  panel.on("pageerror", error => errors.push(error.message));
  await panel.setViewportSize({ width: 380, height: 720 });
  await panel.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await panel.waitForFunction(() => document.querySelector("#capture-settings-btn"));

  // Reachable before any recording exists, which is why it is not in the
  // more-actions menu: that one is hidden while the workspace is empty.
  assert.equal(await panel.locator("#more-actions-btn").isHidden(), true);
  await panel.locator("#capture-settings-btn").click();
  const dialog = panel.locator(".capture-settings-dialog");
  await dialog.waitFor({ state: "visible" });
  // Sharpness presets are gone: measured against itself, a preset varied by more
  // than the gap between presets, so the on/off switch is the whole choice and the
  // footnote says which resolution the frames are kept at.
  assert.equal(await dialog.locator(".capture-quality-group").count(), 0);
  assert.match(await dialog.locator(".capture-settings-footnote").innerText(), /原生分辨率/);
  await dialog.locator("#capture-screenshots-enabled").uncheck();
  await dialog.locator(".confirm-submit").click();
  await dialog.waitFor({ state: "detached" });
  assert.deepEqual(
    await worker.evaluate(async () => (await chrome.storage.local.get("captureSettings")).captureSettings),
    { screenshots: false }
  );

  // The recording still captures steps, without a single frame.
  await panel.evaluate(tabId => chrome.runtime.sendMessage({
    action: "toggleRecording", start: true, recordingMode: "restart", rootTabId: tabId
  }), rootTabId);
  assert.equal(await panel.locator("#manual-screenshot-btn").isHidden(), true);
  // Enabling capture during a session changes only the next start/continue.
  await panel.locator("#capture-settings-btn").click();
  await panel.locator("#capture-screenshots-enabled").check();
  await panel.locator(".capture-settings-dialog .confirm-submit").click();
  assert.equal(await panel.locator("#manual-screenshot-btn").isHidden(), true);
  await page.bringToFront();
  await page.evaluate(() => {
    const button = document.createElement("button");
    button.id = "ax-icon-button";
    button.innerHTML = '<img alt="Open tools" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">';
    button.addEventListener("click", () => { document.body.dataset.iconClicked = "true"; });
    document.body.prepend(button);
    const unnamed = document.createElement("button");
    unnamed.id = "ax-unnamed-button";
    unnamed.style.cssText = "width:30px;height:20px";
    unnamed.addEventListener("click", () => { document.body.dataset.unnamedClicked = "true"; });
    document.body.prepend(unnamed);
    const parent = document.createElement("button");
    parent.setAttribute("aria-label", "More actions");
    parent.innerHTML = '<span id="ax-ignored-icon" aria-hidden="true" onclick="void 0" style="cursor:pointer;display:inline-block;padding:8px">...</span>';
    parent.addEventListener("click", () => { document.body.dataset.moreClicked = "true"; });
    document.body.prepend(parent);
  });
  await page.locator("#ax-icon-button img").click();
  await waitForActions(worker, current => current.some(action => action.target?.id === "ax-icon-button"));
  await page.locator("#ax-unnamed-button").click();
  await waitForActions(worker, current => current.some(action => action.target?.id === "ax-unnamed-button"));
  await page.locator("#ax-ignored-icon").click();
  await waitForActions(worker, current => current.some(action => action.target?.id === "ax-ignored-icon"));
  assert.equal(await page.locator("body").getAttribute("data-more-clicked"), "true");
  const frame = page.frameLocator("#formdesign-frame");
  await frame.locator("body").evaluate(body => {
    const button = document.createElement("button");
    button.id = "ax-frame-button";
    button.setAttribute("aria-label", "Frame tool");
    button.textContent = "Tool";
    button.style.cssText = "position:absolute;left:10px;top:110px";
    button.addEventListener("click", () => { body.dataset.toolClicked = "true"; });
    body.append(button);
  });
  await frame.locator("#ax-frame-button").click();
  await waitForActions(worker, current => current.some(action => action.target?.id === "ax-frame-button"));
  await page.locator("#effect-action").click();
  await waitForActions(worker, current => current.some(action => action.target?.id === "effect-action"));
  await panel.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));

  const steps = await readActions(worker);
  assert.ok(steps.length >= 2, "the steps were recorded");
  const clicked = steps.find(step => step.target?.id === "effect-action");
  assert.equal(clicked.accessibility.status, "captured", JSON.stringify(clicked.accessibility));
  assert.equal(clicked.accessibility.role, "button");
  assert.equal(clicked.accessibility.name, "Visible effect");
  assert.equal(clicked.target._axRef, undefined);
  const icon = steps.find(step => step.target?.id === "ax-icon-button");
  assert.ok(!icon.target.accessibleName, "DOM-derived hint stays separate");
  assert.equal(icon.accessibility.name, "Open tools", "browser includes descendant image alt text");
  const unnamed = steps.find(step => step.target?.id === "ax-unnamed-button");
  assert.equal(unnamed.accessibility.status, "captured");
  assert.equal(unnamed.accessibility.name, "", "an empty browser name is not invented");
  const framed = steps.find(step => step.target?.id === "ax-frame-button");
  assert.equal(framed.accessibility.name, "Frame tool", JSON.stringify(framed.accessibility));
  const ignored = steps.find(step => step.target?.id === "ax-ignored-icon");
  assert.equal(ignored.accessibility.status, "ignored", JSON.stringify(ignored.accessibility));
  assert.equal(ignored.accessibility.relatedAncestor.name, "More actions");
  assert.equal(ignored.accessibility.relatedAncestor.distance, 1);
  assert.equal(await worker.evaluate(tabId => chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "1" })
    .then(() => true, () => false), rootTabId), false, "the extension detached its own debugger session");
  for (const step of steps) {
    assert.equal(step.screenshotKey, undefined);
    assert.equal(step.screenshotBeforeKey, undefined);
    assert.equal(step.screenshotSkippedReason, "capture-disabled");
  }
  assert.equal(
    await worker.evaluate(() => globalThis.RecorderMediaStore.getAllKeys().then(keys => keys.length)),
    0,
    "nothing was written to the screenshot store"
  );

  // The list says why once instead of drawing an empty frame row per step.
  await panel.bringToFront();
  await panel.waitForFunction(() => document.querySelectorAll(".step-card").length > 0);
  assert.equal(
    (await panel.locator(".steps-screenshots-disabled").innerText()).trim(),
    "录制时未启用截图"
  );
  assert.equal(await panel.locator(".step-media-row:visible").count(), 0);

  // Export is still a usable document, just without a screenshots folder.
  const pending = panel.waitForEvent("download");
  await panel.locator("#download-doc-compact-btn").click();
  await panel.locator(".prompt-text-dialog input").fill("无截图用例");
  await panel.locator(".prompt-text-dialog .confirm-submit").click();
  const archive = await pending;
  const chunks = [];
  for await (const chunk of await archive.createReadStream()) chunks.push(chunk);
  const files = unzipSync(new Uint8Array(Buffer.concat(chunks)));
  const markdown = strFromU8(files["无截图用例/无截图用例.md"]);
  assert.match(markdown, /Recorded Workflow/);
  assert.match(markdown, /AX context \(browser-computed\).*Visible effect/);
  assert.match(markdown, /target is ignored by the browser accessibility tree; use DOM context/);
  assert.match(markdown, /not the clicked node.*More actions/);
  assert.doesNotMatch(markdown, /"role":"none"/);
  assert.doesNotMatch(markdown, /## Step screenshots/);
  assert.deepEqual(Object.keys(files).filter(name => name.includes("/screenshots/")), []);

  // Continue takes the newly enabled policy without changing the old steps.
  const resumed = await panel.evaluate(tabId => chrome.runtime.sendMessage({
    action: "toggleRecording", start: true, recordingMode: "continue", rootTabId: tabId
  }), rootTabId);
  assert.equal(resumed.success, true);
  await panel.locator("#capture-settings-btn").click();
  await panel.locator("#capture-screenshots-enabled").uncheck();
  await panel.locator(".capture-settings-dialog .confirm-submit").click();
  await panel.waitForFunction(() => !document.querySelector("#manual-screenshot-btn").hidden);
  await page.bringToFront();
  const opened = context.waitForEvent("page");
  await page.locator("#open-child").click();
  const child = await opened;
  await child.waitForLoadState("domcontentloaded");
  await waitForRecorder(worker, `${fixture.origin}/child`);
  await child.locator("#child-action").click();
  await waitForActions(worker, current => current.some(action =>
    action.target?.id === "child-action" && action.screenshotKey
  ));
  await panel.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));
  const withFrames = await readActions(worker);
  assert.equal(withFrames.find(action => action.target?.id === "effect-action").screenshotKey, undefined);
  assert.ok(withFrames.find(action => action.target?.id === "child-action").screenshotKey);

  assert.deepEqual(errors, []);
});

test("import publication survives cleanup and IndexedDB writes reject an aborted commit", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/console.html`);
  await page.waitForFunction(() => globalThis.RecorderCasePackage && globalThis.RecorderMediaStore);
  await page.evaluate(() => chrome.runtime.sendMessage({ action: "getSchemaState" }));
  await page.evaluate(async () => {
    await RecorderMediaStore.putBlob("orphan-test", new Blob(["orphan"]));
    await RecorderMediaStore.putBlob("delete-test", new Blob(["delete"]));
    await chrome.runtime.sendMessage({ action: "importCases", cases: [{
      id: "case_import_delete", name: "Delete during import", pages: [],
      actions: [{ id: "delete-step", type: "click", screenshotKey: "delete-test" }]
    }] });
    const put = RecorderMediaStore.putBlob;
    RecorderMediaStore.putBlob = async (key, blob) => {
      await put(key, blob);
      if (key.startsWith("import:")) {
        window.importStaged = key;
        await new Promise(resolve => { window.releaseImport = resolve; });
      }
    };
  });
  const bytes = require("fflate").zipSync({
    "workflow-recorder-case-package.json": require("fflate").strToU8(JSON.stringify({
      format: "workflow-recorder-case-package", version: 1,
      cases: [{ id: "source", name: "Protected import", pages: [],
        actions: [{ id: "source-step", type: "click", screenshotAsset: "image" }] }],
      assets: [{ id: "image", path: "media/image.jpg", type: "image/jpeg" }]
    })),
    "media/image.jpg": new Uint8Array([1, 2, 3])
  });
  const importing = page.evaluate(async values => {
    const blob = new Blob([new Uint8Array(values)]);
    return RecorderCasePackage.importCasePackage(blob);
  }, Array.from(bytes));
  await page.waitForFunction(() => window.importStaged);
  // Deleting a case must release the case queue even while the UI owns the
  // publication lock; the pending import needs that queue to commit.
  const deletion = await page.evaluate(() => chrome.runtime.sendMessage({ action: "deleteCase", caseId: "case_import_delete" }));
  assert.equal(deletion.success, true);
  assert.equal(deletion.cleanupPending, true);
  const deferred = await page.evaluate(() => chrome.runtime.sendMessage({ action: "cleanupScreenshots", force: true }));
  assert.equal(deferred.pending, true);
  assert.equal(deferred.skipped, true);
  assert.equal(await page.evaluate(async () => !!await RecorderMediaStore.getBlob(window.importStaged)), true);
  await page.evaluate(() => window.releaseImport());
  assert.equal((await importing).importedCount, 1);
  assert.equal(await page.evaluate(async () => !!await RecorderMediaStore.getBlob(window.importStaged)), true);
  assert.equal(await page.evaluate(async () => !!await RecorderMediaStore.getBlob("orphan-test")), false);
  assert.equal(await page.evaluate(async () => !!await RecorderMediaStore.getBlob("delete-test")), false);

  const aborted = await page.evaluate(async () => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = original.apply(this, args);
      request.addEventListener("success", () => request.transaction.abort());
      return request;
    };
    try {
      await RecorderMediaStore.putBlob("abort-test", new Blob(["image"]));
      return "resolved";
    } catch (error) {
      return error.message;
    } finally {
      IDBObjectStore.prototype.put = original;
    }
  });
  assert.match(aborted, /aborted/);
  assert.equal(await page.evaluate(async () => !!await RecorderMediaStore.getBlob("abort-test")), false);
  const deleteAborted = await page.evaluate(async () => {
    await RecorderMediaStore.putBlob("delete-abort-test", new Blob(["keep"]));
    const original = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (...args) {
      const request = original.apply(this, args);
      request.addEventListener("success", () => request.transaction.abort());
      return request;
    };
    try {
      await RecorderMediaStore.deleteBlob("delete-abort-test");
      return "resolved";
    } catch (error) {
      return error.message;
    } finally {
      IDBObjectStore.prototype.delete = original;
    }
  });
  assert.match(deleteAborted, /aborted/);
  assert.equal(await page.evaluate(async () => !!await RecorderMediaStore.getBlob("delete-abort-test")), true);
});


test("workbench renames a case without losing its folder, selection or loaded workspace", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const url = `chrome-extension://${worker.url().split("/")[2]}/ui/console.html`;
  await page.goto(url);
  const send = request => page.evaluate(request => chrome.runtime.sendMessage(request), request);
  await send({ action: "getSchemaState" });
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  await writeActions(worker, [{ id: "rename-step", type: "click", timestamp: 1, pageName: "page1",
    target: { tagName: "button", accessibleName: "Confirm" } }]);
  const folder = await send({ action: "createCaseFolder", name: "重命名测试" });
  const saved = await send({ action: "saveCase", name: "原用例", folderId: folder.folder.id });
  await page.locator(`#all-cases-btn`).click();
  const row = page.locator(`[data-case-id="${saved.case.id}"]`);
  await row.locator('input[type="checkbox"]').check();
  await row.locator(".rename").click();
  assert.equal(await page.locator(".prompt-text-dialog input").inputValue(), "原用例");
  await page.locator(".prompt-text-dialog input").fill("取消后的名称");
  await page.locator(".confirm-cancel").click();
  assert.equal((await send({ action: "getCaseDetails", caseId: saved.case.id })).case.name, "原用例");
  await row.locator(".rename").click();
  await page.locator(".prompt-text-dialog input").evaluate(input => {
    input.select();
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "长".repeat(100000));
    input.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  assert.equal((await page.locator(".prompt-text-dialog input").inputValue()).length, 120);
  assert.equal(await page.locator(".name-length-counter").innerText(), "120 / 120");
  await page.locator(".prompt-text-dialog input").fill("   ");
  await page.locator(".confirm-submit").click();
  assert.equal(await page.locator(".prompt-text-dialog").isVisible(), true);
  assert.equal(await page.locator(".prompt-text-dialog input").getAttribute("aria-invalid"), "true");
  assert.equal(await page.locator("#prompt-validation-error").isVisible(), true);
  assert.equal((await send({ action: "getCaseDetails", caseId: saved.case.id })).case.name, "原用例");
  await page.locator(".prompt-text-dialog input").fill("  新用例名称  ");
  await page.locator(".prompt-text-dialog input").press("Enter");
  await page.waitForFunction(id => document.querySelector(`[data-case-id="${id}"] strong`)?.textContent === "新用例名称", saved.case.id);
  assert.equal(await row.locator('input[type="checkbox"]').isChecked(), true);
  assert.equal(await row.locator("strong").getAttribute("title"), "新用例名称");
  await page.locator("#case-search-input").fill("不存在的名称");
  assert.equal(await page.locator("#batch-delete-cases-btn").isDisabled(), true);
  await page.locator("#case-search-input").fill("");
  assert.equal(await row.locator('input[type="checkbox"]').isChecked(), false);
  await row.locator('input[type="checkbox"]').check();
  await page.locator('[data-folder-id="unfiled"] .case-folder-button').click();
  assert.equal(await page.locator(".library-item").count(), 0);
  assert.equal(await page.locator("#batch-delete-cases-btn").isDisabled(), true);
  await page.locator("#all-cases-btn").click();
  assert.equal(await row.locator('input[type="checkbox"]').isChecked(), false);
  const listed = await send({ action: "listCases" });
  assert.equal(listed.cases.length, 1);
  assert.equal(listed.cases[0].folderId, folder.folder.id);
  assert.equal((await send({ action: "getCaseDetails", caseId: saved.case.id })).case.actions[0].id, "rename-step");
  await page.reload();
  await page.locator("#all-cases-btn").click();
  await page.waitForFunction(id => document.querySelector(`[data-case-id="${id}"] strong`)?.textContent === "新用例名称", saved.case.id);
  await page.evaluate(() => RecorderI18n.setLanguage("en"));
  await page.reload();
  await page.locator("#all-cases-btn").click();
  await page.getByRole("button", { name: "Rename case “新用例名称”", exact: true }).click();
  assert.equal(await page.locator(".prompt-text-dialog input").inputValue(), "新用例名称");
  await page.locator(".confirm-cancel").click();
  await worker.evaluate(() => chrome.storage.local.set({ activeCaseId: null }));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await popup.locator(".step-card").waitFor();
  await popup.locator("#more-actions-btn").click();
  const downloaded = popup.waitForEvent("download");
  await popup.locator("#download-doc-btn").click();
  assert.equal((await downloaded).suggestedFilename(), "新用例名称（2）.zip");
  const afterDownload = await send({ action: "listCases" });
  assert.equal(afterDownload.cases.length, 2);
  assert.ok(afterDownload.cases.every(item => item.folderId === folder.folder.id));
  assert.deepEqual(afterDownload.cases.map(item => item.name).sort(), ["新用例名称", "新用例名称（2）"]);
  await page.reload();
  await page.locator("#all-cases-btn").click();
  await row.locator(".rename").click();
  await page.locator(".prompt-text-dialog input").fill("新用例名称（2）");
  await page.locator(".confirm-submit").click();
  assert.equal(await page.locator(".prompt-text-dialog").isVisible(), true);
  assert.match(await page.locator("#prompt-validation-error").innerText(), /already exists/i);
  assert.equal((await send({ action: "getCaseDetails", caseId: saved.case.id })).case.name, "新用例名称");
  await page.locator(".confirm-cancel").click();
  assert.deepEqual(errors, []);
});


test("offscreen screenshots release object URLs and reload when revisited", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  await page.setViewportSize({ width: 360, height: 720 });
  await page.addInitScript(() => {
    globalThis.liveImageUrls = new Set();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); liveImageUrls.add(url); return url; };
    URL.revokeObjectURL = url => { liveImageUrls.delete(url); revoke(url); };
  });
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ action: "getSchemaState" }));
  await worker.evaluate(() => chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" }));
  await page.waitForFunction(() => !!globalThis.RecorderMediaStore);
  await page.evaluate(async () => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6XcAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    await RecorderMediaStore.putBlob("memory-test-shot", new Blob([bytes], { type: "image/png" }));
  });
  await writeActions(worker, Array.from({ length: 80 }, (_, index) => ({
    id: `memory-${index}`, type: "click", timestamp: index + 1, pageName: "page1",
    target: { tagName: "button", accessibleName: `Step ${index + 1}` },
    screenshotBeforeKey: "memory-test-shot", screenshotKey: "memory-test-shot"
  })));
  await page.waitForFunction(() => document.querySelectorAll(".step-card").length === 80);
  const first = page.locator(".step-card").first();
  await first.scrollIntoViewIfNeeded();
  await first.locator("img.step-screenshot").first().waitFor();
  for (const index of [20, 40, 60, 79]) {
    await page.locator(".step-card").nth(index).scrollIntoViewIfNeeded();
    await page.locator(".step-card").nth(index).locator("img.step-screenshot").first().waitFor();
  }
  await page.waitForFunction(() => !document.querySelector(".step-card:first-child img.step-screenshot"));
  assert.ok(await page.evaluate(() => liveImageUrls.size < 40), "only nearby thumbnails retain object URLs");
  await first.scrollIntoViewIfNeeded();
  await first.locator("img.step-screenshot").first().waitFor();
  await page.waitForFunction(() => !document.querySelector(".step-card:last-child img.step-screenshot"));
  await first.locator(".step-media").first().click();
  await page.locator(".image-preview-close").click();
  assert.ok(await page.evaluate(() => liveImageUrls.size < 40));
  const consolePage = await context.newPage();
  await consolePage.addInitScript(() => {
    globalThis.livePreviewUrls = new Set();
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = blob => { const url = create(blob); livePreviewUrls.add(url); return url; };
    URL.revokeObjectURL = url => { livePreviewUrls.delete(url); revoke(url); };
  });
  await consolePage.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/console.html?previewKey=memory-test-shot`);
  await consolePage.waitForFunction(() => document.querySelector("#console-preview-image")?.naturalWidth > 0);
  await consolePage.locator("#console-close-preview").click();
  assert.equal(await consolePage.evaluate(() => livePreviewUrls.size), 0);
  assert.equal(await consolePage.locator("#console-preview-image").getAttribute("src"), null);
});

test("large recordings bound DOM and thumbnail size while keeping target overlays and selection correct", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 720 });
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    globalThis.fullActionReads = 0;
    chrome.runtime.sendMessage = (message, ...args) => {
      if (message.action === "getActions") fullActionReads++;
      return send(message, ...args);
    };
  });
  await page.goto(`chrome-extension://${worker.url().split("/")[2]}/ui/popup.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ action: "getSchemaState" }));
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ isRecording: false, uiLanguage: "zh_CN" });
    const canvas = new OffscreenCanvas(1920, 1080);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1920, 1080);
    await RecorderMediaStore.putBlob("large-original", await canvas.convertToBlob({ type: "image/jpeg" }));
  });
  const box = { coordinateSpace: "top-viewport", x: 200, y: 100, width: 200, height: 80,
    viewportWidth: 1920, viewportHeight: 1080 };
  await writeActions(worker, Array.from({ length: 1000 }, (_, index) => ({
    id: `large-${index}`, type: "click", timestamp: index + 1, pageName: "page1",
    target: { tagName: "button", accessibleName: `Operation ${index + 1}` },
    screenshotBeforeKey: "large-original", screenshotBeforeHighlight: box,
    screenshotKey: "large-original", screenshotStatus: "captured"
  })));
  await page.waitForFunction(() => document.getElementById("step-count").textContent === "1000");
  await page.locator(".step-screenshot").first().waitFor();
  await page.waitForFunction(() => document.querySelector(".step-screenshot")?.naturalWidth > 0);
  assert.ok(await page.locator(".step-card").count() < 40);
  assert.ok(await page.locator(".step-screenshot").first().evaluate(image => image.naturalWidth <= 320 && image.naturalHeight <= 320));
  assert.ok(await page.evaluate(async () => !!await RecorderMediaStore.getThumbnail("large-original")));
  // Appending to an already-open, empty panel follows the new last step.
  // Bring step 1 back into the virtual window before testing its live patch.
  await page.locator("#steps-container").evaluate(container => { container.scrollTop = 0; });
  await page.waitForFunction(() => document.querySelector(".step-index")?.textContent === "1");
  const reads = await page.evaluate(() => fullActionReads);
  await worker.evaluate(async () => {
    const stored = await chrome.storage.local.get("action:large-0");
    stored["action:large-0"].target.accessibleName = "Updated in place";
    await chrome.storage.local.set(stored);
    chrome.runtime.sendMessage({ action: "stepsUpdated" }).catch(() => {});
  });
  await page.waitForFunction(() => document.querySelector(".step-description")?.textContent.includes("Updated in place"));
  assert.equal(await page.evaluate(() => fullActionReads), reads, "a single-record change should not reread all steps");

  await page.locator(".step-media").first().click();
  await page.locator(".image-preview-full").waitFor({ state: "visible" });
  await page.screenshot({ path: path.join(require("node:os").tmpdir(), "workflow-recorder-highlight-preview.png") });
  const checkOverlay = () => page.evaluate(() => {
    const image = document.querySelector(".image-preview-full");
    const svg = document.querySelector(".image-preview-stage .screenshot-highlight");
    const frame = svg.querySelector("rect").getBoundingClientRect();
    const bounds = image.getBoundingClientRect();
    return { centerX: (frame.x + frame.width / 2 - bounds.x) / bounds.width,
      centerY: (frame.y + frame.height / 2 - bounds.y) / bounds.height,
      sameTransform: image.style.transform === svg.style.transform };
  });
  for (const width of [360, 900]) {
    await page.setViewportSize({ width, height: 720 });
    await page.locator('[data-action="zoom-in"]').click();
    const stage = await page.locator(".image-preview-stage").boundingBox();
    await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
    await page.mouse.down();
    await page.mouse.move(stage.x + stage.width / 2 + 20, stage.y + stage.height / 2 + 15);
    await page.mouse.up();
    const geometry = await checkOverlay();
    assert.ok(Math.abs(geometry.centerX - 300 / 1920) < 0.001);
    assert.ok(Math.abs(geometry.centerY - 140 / 1080) < 0.001);
    assert.equal(geometry.sameTransform, true);
  }
  await page.locator('[data-action="next"]').click();
  await page.waitForFunction(() => document.querySelector(".image-preview-title")?.textContent.includes("操作后"));
  assert.equal(await page.locator(".image-preview-stage .screenshot-highlight").isVisible(), false);
  await page.locator(".image-preview-close").click();
  await page.setViewportSize({ width: 360, height: 720 });
  await page.locator("#step-select-all").check();
  assert.equal(await page.locator("#step-count").innerText(), "1000/1000");
  await page.locator("#step-select-all").uncheck();
  await page.locator("#steps-container").evaluate(container => { container.scrollTop = container.scrollHeight; });
  await page.waitForFunction(() => [...document.querySelectorAll(".step-index")].some(el => el.textContent === "1000"));
  assert.ok(await page.locator(".step-card").count() < 40);
  await page.locator(".step-card.is-last-step .step-media").first().click();
  await page.locator(".image-preview-full").waitFor({ state: "visible" });
  await page.locator('[data-action="next"]').click();
  await page.waitForFunction(() => {
    const title = document.querySelector(".image-preview-title")?.textContent || "";
    return title.includes("1000") && title.includes("操作后");
  });
  assert.equal(await page.locator('[data-action="next"]').isDisabled(), true,
    "a shared image key must not reset gallery navigation to the first step");
  await page.locator(".image-preview-close").click();
  await page.locator(".step-card.is-last-step .step-delete-btn").click();
  await page.locator(".confirm-submit").click();
  await page.waitForFunction(() => document.getElementById("step-count").textContent === "999");
  assert.equal((await readActions(worker)).some(action => action.id === "large-999"), false);
  assert.deepEqual(errors, []);
});

test("media upgrade preserves originals and high-DPI highlights survive export and package import", async (t) => {
  const extensionPath = path.resolve(__dirname, "..");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium", headless: true, reducedMotion: "reduce",
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]
  });
  t.after(() => context.close());
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const extensionURL = `chrome-extension://${worker.url().split("/")[2]}`;
  await page.goto(`${extensionURL}/ui/console.html`);
  await page.evaluate(() => chrome.runtime.sendMessage({ action: "getSchemaState" }));
  const result = await page.evaluate(async () => {
    await RecorderMediaStore.getAllKeys();
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("PlaywrightRecorderDB");
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    const canvas = new OffscreenCanvas(1600, 900);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, 1600, 900);
    const original = await canvas.convertToBlob({ type: "image/jpeg" });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("PlaywrightRecorderDB", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("blobs");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("blobs", "readwrite");
      transaction.objectStore("blobs").put(original, "migration-original");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
    const restored = await RecorderMediaStore.getBlob("migration-original");
    const highlight = { coordinateSpace: "top-viewport", x: 200, y: 100, width: 100, height: 40,
      viewportWidth: 800, viewportHeight: 450 };
    const action = { id: "migration-step", type: "click", timestamp: 1, pageName: "page1",
      target: { tagName: "button", accessibleName: "Target" }, screenshotBeforeKey: "migration-original",
      screenshotBeforeHighlight: highlight, screenshotKey: "migration-original", screenshotStatus: "captured" };
    // A real export reads a published workspace/case. Keep that source referenced
    // while the import's orphan cleanup runs after its publication lock releases.
    await chrome.storage.local.set({ actionOrder: [action.id], [`action:${action.id}`]: action });
    let archive;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { if (blob.type === "application/zip") archive = blob; return create(blob); };
    try { await RecorderExport.exportWorkflow([action], "highlight-export"); }
    finally { URL.createObjectURL = create; }
    const files = fflate.unzipSync(new Uint8Array(await archive.arrayBuffer()));
    async function redPixels(blob) {
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index] > 180 && pixels[index + 1] < 120 && pixels[index + 2] < 120) count++;
      }
      canvas.width = canvas.height = 1;
      return count;
    }
    const before = new Blob([files["highlight-export/screenshots/step-001-click-before.jpg"]], { type: "image/jpeg" });
    const after = new Blob([files["highlight-export/screenshots/step-001-click-after.jpg"]], { type: "image/jpeg" });
    const sourceCase = { id: "source-case", name: "Raw geometry", createdAt: 1, pages: [], actions: [action] };
    const portable = await RecorderCasePackage.buildCasePackage([sourceCase], { asBlob: true });
    await RecorderCasePackage.importCasePackage(portable);
    const list = await chrome.runtime.sendMessage({ action: "listCases" });
    const detail = await chrome.runtime.sendMessage({ action: "getCaseDetails", caseId: list.cases[0].id });
    const imported = detail.case.actions[0];
    await RecorderMediaStore.getThumbnail("migration-original");
    await chrome.storage.session.set({ recorderImagePreviewSequence: { items: [
      { key: "migration-original", alt: "High DPI target", highlight }
    ] } });
    return { preserved: original.size === restored.size, beforeRed: await redPixels(before),
      afterRed: await redPixels(after), rawRed: await redPixels(restored),
      importedHighlight: imported.screenshotBeforeHighlight,
      importedRed: await redPixels(await RecorderMediaStore.getBlob(imported.screenshotBeforeKey)), highlight };
  });
  assert.equal(result.preserved, true);
  assert.ok(result.beforeRed > 50);
  assert.equal(result.afterRed, 0);
  assert.equal(result.rawRed, 0);
  assert.equal(result.importedRed, 0);
  assert.deepEqual(result.importedHighlight, result.highlight);
  await page.goto(`${extensionURL}/ui/console.html?previewKey=migration-original`);
  await page.locator("#console-preview-image").waitFor({ state: "visible" });
  await page.locator("#console-zoom-in").click();
  const geometry = await page.evaluate(() => {
    const image = document.getElementById("console-preview-image");
    const svg = document.querySelector("#console-preview-stage .screenshot-highlight");
    const frame = svg.querySelector("rect").getBoundingClientRect(), bounds = image.getBoundingClientRect();
    return { centerX: (frame.x + frame.width / 2 - bounds.x) / bounds.width,
      centerY: (frame.y + frame.height / 2 - bounds.y) / bounds.height,
      sameTransform: image.style.transform === svg.style.transform };
  });
  assert.ok(Math.abs(geometry.centerX - 250 / 800) < 0.001);
  assert.ok(Math.abs(geometry.centerY - 120 / 450) < 0.001);
  assert.equal(geometry.sameTransform, true);
  assert.equal(await page.evaluate(async () => {
    await RecorderMediaStore.putThumbnail("migration-original", new Blob(["thumbnail"]));
    await RecorderMediaStore.deleteBlob("migration-original");
    return !!await RecorderMediaStore.getThumbnail("migration-original");
  }), false, "deleting the original must delete its thumbnail in the same transaction");
  assert.deepEqual(errors, []);
});
