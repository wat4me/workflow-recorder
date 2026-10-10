const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function element() {
  const listeners = new Map();
  return {
    disabled: false,
    hidden: false,
    value: "codex",
    textContent: "",
    dataset: {},
    scrollTop: 0,
    scrollHeight: 0,
    children: [],
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener() {},
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    trigger(type) { return listeners.get(type)?.(); }
  };
}

test("ZCode project directory is restored and saved across page instances", () => {
  const values = new Map([["workflow-recorder-zcode-workspace", "D:\\project\\saved"]]);
  const elements = {
    providerSelect: element(), workspaceField: element(), workspaceInput: element(),
    planButton: element(), executeButton: element(), cancelButton: element(), historySelect: element(),
    status: element(), progress: element(), recordsProgress: element(), followupInput: element(),
    followupButton: element(), events: element(), empty: element()
  };
  elements.providerSelect.value = "zcode";
  const context = {
    Date, Math, JSON, Promise, structuredClone, crypto: webcrypto,
    localStorage: {
      getItem: key => values.get(key) || null,
      setItem: (key, value) => values.set(key, value)
    },
    document: { createElement: () => element() },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
    RecorderI18n: { t: (_key, _values, fallback) => fallback },
    RecorderDialogs: { confirmAction: async () => true, reportError: error => assert.fail(error) },
    RecorderCasePackage: { buildCasePackage: async () => new Uint8Array([1]) }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "app", "case-agent-runner.js"), "utf8"), context);
  const runner = context.RecorderCaseAgentRunner.create({
    ...elements,
    sendRuntimeMessage: async () => ({ success: true, jobs: {} })
  });
  assert.equal(elements.workspaceInput.value, "D:\\project\\saved");
  elements.workspaceInput.value = "D:\\project\\next";
  elements.workspaceInput.trigger("input");
  assert.equal(values.get("workflow-recorder-zcode-workspace"), "D:\\project\\next");
  runner.dispose();
});

