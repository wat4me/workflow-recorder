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
        <div id="drag-source" style="position:absolute;z-index:10;left:40px;top:320px;width:100px;height:60px;background:#93c5fd;user-select:none;">Task card</div>
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
  await page.locator("#case-search-scope").selectOption("all");
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

test("recording download fits the toolbar and works as text or an icon", async (t) => {
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
      // Wait for both layout and the ResizeObserver-driven label measurement.
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
          labelVisible: !!label && getComputedStyle(label).display !== "none",
          title: button.title,
          accessibleName: button.getAttribute("aria-label")
        };
      });
      assert.equal(layout.fits, true, `${language} toolbar fits at ${width}px`);
      const name = language === "zh_CN" ? "下载录制结果" : "Download recording";
      if (narrow) {
        assert.equal(layout.title, name);
        assert.equal(layout.accessibleName, name);
        if (width === 560) assert.equal(layout.labelVisible, true);
        downloadWidths.set(layout.labelVisible, width);
      } else {
        await more.click();
        assert.equal(await menuDownload.isVisible(), true);
        assert.equal((await menuDownload.innerText()).trim(), name);
        await panel.keyboard.press("Escape");
        assert.equal(await menuDownload.isHidden(), true);
      }
    }

    assert.equal(downloadWidths.has(true), true);
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
  assert.deepEqual(errors, []);
});

test("recording controls use the light theme and expose screenshot labels responsively", async (t) => {
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
      if (width === 1000) assert.equal(layout.iconOnly, false);
      checkedIcon ||= layout.iconOnly;
      const label = language === "zh_CN" ? "更新操作后截图" : "Update after-action screenshot";
      assert.equal(await manual.getAttribute("aria-label"), label);
      assert.equal((await manual.locator(".btn-label").textContent()).trim(), label);
      assert.match(await manual.getAttribute("title"), /当前页面最后一个操作.*不改变操作前截图|last operation on the current page, without changing its before-action screenshot/);
    }
  }
  assert.equal(checkedIcon, true, "a narrow panel collapses the screenshot label");

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
  assert.equal(await panel.locator(".copy-task-info").evaluate(button => getComputedStyle(button).color), "rgb(255, 255, 255)");
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
    uiLanguage: "zh_CN", recordingConsentVersion: 2, isRecording: false
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
    recordingConsentVersion: 2
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
  assert.equal(recorderAfterInvocation, "ready");
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

  await page.locator("#open-async-dialog").click();
  await page.locator('[role="progressbar"]').waitFor({ state: "visible" });
  const stability = await serviceWorker.evaluate((tabId) => chrome.tabs.sendMessage(
    tabId,
    { action: "waitForPageStable", options: { timeoutMs: 2500, quietMs: 300 } },
    { frameId: 0 }
  ), rootTabId);
  assert.equal(stability.stable, true);
  assert.ok(stability.waitedMs >= 300);
  assert.equal(await page.locator("#async-result").innerText(), "Loaded result");

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
    await countRedPixels(serviceWorker, actions[1].screenshotBeforeKey) > 50,
    "the before screenshot should contain the recorded input's red target frame"
  );

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
      const request = indexedDB.open("PlaywrightRecorderDB", 1);
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
    /^case_import_/.test(item.id) && item.name === "菜单基础步骤"
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
    )).recordingConsentVersion === 2,
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
    recordingConsentVersion: 2,
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
    isRecording: false, uiLanguage: "zh_CN", recordingConsentVersion: 2
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
  await page.locator("#effect-action").click();
  await waitForActions(worker, current => current.some(action => action.target?.id === "effect-action"));
  await panel.evaluate(() => chrome.runtime.sendMessage({ action: "toggleRecording", start: false }));

  const steps = await readActions(worker);
  assert.ok(steps.length >= 2, "the steps were recorded");
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
