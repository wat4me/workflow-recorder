const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function element() {
  const listeners = new Map();
  return {
    children: [],
    className: "",
    dataset: {},
    disabled: false,
    hidden: false,
    textContent: "",
    value: "",
    addEventListener(type, listener) { listeners.set(type, listener); },
    removeEventListener() {},
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    trigger(type) { return listeners.get(type)?.(); }
  };
}

test("global execution records link runs back to their saved cases", async () => {
  const list = element();
  const title = element();
  const hint = element();
  const emptyState = element();
  emptyState.querySelector = selector => selector === "p" ? title : hint;
  const countBadge = element();
  const searchInput = element();
  const statusFilter = element();
  const openedRuns = [];
  const openedCases = [];
  const now = Date.now();
  const jobs = {
    "job-live": {
      jobId: "job-live", clientCaseId: "case-1", clientCaseName: "Login flow",
      provider: "codex", status: "completed", updatedAt: now,
      execution: { mode: "execute", resultSummary: { statusCounts: { completed: 1, failed: 0, "not-executed": 0 } } },
      events: [{ category: "tool-use" }]
    },
    "job-deleted": {
      jobId: "job-deleted", clientCaseId: "case-deleted", clientCaseName: "Removed flow",
      provider: "claude", status: "failed", updatedAt: now - 1, execution: { mode: "plan" }, events: []
    }
  };
  const runtimeListeners = new Set();
  const storageListeners = new Set();
  const context = {
    Date,
    Set,
    Object,
    document: { createElement: () => element() },
    chrome: {
      runtime: { onMessage: { addListener: listener => runtimeListeners.add(listener), removeListener: listener => runtimeListeners.delete(listener) } },
      storage: { onChanged: { addListener: listener => storageListeners.add(listener), removeListener: listener => storageListeners.delete(listener) } }
    },
    RecorderI18n: { t: (_key, _values, fallback) => fallback, getLanguage: () => "zh_CN" }
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "shared", "protocol.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "ui", "app", "execution-records.js"), "utf8"), context);
  const records = context.RecorderExecutionRecords.create({
    list,
    emptyState,
    countBadge,
    searchInput,
    statusFilter,
    sendRuntimeMessage: async message => message.action === "agentListJobs"
      ? { success: true, jobs }
      : { success: true, cases: [{ id: "case-1", name: "Login flow" }] },
    onOpenRun: job => openedRuns.push(job),
    onOpenCase: job => openedCases.push(job)
  });
  await records.refresh();

  assert.equal(countBadge.textContent, "2");
  assert.equal(list.children.length, 2);
  assert.equal(list.children[0].dataset.jobId, "job-live");
  assert.equal(list.children[0].dataset.caseId, "case-1");
  const liveActions = list.children[0].children[2];
  await liveActions.children[0].trigger("click");
  await liveActions.children[1].trigger("click");
  assert.equal(openedRuns[0].jobId, "job-live");
  assert.equal(openedRuns[0].clientCaseId, "case-1");
  assert.equal(openedCases[0].clientCaseId, "case-1");

  const deletedActions = list.children[1].children[2];
  assert.equal(deletedActions.children[0].disabled, true);
  assert.equal(deletedActions.children[1].disabled, true);
  assert.match(list.children[1].children[1].children[2].textContent, /关联用例已删除/);

  statusFilter.value = "completed";
  await statusFilter.trigger("change");
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0].dataset.jobId, "job-live");
  records.dispose();
  assert.equal(runtimeListeners.size, 0);
  assert.equal(storageListeners.size, 0);
});
