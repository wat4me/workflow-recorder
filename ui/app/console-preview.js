/** Saved-case steps, annotation editing and continue-recording flow. */
export function createConsolePreview({ t, sendRuntimeMessage, MESSAGE, notify, reportError, setView }) {
  const targetTabModal = document.getElementById("target-tab-modal");
  const targetTabList = document.getElementById("target-tab-list");
  const targetTabConfirm = document.getElementById("target-tab-confirm");
  const intentButton = document.getElementById("preview-intent-btn");
  const continueButton = document.getElementById("preview-continue-btn");
  const intentPane = document.getElementById("preview-intent-pane");
  const intentOverview = intentPane.querySelector(".preview-intent-overview");
  const intentList = document.getElementById("preview-intent-list");
  const addIntent = document.getElementById("preview-add-intent-btn");
  const { open, stepRanges, firstUnannotatedRange, stepLabel, stepMarker, stepEndMarker } = globalThis.RecorderIntentDialog;
  const targetTabCancel = document.getElementById("target-tab-cancel");
  let closeTargetTabModal = null;
  let openingCase = false;
  let previewCase = null;
  let editor = null;
  let ranges = [];
  let starts = new Map();
  let selectedTargetTabId = null;
  let previewRequest = 0;
  let revealFrame = 0;
  const stepsContainer = document.getElementById("preview-steps-container");
  const { overlappingSteps, selectionRange, annotateRangeLabel, confirmReplace } = globalThis.RecorderIntentDialog;
  /**
   * Range picking while the annotation editor is open: click a start and an end
   * card, drag across cards, or Shift+click to extend. Picked ranges go through
   * the editor's own start/end fields, so typing and picking validate alike.
   */
  let picker = null;

  const previewStepView = window.RecorderStepView.create({
    stepsContainer: document.getElementById("preview-steps-container"),
    emptyState: document.getElementById("preview-empty-state"),
    stepCountBadge: document.getElementById("preview-step-count"),
    readOnly: true,
    selectable: true,
    onChanged: () => {},
    stepMarker: index => stepMarker(previewCase?.intent?.steps, index),
    onStepMarkerEdit(index) {
      if (!editor) editAnnotation(starts.get(index)).catch(error => reportError(error.message));
    }
  });
  previewStepView.setStepEndMarker?.(index =>
    stepEndMarker(previewCase?.intent?.steps, index, previewCase?.actions.length || 0));
  previewStepView.setSelectionListener(indices => onSelection(indices));
  // The add button's label is set from code, so a language switch re-derives it.
  window.addEventListener("recorderLanguageChanged", () => onSelection(previewStepView.selectedIndices()));

  function renderAnnotations() {
    const steps = previewCase?.intent?.steps || [];
    const count = previewCase?.actions.length || 0;
    ranges = stepRanges(steps, count);
    starts = new Map(ranges.map((range, index) => [range.from - 1, index]));
    intentButton.disabled = !count;
    // Picking can take over annotated steps, so a new test step is always possible.
    addIntent.hidden = !count;
    intentOverview.querySelector(".preview-intent-empty").hidden = steps.length > 0 || !count;
    intentList.replaceChildren(...steps.map((step, index) => {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "intent-picker-item";
      const text = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = stepLabel(step, index);
      const range = document.createElement("small");
      const { from, to } = ranges[index];
      range.textContent = from <= to
        ? t("intentStepRange", [String(from), String(to)], `第 ${from}–${to} 步`)
        : t("intentPendingRange", [], "等待录制");
      text.append(title, range);
      const edit = document.createElement("span");
      edit.className = "intent-picker-edit";
      edit.textContent = t("edit", [], "编辑");
      button.append(text, edit);
      button.addEventListener("click", () => editAnnotation(index).catch(error => reportError(error.message)));
      item.append(button);
      return item;
    }));
  }

  function setIntentOpen(open) {
    intentPane.hidden = !open;
    intentButton.setAttribute("aria-expanded", String(open));
    intentButton.classList.toggle("is-active", open);
    if (!open) previewStepView.highlightRange();
  }

  function revealRange(start, end, edge) {
    cancelAnimationFrame(revealFrame);
    const valid = Number.isInteger(start) && Number.isInteger(end)
      && start >= 1 && start <= end && end <= previewCase.actions.length;
    previewStepView.highlightRange(valid ? start - 1 : null, valid ? end - 1 : null,
      valid ? (edge === "end" ? end : start) - 1 : null);
  }

  function showEditedRange(start, end, edge) {
    revealRange(start, end, edge);
    // Give the two panes their final dimensions after the editor mounts.
    revealFrame = requestAnimationFrame(() => revealRange(start, end, edge));
  }

  /** Asks once per test step before a selected, picked or typed range replaces it. */
  function confirmDiscard(steps, confirmText, confirmed = picker?.confirmed) {
    return confirmReplace(steps, {
      allSteps: previewCase?.intent?.steps || [], stepCount: previewCase?.actions.length || 0,
      confirmText, confirmed
    });
  }

  /**
   * Checking steps turns the pane's add button into "标注第 2–5 步". Steps left
   * unchecked inside that range are tinted, since the test step includes them.
   */
  function onSelection(indices) {
    if (editor || !previewCase) return;
    const range = selectionRange(indices);
    addIntent.textContent = range ? annotateRangeLabel(range) : t("intentNewStep", [], "新增测试步骤");
    addIntent.title = range?.gaps ? t("intentAnnotateGapHint", [], "包含中间未勾选的步骤") : "";
    addIntent.classList.toggle("btn-primary", Boolean(range));
    addIntent.classList.toggle("btn-secondary", !range);
    stepsContainer.classList.toggle("has-range-gaps", Boolean(range?.gaps));
    previewStepView.highlightRange(range?.gaps ? range.start - 1 : null, range?.gaps ? range.end - 1 : null);
    if (range && intentPane.hidden) setIntentOpen(true);
  }

  /** Annotates the checked steps: confirm what they replace, then open the editor on them. */
  async function annotateSelection() {
    const range = selectionRange(previewStepView.selectedIndices());
    if (!range || !previewCase || editor) return;
    const confirmed = new Set();
    const overlapping = overlappingSteps(previewCase.intent?.steps, range, previewCase.actions.length);
    if (!(await confirmDiscard(overlapping, t("intentOverlapDiscardContinue", [], "继续选择"), confirmed))) return;
    previewStepView.clearSelection();
    await editAnnotation(null, { range, confirmed });
  }

  function cardIndexAt(target) {
    // Screenshots, markers and toggles keep their own click behaviour.
    if (!(target instanceof Element) || target.closest("button, a, input, select, textarea, summary, img")) return null;
    const card = target.closest(".step-card[data-step-index]");
    return card && stepsContainer.contains(card) ? Number(card.dataset.stepIndex) : null;
  }

  function pickRange(from, to) {
    if (!picker) return;
    picker.start = Math.min(from, to);
    picker.end = Math.max(from, to);
    picker.api?.setRange(picker.start + 1, picker.end + 1);
  }

  /** A finished pick: warn when it now covers another test step, or undo it. */
  async function commitPick() {
    if (!picker) return;
    const current = picker;
    const steps = previewCase?.intent?.steps || [];
    const except = Number.isInteger(current.stepIndex) ? steps[current.stepIndex] : null;
    const overlapping = overlappingSteps(steps, { start: current.start + 1, end: current.end + 1 },
      previewCase.actions.length, except);
    if (!overlapping.length || await confirmDiscard(overlapping, t("intentOverlapDiscardContinue", [], "继续选择"))) {
      current.committed = { start: current.start, end: current.end };
      return;
    }
    if (picker !== current) return;
    current.anchor = null;
    current.awaitingEnd = false;
    pickRange(current.committed.start, current.committed.end);
  }

  function startPicking(stepIndex, initial, confirmed = new Set()) {
    picker = {
      stepIndex, api: null, anchor: null, awaitingEnd: false, dragging: false, moved: false,
      start: initial.start - 1, end: initial.end - 1, confirmed,
      committed: { start: initial.start - 1, end: initial.end - 1 }
    };
    stepsContainer.classList.add("is-picking-range");
    const hint = document.createElement("p");
    hint.className = "preview-range-hint";
    hint.textContent = t("intentPickHint", [], "在左侧点击起始步和结束步，或按住鼠标拖选；按住 Shift 点击可扩展范围。");
    picker.hint = hint;
    intentPane.prepend(hint);
  }

  function stopPicking() {
    picker?.hint.remove();
    picker = null;
    stepsContainer.classList.remove("is-picking-range");
  }

  stepsContainer.addEventListener("pointerdown", event => {
    if (!picker || event.button !== 0) return;
    const index = cardIndexAt(event.target);
    if (index === null) return;
    event.preventDefault();
    if (event.shiftKey) {
      picker.anchor ??= picker.start;
      pickRange(picker.anchor, index);
      picker.awaitingEnd = false;
    } else if (picker.awaitingEnd) {
      pickRange(picker.anchor, index);
      picker.awaitingEnd = false;
    } else {
      picker.anchor = index;
      pickRange(index, index);
      picker.awaitingEnd = true;
    }
    picker.dragging = true;
    picker.moved = false;
  });
  document.addEventListener("pointermove", event => {
    if (!picker?.dragging) return;
    const index = cardIndexAt(document.elementFromPoint(event.clientX, event.clientY));
    if (index === null || (index === picker.end && index === picker.start)) return;
    if (index !== picker.anchor) picker.moved = true;
    if (picker.moved) pickRange(picker.anchor, index);
  });
  document.addEventListener("pointerup", () => {
    if (!picker?.dragging) return;
    picker.dragging = false;
    // A drag is a complete range; a plain click waits for the end card.
    if (picker.moved) picker.awaitingEnd = false;
    commitPick().catch(error => reportError(error.message));
  });

  async function editAnnotation(stepIndex, { range = null, confirmed = new Set() } = {}) {
    if (!previewCase || editor) return;
    const currentCase = previewCase;
    const { id, intent, actions } = currentCase;
    const focused = Number.isInteger(stepIndex);
    // Every step may already be annotated; the tester then picks the range to
    // take over, and is told which annotation it replaces.
    const initialRange = focused ? null : range
      ? { start: range.start, end: range.end }
      : firstUnannotatedRange(intent?.steps, actions.length) || { start: actions.length, end: actions.length };
    // The checkboxes give way to range picking while the editor is open.
    previewStepView.clearSelection();
    if (!actions.length) return;
    const existing = focused ? stepRanges(intent?.steps, actions.length)[stepIndex] : null;
    const controller = new AbortController();
    editor = controller;
    setIntentOpen(true);
    intentOverview.hidden = true;
    intentButton.disabled = true;
    continueButton.disabled = true;
    startPicking(stepIndex, focused ? { start: existing.from, end: existing.to } : initialRange, confirmed);
    try {
      const result = await open({
        intent, stepCount: actions.length, actions, stepIndex, initialRange,
        container: intentPane, signal: controller.signal,
        onReady: api => { if (picker) picker.api = api; },
        resolveOverlap: steps => confirmDiscard(steps, t("intentOverlapDiscardSave", [], "丢弃并保存")),
        onRangeChange(start, end, edge) {
          // Typed values move the picked range too, so the next Shift+click
          // extends what the fields show.
          if (picker && Number.isInteger(start) && Number.isInteger(end)) {
            picker.start = Math.min(start, end) - 1;
            picker.end = Math.max(start, end) - 1;
          }
          showEditedRange(start, end, edge);
        },
        async save(intent) {
          const response = await sendRuntimeMessage({
            action: MESSAGE.updateCaseIntent, caseId: id, intent, expectedIntent: currentCase.intent
          });
          if (response?.success && previewCase === currentCase) currentCase.intent = response.intent;
          return response;
        }
      });
      if (result && previewCase === currentCase) notify(t("intentSaved", [], "已保存标注"));
    } finally {
      if (editor === controller) {
        cancelAnimationFrame(revealFrame);
        stopPicking();
        editor = null;
        intentOverview.hidden = false;
        continueButton.disabled = false;
        renderAnnotations();
        previewStepView.highlightRange();
        onSelection(previewStepView.selectedIndices());
        if (intentPane.contains(document.activeElement) || document.activeElement === document.body) {
          (intentList.querySelectorAll("button")[stepIndex] || (addIntent.hidden ? intentButton : addIntent))
            .focus({ preventScroll: true });
        }
      }
    }
  }

  function closeTargetTabDialog() {
    if (targetTabModal.hidden) return;
    closeTargetTabModal?.();
    closeTargetTabModal = null;
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
        targetTabConfirm.disabled = openingCase;
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
    targetTabList.hidden = tabs.length === 0;
    document.getElementById("target-tab-empty").hidden = tabs.length > 0;
    targetTabModal.hidden = false;
    closeTargetTabModal = window.RecorderDialogs.openModal(targetTabModal, {
      onDismiss: () => { if (!openingCase) closeTargetTabDialog(); }, remove: false
    });
    (targetTabList.querySelector("input") || targetTabCancel).focus();
  }

  async function resolveUnsavedWorkspace(tabId, caseName) {
    let state = await sendRuntimeMessage({ action: MESSAGE.getDraftState, tabId });
    if (!state?.success) throw new Error(state?.error || t("loadCaseFailed", [], "加载用例失败"));
    if (state.draftId) {
      if (!state.drafts.some(draft => draft.id === state.draftId && draft.hasUnsavedChanges)) return true;
    } else {
      // Older profiles may still have a workspace that has not been bound to a tab.
      state = await sendRuntimeMessage({ action: MESSAGE.getDraftState });
      if (!state?.success) throw new Error(state?.error || t("loadCaseFailed", [], "加载用例失败"));
      if (state.draftId || !state.actions.length || state.state.activeCaseId) return true;
    }
    const decision = await window.RecorderDialogs.decideRecordingBeforeOpen({
      caseName,
      defaultName: t("unnamedCase", [], "未命名用例")
    });
    if (!decision) return false;
    if (decision.action === "save" && decision.name) {
      if (state.draftId && !state.active) {
        const selected = await sendRuntimeMessage({ action: MESSAGE.selectDraft, tabId, draftId: state.draftId });
        if (!selected?.success) throw new Error(selected?.error || t("loadCaseFailed", [], "加载用例失败"));
      }
      const saved = await sendRuntimeMessage({ action: MESSAGE.saveCase, name: decision.name,
        workspaceDraftId: state.draftId });
      if (!saved?.success) throw new Error(saved?.error || t("saveCaseFailed", [], "保存用例失败"));
      return true;
    }
    return decision.action === "discard";
  }

  async function continueRecordingInSelectedTab(tabId, savedCase) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    let recordable = false;
    try { recordable = /^https?:$/.test(new URL(tab?.url || "").protocol); }
    catch { /* Closed or restricted tab. */ }
    if (!recordable) throw new Error(t("targetPageUnavailable", [], "目标页面已关闭或不可录制，请重新选择"));
    if (!(await resolveUnsavedWorkspace(tabId, savedCase.name))) return;
    const loaded = await sendRuntimeMessage({ action: MESSAGE.loadCase, caseId: savedCase.id, tabId }, 30000);
    if (!loaded?.success) throw new Error(loaded?.error || t("loadCaseFailed", [], "加载用例失败"));
    closeTargetTabDialog();
    // Keep the open call on the extension page that received the click. A
    // worker's message gesture expires at the first asynchronous operation.
    try {
      await chrome.sidePanel.setOptions({ tabId, path: "ui/popup.html", enabled: true });
      await chrome.sidePanel.open({ tabId });
      await chrome.tabs.update(tabId, { active: true });
    } catch (error) {
      console.warn("[Workbench] Could not open the recording side panel:", error);
      notify(t("continueRecordingOpenPanel", [], "用例已加载。请到目标页面点击扩展图标，打开侧边栏继续录制。"));
      return;
    }
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    notify(t("continueRecordingReady", [], "已加载用例，请在目标页面侧边栏中继续录制"));
  }

  async function showCasePreview(summary, { annotate = false } = {}) {
    const request = ++previewRequest;
    const response = await sendRuntimeMessage({ action: MESSAGE.getCaseDetails, caseId: summary.id }, 30000);
    if (request !== previewRequest) return;
    if (!response?.success) throw new Error(response?.error || t("loadCaseFailed", [], "加载用例失败"));
    setView("preview");
    previewCase = { ...response.case, actions: response.case.actions || [] };
    document.getElementById("preview-title").textContent = response.case.name;
    const url = new URL(window.location.href);
    url.searchParams.set("caseId", previewCase.id);
    history.replaceState(null, "", url.href);
    renderAnnotations();
    setIntentOpen(annotate || ranges.length > 0);
    previewStepView.renderSteps(previewCase.actions, {});
  }

  document.getElementById("preview-back-btn").addEventListener("click", () => setView("library"));
  intentButton.addEventListener("click", () => setIntentOpen(intentPane.hidden));
  addIntent.addEventListener("click", () => (previewStepView.selectedIndices().length ? annotateSelection() : editAnnotation())
    .catch(error => reportError(error.message)));
  continueButton.addEventListener("click", () =>
    chooseTargetTab().catch(error => reportError(error.message)));
  targetTabCancel.addEventListener("click", closeTargetTabDialog);
  targetTabConfirm.addEventListener("click", async () => {
    if (openingCase || !previewCase || !Number.isInteger(selectedTargetTabId)) return;
    openingCase = true;
    targetTabConfirm.disabled = true;
    targetTabCancel.disabled = true;
    try { await continueRecordingInSelectedTab(selectedTargetTabId, previewCase); }
    catch (error) { reportError(error.message); }
    finally {
      openingCase = false;
      targetTabCancel.disabled = false;
      targetTabConfirm.disabled = !Number.isInteger(selectedTargetTabId);
    }
  });

  return {
    showCasePreview,
    disposePreview() {
      ++previewRequest;
      cancelAnimationFrame(revealFrame);
      const currentEditor = editor;
      editor = null;
      stopPicking();
      currentEditor?.abort();
      intentOverview.hidden = false;
      continueButton.disabled = false;
      previewCase = null;
      setIntentOpen(false);
      previewStepView.dispose();
      closeTargetTabDialog();
    }
  };
}