test("case Agent runner packages, chunks, commits and starts a ZCode plan in the selected project", async () => {
  const calls = [];
  let runtimeListener;
  const elements = {
    providerField: element(),
    providerSelect: element(),
    workspaceField: element(),
    workspaceInput: element(),
    planButton: element(),
    executeButton: element(),
    cancelButton: element(),
    historySelect: element(),
    status: element(),
    progress: element(),
    recordsProgress: element(),
    followupInput: element(),
    followupButton: element(),
    events: element(),
    empty: element()
  };
  elements.providerSelect.value = "zcode";
  const bytes = new Uint8Array(400000).fill(7);
  const context = {
    Uint8Array,
    Date,
    Math,
    JSON,
    Promise,
    structuredClone,
    crypto: webcrypto,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    document: { createElement: () => element() },
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) { runtimeListener = listener; },
          removeListener() {}
        }
      }
    },
    RecorderI18n: { t: (key, substitutions, fallback) => fallback },
    RecorderDialogs: { confirmAction: async () => true, reportError: error => assert.fail(error) },
    RecorderCasePackage: { buildCasePackage: async () => bytes },
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  vm.runInContext(
    fs.readFileSync(path.join(__dirname, "..", "ui", "app", "case-agent-runner.js"), "utf8"),
    context
  );
  const sendRuntimeMessage = async message => {
    calls.push(message);
    if (message.action === "agentListJobs") return { success: true, jobs: {} };
    if (message.action === "agentCreateJob") {
      return { success: true, message: { payload: { jobId: "job-1", inputId: "input-1", status: "awaiting-input", maxChunkBytes: 262144 } } };
    }
    if (message.action === "agentUploadChunk") {
      return { success: true, message: { payload: { status: "awaiting-input", progress: { bytesReceived: 1, totalBytes: bytes.length } } } };
    }
    if (message.action === "agentCommitAndStart") {
      return { success: true, message: { payload: { status: "running", execution: { mode: "plan" } } } };
    }
    throw new Error(`Unexpected action: ${message.action}`);
  };
  const runner = context.RecorderCaseAgentRunner.create({ ...elements, bridgeAvailable: true, sendRuntimeMessage });
  assert.equal(elements.providerField.hidden, false);
  elements.workspaceInput.value = "D:\\project\\selected";
  await runner.setCase({ id: "case-1", name: "Case one", actions: [{ type: "click" }], pages: [] });
  assert.equal(elements.providerField.hidden, false);
  assert.equal(elements.workspaceField.hidden, false);
  assert.equal(elements.status.hidden, false);
  assert.equal(elements.progress.hidden, false);
  await runner.run("plan");
  assert.equal(calls.filter(call => call.action === "agentUploadChunk").length, 3);
  assert.equal(calls.find(call => call.action === "agentCreateJob").fileName, "recording.swrcase");
  assert.equal(calls.find(call => call.action === "agentCreateJob").provider, "zcode");
  assert.equal(calls.find(call => call.action === "agentCreateJob").workspacePath, "D:\\project\\selected");
  assert.equal(calls.find(call => call.action === "agentUploadChunk").chunk.fileName, "recording.swrcase");
  assert.equal(calls.at(-1).action, "agentCommitAndStart");
  assert.equal(calls.at(-1).mode, "plan");
  assert.equal(elements.status.dataset.state, "running");
  assert.equal(typeof runtimeListener, "function");
  runner.dispose();
});

  test("without Bridge the runner only copies a self-contained prompt and creates no job", async () => {
  const calls = [];
  const copied = [];
  const notices = [];
  const elements = {
    providerField: element(), providerSelect: element(), workspaceField: element(), workspaceInput: element(),
    executeButton: element(), cancelButton: element(), historySelect: element(), modeHint: element(),
    status: element(), progress: element(), recordsProgress: element(), followupInput: element(),
    followupButton: element(), events: element(), empty: element(), recordsLink: element()
  };
  elements.providerSelect.value = "claude";
  const context = {
    Date, Math, JSON, Promise, structuredClone, crypto: webcrypto,
    document: { createElement: () => element() },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
    RecorderI18n: { t: (_key, _values, fallback) => fallback, getLanguage: () => "zh_CN" },
    RecorderDialogs: {
      confirmAction: async () => assert.fail("manual handoff must not request execution confirmation"),
      notify: message => notices.push(message),
      reportError: error => assert.fail(error)
    },
    RecorderCasePackage: { buildCasePackage: async () => assert.fail("manual handoff must not build an archive") }
  };
  context.globalThis = context;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "lib", "doc-generator.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "app", "case-agent-runner.js"), "utf8"), context);
  const runner = context.RecorderCaseAgentRunner.create({
    ...elements,
    bridgeAvailable: false,
    writeClipboard: async text => copied.push(text),
    sendRuntimeMessage: async message => {
      calls.push(message);
      if (message.action === "agentListJobs") return { success: true, jobs: {} };
      throw new Error(`Unexpected action: ${message.action}`);
    }
  });
  await runner.setCase({
    id: "case-manual",
    name: "Manual case",
    pages: [{ name: "page1", url: "https://example.test" }],
    actions: [{
      id: "step-1",
      type: "click",
      pageName: "page1",
      screenshotKey: "local-blob",
      target: { tagName: "button", role: "button", accessibleName: "提交", outerHTML: "<button>提交</button>" }
    }]
  });
  await runner.run("execute");
  assert.equal(copied.length, 1);
  assert.doesNotMatch(copied[0], /Workflow Recorder 手动交接/);
  assert.match(copied[0], /- 用例：Manual case/);
  assert.doesNotMatch(copied[0], /目标工具：Claude/);
  assert.doesNotMatch(copied[0], /不要写入结果文件|不附带截图图片/);
  assert.match(copied[0], /^# Recorded Workflow$/m);
  assert.match(copied[0], /^\[page1\] https:\/\/example\.test$/m);
  assert.match(copied[0], /click <button> -> button "提交"/);
  assert.doesNotMatch(copied[0], /```json|"actions"\s*:|"hasScreenshot"\s*:/);
  assert.doesNotMatch(copied[0], /local-blob/);
  assert.doesNotMatch(copied[0], /test-base|\bskills?\b/i);
  assert.equal(calls.some(call => call.action === "agentCreateJob" || call.action === "agentUploadChunk" || call.action === "agentCommitAndStart"), false);
  assert.equal(notices.length, 1);
  assert.equal(elements.status.dataset.state, "manual");
  assert.equal(elements.providerField.hidden, true);
  assert.equal(elements.workspaceField.hidden, true);
  assert.equal(elements.cancelButton.hidden, true);
  assert.equal(elements.status.hidden, true);
  assert.equal(elements.modeHint.hidden, false);
  assert.match(elements.modeHint.textContent, /页面、操作步骤和控件上下文/);
  assert.doesNotMatch(elements.modeHint.textContent, /test-base|\bskills?\b/i);
  assert.match(elements.modeHint.textContent, /你使用的 AI 工具/);
  assert.doesNotMatch(elements.modeHint.textContent, /Bridge/);
  assert.equal(elements.progress.hidden, true);
  assert.equal(elements.recordsLink.hidden, true);
  assert.equal(elements.executeButton.hidden, false);
  assert.equal(elements.executeButton.textContent, "复制给AI");
  runner.dispose();
});

test("WorkBuddy execute confirmation explains the paste-only handoff", async () => {
  const calls = [];
  const confirmations = [];
  const elements = {
    providerSelect: element(), planButton: element(), executeButton: element(), cancelButton: element(),
    historySelect: element(), status: element(), progress: element(), recordsProgress: element(),
    followupInput: element(), followupButton: element(), events: element(), empty: element()
  };
  elements.providerSelect.value = "workbuddy";
  const context = {
    Uint8Array, Date, Math, JSON, Promise, structuredClone, crypto: webcrypto,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    document: { createElement: () => element() },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
    RecorderI18n: { t: (_key, _values, fallback) => fallback },
    RecorderDialogs: {
      confirmAction: async options => { confirmations.push(options); return false; },
      reportError: error => assert.fail(error)
    },
    RecorderCasePackage: { buildCasePackage: async () => new Uint8Array([1]) }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "app", "case-agent-runner.js"), "utf8"), context);
  const runner = context.RecorderCaseAgentRunner.create({
    ...elements,
    bridgeAvailable: true,
    sendRuntimeMessage: async message => { calls.push(message); return { success: true, jobs: {} }; }
  });
  await runner.setCase({ id: "case-1", name: "Case one", actions: [{ type: "click" }], pages: [] });
  elements.providerSelect.value = "workbuddy";
  await runner.run("execute");
  assert.equal(confirmations[0].title, "交接到 WorkBuddy");
  assert.match(confirmations[0].message, /无需下载或 @ 上传录制包/);
  assert.equal(confirmations[0].confirmText, "打开 WorkBuddy");
  assert.equal(calls.filter(call => call.action !== "agentListJobs").length, 0);
  runner.dispose();
});

test("case Agent runner can select a run supplied by the global execution-record view", async () => {
  const elements = {
    providerSelect: element(), planButton: element(), executeButton: element(), cancelButton: element(),
    historySelect: element(), status: element(), progress: element(), recordsProgress: element(),
    followupInput: element(), followupButton: element(), events: element(), empty: element()
  };
  const context = {
    Uint8Array, Date, Math, JSON, Promise, structuredClone, crypto: webcrypto,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    document: { createElement: () => element() },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
    RecorderI18n: { t: (_key, _values, fallback) => fallback },
    RecorderDialogs: { confirmAction: async () => true, reportError: error => assert.fail(error) },
    RecorderCasePackage: { buildCasePackage: async () => new Uint8Array([1]) }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "app", "case-agent-runner.js"), "utf8"), context);
  const jobs = {
    newest: { jobId: "newest", clientCaseId: "case-1", provider: "codex", status: "completed", updatedAt: 2, events: [] },
    selected: {
      jobId: "selected", clientCaseId: "case-1", provider: "claude", status: "failed", updatedAt: 1,
      execution: { mode: "execute" }, events: []
    }
  };
  const runner = context.RecorderCaseAgentRunner.create({
    ...elements,
    sendRuntimeMessage: async () => ({ success: true, jobs })
  });
  await runner.setCase({ id: "case-1", name: "Case one", actions: [], pages: [] }, "selected");
  assert.equal(elements.historySelect.value, "selected");
  assert.equal(elements.providerSelect.value, "claude");
  assert.equal(elements.providerSelect.disabled, true);
  assert.equal(elements.status.dataset.state, "failed");
  runner.dispose();
});

test("case Agent runner lists independent runs and submits follow-up context", async () => {
  const calls = [];
  const elements = {
    providerSelect: element(),
    planButton: element(),
    executeButton: element(),
    cancelButton: element(),
    historySelect: element(),
    status: element(),
    progress: element(),
    recordsProgress: element(),
    followupInput: element(),
    followupButton: element(),
    events: element(),
    empty: element()
  };
  const context = {
    Uint8Array,
    Date,
    Math,
    JSON,
    Promise,
    structuredClone,
    crypto: webcrypto,
    btoa: value => Buffer.from(value, "binary").toString("base64"),
    document: { createElement: () => element() },
    chrome: { runtime: { onMessage: { addListener() {}, removeListener() {} } } },
    RecorderI18n: { t: (key, substitutions, fallback) => fallback },
    RecorderDialogs: { confirmAction: async () => true, reportError: error => assert.fail(error) },
    RecorderCasePackage: { buildCasePackage: async () => new Uint8Array([1]) }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "app", "case-agent-runner.js"), "utf8"), context);
  const jobs = {
    "job-new": {
      jobId: "job-new", clientCaseId: "case-1", provider: "codex", status: "completed",
      createdAt: Date.now(), updatedAt: Date.now(), execution: { mode: "plan" }, attempts: [{ attempt: 1 }],
      events: [{
        timestamp: Date.now(), category: "tool-result", level: "info",
        data: { text: "调用 Playwright 浏览器测试工具完成", tool: "Playwright", detail: "npx playwright test login.spec.js", exitCode: 0 }
      }]
    },
    "job-old": {
      jobId: "job-old", clientCaseId: "case-1", provider: "claude", status: "failed",
      createdAt: Date.now() - 1000, updatedAt: Date.now() - 1000, execution: { mode: "execute" }, attempts: [{ attempt: 1 }], events: []
    }
  };
  const sendRuntimeMessage = async message => {
    calls.push(message);
    if (message.action === "agentListJobs") return { success: true, jobs };
    if (message.action === "agentFollowup") {
      return { success: true, message: { payload: { jobId: message.jobId, status: "running", attempt: 2, execution: { mode: "plan" } } } };
    }
    throw new Error(`Unexpected action: ${message.action}`);
  };
  const runner = context.RecorderCaseAgentRunner.create({ ...elements, bridgeAvailable: true, sendRuntimeMessage });
  await runner.setCase({ id: "case-1", name: "Case one", actions: [{ type: "click" }], pages: [] });
  assert.equal(elements.historySelect.children.length, 2);
  assert.equal(elements.historySelect.children[0].value, "job-new");
  assert.equal(elements.providerSelect.disabled, true);
  const eventBody = elements.events.children[0].children[1];
  assert.equal(eventBody.className, "agent-event-body");
  assert.match(eventBody.children[0].textContent, /Playwright/);
  assert.equal(eventBody.children[1].className, "agent-event-meta");
  assert.equal(eventBody.children[1].children[0].textContent, "Playwright");
  assert.match(eventBody.children[1].children[1].textContent, /退出码：0/);
  assert.equal(eventBody.children[2].className, "agent-event-command");
  assert.match(eventBody.children[2].textContent, /npx playwright test login\.spec\.js/);
  assert.equal(elements.events.children[0].dataset.tool, "Playwright");
  elements.providerSelect.value = "zcode";
  elements.followupInput.value = "补充测试地址";
  await elements.followupButton.trigger("click");
  const followup = calls.find(call => call.action === "agentFollowup");
  assert.equal(followup.jobId, "job-new");
  assert.equal(followup.message, "补充测试地址");
  assert.equal(elements.providerSelect.value, "codex");
  runner.dispose();
});
