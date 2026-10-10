/** Read-only saved-case steps and continue-recording flow. */
export function createConsolePreview({ t, sendRuntimeMessage, MESSAGE, notify, reportError, setView }) {
  const targetTabModal = document.getElementById("target-tab-modal");
  const targetTabList = document.getElementById("target-tab-list");
  const targetTabConfirm = document.getElementById("target-tab-confirm");
  let previewCaseId = null;
  let selectedTargetTabId = null;
  let previewRequest = 0;

  const previewStepView = window.RecorderStepView.create({
    stepsContainer: document.getElementById("preview-steps-container"),
    emptyState: document.getElementById("preview-empty-state"),
    stepCountBadge: document.getElementById("preview-step-count"),
    readOnly: true,
    onChanged: () => {}
  });

  function closeTargetTabDialog() {
    targetTabModal.hidden = true;
    targetTabList.replaceChildren();
    selectedTargetTabId = null;
    targetTabConfirm.disabled = true;
  }

  function renderTargetTabs(tabs) {
    targetTabList.replaceChildren();
    let currentWindowId = null;
    for (const tab of tabs) {
      if (tab.windowId !== currentWindowId) {
        currentWindowId = tab.windowId;
        const heading = document.createElement("h3");
        heading.className = "target-tab-group-title";
        heading.textContent = tab.windowId === tabs[0]?.windowId
          ? t("currentWindow", [], "当前窗口")
          : t("otherWindow", [String(tab.windowId)], `窗口 ${tab.windowId}`);
        targetTabList.appendChild(heading);
      }
      const label = document.createElement("label");
      label.className = "target-tab-option";
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "continue-target-tab";
      input.value = String(tab.id);
      input.addEventListener("change", () => {
        selectedTargetTabId = tab.id;
        targetTabConfirm.disabled = false;
      });
      const content = document.createElement("span");
      content.className = "target-tab-option-content";
      const title = document.createElement("strong");
      title.textContent = tab.title || t("untitledPage", [], "未命名页面");
      const url = document.createElement("small");
      try { url.textContent = new URL(tab.url).hostname || tab.url; }
      catch { url.textContent = tab.url || ""; }
      content.append(title, url);
      label.append(input, content);
      targetTabList.appendChild(label);
    }
  }

  async function chooseTargetTab() {
    const tabs = (await chrome.tabs.query({})).filter(tab => {
      try { return /^https?:$/.test(new URL(tab.url || "").protocol); }
      catch { return false; }
    });
    const current = await chrome.windows.getLastFocused().catch(() => null);
    tabs.sort((a, b) => Number(b.windowId === current?.id) - Number(a.windowId === current?.id)
      || a.windowId - b.windowId || a.index - b.index);
    renderTargetTabs(tabs);
    targetTabModal.hidden = false;
  }

  async function resolveUnsavedWorkspace() {
    const state = await sendRuntimeMessage({ action: MESSAGE.listCases });
    if (!state?.success || !state.hasUnsavedChanges) return true;
    const decision = await window.RecorderDialogs.decideRecordingBeforeOpen({
      caseName: document.getElementById("preview-title").textContent || t("continueRecording", [], "继续录制"),
      defaultName: t("unnamedCase", [], "未命名用例")
    });
    if (!decision) return false;
    if (decision.action === "save") {
      if (!decision.name) return false;
      const saved = await sendRuntimeMessage({ action: MESSAGE.saveCase, name: decision.name });
      if (!saved?.success) throw new Error(saved?.error || t("saveCaseFailed", [], "保存用例失败"));
      return true;
    }
    return decision.action === "discard";
  }

  async function continueRecordingInSelectedTab(tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    let recordable = false;
    try { recordable = /^https?:$/.test(new URL(tab?.url || "").protocol); }
    catch { /* Closed or restricted tab. */ }
    if (!recordable) throw new Error(t("targetPageUnavailable", [], "目标页面已关闭或不可录制，请重新选择"));
    if (!(await resolveUnsavedWorkspace())) return;
    const prepared = await sendRuntimeMessage({ action: MESSAGE.prepareSidePanelForTab, tabId });
    if (!prepared?.success) throw new Error(prepared?.error || t("targetPageUnavailable", [], "目标页面不可录制"));
    const loaded = await sendRuntimeMessage({ action: MESSAGE.loadCase, caseId: previewCaseId });
    if (!loaded?.success) throw new Error(loaded?.error || t("loadCaseFailed", [], "加载用例失败"));
    closeTargetTabDialog();
    notify(t("continueRecordingReady", [], "已加载用例，请在目标页面侧边栏中继续录制"));
  }

  async function showCasePreview(summary) {
    const request = ++previewRequest;
    const response = await sendRuntimeMessage({ action: MESSAGE.getCaseDetails, caseId: summary.id }, 30000);
    if (request !== previewRequest) return;
    if (!response?.success) throw new Error(response?.error || t("loadCaseFailed", [], "加载用例失败"));
    setView("preview");
    previewCaseId = response.case.id;
    document.getElementById("preview-title").textContent = response.case.name;
    const url = new URL(window.location.href);
    url.searchParams.set("caseId", previewCaseId);
    history.replaceState(null, "", url.href);
    previewStepView.renderSteps(response.case.actions || [], {});
  }

  document.getElementById("preview-back-btn").addEventListener("click", () => setView("library"));
  document.getElementById("preview-continue-btn").addEventListener("click", () =>
    chooseTargetTab().catch(error => reportError(error.message)));
  document.getElementById("target-tab-close").addEventListener("click", closeTargetTabDialog);
  document.getElementById("target-tab-cancel").addEventListener("click", closeTargetTabDialog);
  targetTabConfirm.addEventListener("click", async () => {
    if (!Number.isInteger(selectedTargetTabId)) return;
    try { await continueRecordingInSelectedTab(selectedTargetTabId); }
    catch (error) { reportError(error.message); }
  });

  return {
    previewStepView,
    showCasePreview,
    disposePreview() {
      ++previewRequest;
      previewStepView.dispose();
      closeTargetTabDialog();
    }
  };
}
