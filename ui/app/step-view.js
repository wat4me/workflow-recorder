/** Shared step cards for the side panel and saved-case previews. */
import { attachStepMedia } from "./step-media.js";
import { iconSvg } from "../lib/icons.js";
import { createVirtualWindow } from "../lib/virtual-window.js";

if (!window.RecorderStepView) {
  let viewSequence = 0;
  function create(options) {
    const {
      stepsContainer, emptyState, stepCountBadge, selectAllSteps,
      deleteSelectedStepsBtn, downloadDocBtn, saveCurrentCaseBtn, onChanged,
      readOnly = false
    } = options;
    const { t } = globalThis.RecorderI18n;
    const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
    const { getBlob, sendRuntimeMessage } = globalThis.RecorderBridge;
    const { confirmAction, notify, reportError } = globalThis.RecorderDialogs;
    const { openImagePreview } = globalThis.RecorderImagePreview;
    const objectUrls = new Set();
    const cardEntries = new Map();
    const pendingLoads = new WeakMap();
    const mediaUrls = new WeakMap();
    const selectedActionIds = new Set();
    let workspaceContext = {};
    const expansionOverrides = new Map();
    const viewId = ++viewSequence;
    let nextMediaId = 0;
    let screenshotsExpandedDefault = true;
    const CAPTURE_LABELS = {
      pending: () => t("captureStateWaiting", [], "等待截图"),
      "capturing-auto": () => t("captureStateAuto", [], "系统截图中"),
      "capturing-manual": () => t("captureStateManual", [], "手动截图中"),
      captured: () => t("captureStateCaptured", [], "已截图"),
      // A skip is a decision, not a miss: the recorder chose not to take this
      // frame. A failure is a miss. They used to share one word.
      skipped: () => t("captureStateSkipped", [], "无需截图"),
      recapturing: () => t("captureStateRecapturing", [], "重拍中"),
      "recapture-failed": () => t("captureStateRecaptureFailed", [], "重拍失败，仍显示上次截图"),
      failed: () => t("captureStateFailed", [], "无截图")
    };
    const CAPTURE_REASON_LABELS = {
      pageClosed: () => t("captureReasonPageClosed", [], "录制页面已关闭"),
      workerRestart: () => t("captureReasonWorkerRestart", [], "后台重启中断"),
      captureFailed: () => t("captureReasonCaptureFailed", [], "未能读取页面画面")
    };
    // Causes for a deliberate skip. They are not error codes, so they have no
    // entry in CAPTURE_REASON_LABELS above.
    const SKIPPED_REASON_LABELS = {
      "opens-child-page": () => t("captureReasonOpensChildPage", [], "点击打开了新页面")
    };
    // The saved-case preview mounts this view too and never records, so the panel
    // has to say when it is recording: only then is the newest step the one the
    // user is waiting for. It also scopes the "flow ends here" index highlight.
    let recording = false;
    let firstRender = true;
    let currentActions = [];
    let currentCapture = {};
    let windowFrame = 0;
    const virtualWindow = createVirtualWindow();
    const topSpacer = document.createElement("div");
    const bottomSpacer = document.createElement("div");
    topSpacer.className = bottomSpacer.className = "step-virtual-spacer";
    topSpacer.setAttribute("aria-hidden", "true");
    bottomSpacer.setAttribute("aria-hidden", "true");
    function scheduleWindow() {
      if (windowFrame) return;
      windowFrame = requestAnimationFrame(() => { windowFrame = 0; renderWindow(); });
    }
    let containerWidth = 0;
    const resizeObserver = new ResizeObserver(entries => {
      let changed = false;
      for (const item of entries) {
        if (item.target === stepsContainer) {
          const width = item.contentRect.width;
          if (width !== containerWidth) {
            containerWidth = width;
            virtualWindow.clear();
            virtualWindow.reset(currentActions.map(actionKey));
            changed = true;
          }
        } else if (item.target.dataset.virtualKey) {
          changed = virtualWindow.measure(item.target.dataset.virtualKey, item.target.getBoundingClientRect().height) || changed;
        }
      }
      if (changed && currentActions.length > 200) scheduleWindow();
    });
    stepsContainer.addEventListener("scroll", () => { if (currentActions.length > 200) scheduleWindow(); }, { passive: true });
    function scrollToLatest() {
      requestAnimationFrame(() => { stepsContainer.scrollTop = stepsContainer.scrollHeight; });
    }
    function setRecording(value) {
      recording = !!value;
      stepsContainer.classList.toggle("is-recording", recording);
    }
    function describeStep(action) {
      return window.StepDocGenerator
        ? window.StepDocGenerator.describeStep(action)
        : {
            desc: t("stepGeneric", [action.type || "unknown"], `执行操作：${action.type || "unknown"}`),
            detail: String(action.type || "unknown"),
            context: []
          };
    }
    const ctx = {
      t, getBlob, openImagePreview, stepsContainer, readOnly, objectUrls, pendingLoads, mediaUrls,
      CAPTURE_LABELS, CAPTURE_REASON_LABELS, SKIPPED_REASON_LABELS,
      observer: null, describeStep, scrollToLatest,
      isMediaExpanded: (action, index) => readOnly || (expansionOverrides.get(actionKey(action, index)) ?? screenshotsExpandedDefault)
    };
    attachStepMedia(ctx);
    function setScreenshotsExpandedDefault(value) {
      if (readOnly || screenshotsExpandedDefault === !!value) return;
      screenshotsExpandedDefault = !!value;
      expansionOverrides.clear();
      virtualWindow.clear();
      virtualWindow.reset(currentActions.map(actionKey), screenshotsExpandedDefault ? 130 : 85);
      renderWindow();
    }
    ctx.mediaSequence = () => currentActions.flatMap((action, index) => [
      action.screenshotBeforeKey ? { key: action.screenshotBeforeKey,
        alt: ctx.screenshotTitle(action, index, "before"), highlight: action.screenshotBeforeHighlight } : null,
      action.screenshotKey ? { key: action.screenshotKey, alt: ctx.screenshotTitle(action, index, "after") } : null
    ]).filter(Boolean);
    // The "this recording has no screenshots" note, kept so a re-render updates it
    // instead of stacking another one.
    let screenshotsDisabledNote = null;
    async function deleteStep(index) {
      const context = { ...workspaceContext };
      const confirmed = await confirmAction({
        title: t("deleteStep", [], "删除步骤"),
        message: t("deleteStepMessage", [index + 1], `确定删除第 ${index + 1} 个操作步骤吗？`),
        confirmText: t("delete", [], "删除"), danger: true
      });
      if (!confirmed) return;
      const response = await sendRuntimeMessage({ action: MESSAGE.deleteStep, index, ...context });
      if (!response?.success) throw new Error(response?.error || t("deleteStepFailed", [], "删除步骤失败"));
      if (response.cleanupPending) notify(t("screenshotCleanupDeferred", [], "步骤已删除，截图将在后台重试清理"));
      onChanged();
    }
    function updateSelection(actions = []) {
      if (readOnly || !selectAllSteps || !deleteSelectedStepsBtn) return;
      const actionIds = actions.map(action => action.id).filter(Boolean);
      const selectedCount = actionIds.filter(id => selectedActionIds.has(id)).length;
      selectAllSteps.checked = actionIds.length > 0 && selectedCount === actionIds.length;
      selectAllSteps.indeterminate = selectedCount > 0 && selectedCount < actionIds.length;
      selectAllSteps.disabled = actionIds.length === 0;
      deleteSelectedStepsBtn.disabled = selectedActionIds.size === 0;
      // The count badge doubles as the selection readout, so no separate label has
      // to share the row: "3/5" says both how many are picked and how many exist.
      if (stepCountBadge) {
        stepCountBadge.textContent = selectedCount > 0 ? `${selectedCount}/${actionIds.length}` : String(actionIds.length);
      }
      // The section head carries the selection state, so the batch action only takes
      // up room while it applies and the select-all control only appears once there
      // is something to select.
      const head = selectAllSteps.closest(".steps-section-head");
      head?.classList.toggle("is-selecting", selectedCount > 0);
      head?.classList.toggle("is-empty", actionIds.length === 0);
    }
    async function deleteSelectedSteps() {
      const context = { ...workspaceContext };
      const actionIds = [...selectedActionIds];
      if (actionIds.length === 0) return;
      const confirmed = await confirmAction({
        title: t("deleteSelectedSteps", [], "删除所选"),
        message: t("deleteSelectedStepsMessage", [actionIds.length], `确定删除选中的 ${actionIds.length} 个步骤吗？此操作不可恢复。`),
        confirmText: t("delete", [], "删除"), danger: true
      });
      if (!confirmed) return;
      deleteSelectedStepsBtn.disabled = true;
      const response = await sendRuntimeMessage({ action: MESSAGE.deleteSteps, actionIds, ...context });
      if (!response?.success) throw new Error(response?.error || t("deleteStepsFailed", [], "批量删除步骤失败"));
      selectedActionIds.clear();
      if (response.cleanupPending) notify(t("screenshotCleanupDeferred", [], "步骤已删除，截图将在后台重试清理"));
      onChanged();
    }
    function actionKey(action, index) { return action.id ? `id:${action.id}` : `index:${index}`; }
    // The checkbox has no visible label, so it carries its name twice: aria-label for
    // assistive tech, and title so it shows the same hint as every other per-card
    // control on hover.
    function describeSelectionCheckbox(checkbox, index) {
      const label = t("selectStep", [index + 1], `选择第 ${index + 1} 个步骤`);
      checkbox.setAttribute("aria-label", label);
      checkbox.title = label;
    }
    function textSignature(action, desc) {
      return [action.type || "", action.pageName || "", desc].join("\u0001");
    }
    function createCard(action, index) {
      const card = document.createElement("div");
      card.className = "step-card";
      const checkbox = readOnly ? null : document.createElement("input");
      if (checkbox) {
        card.classList.add("has-selection");
        checkbox.type = "checkbox";
        checkbox.className = "selection-checkbox step-select-checkbox";
        describeSelectionCheckbox(checkbox, index);
      }
      const stepIndex = document.createElement("div");
      stepIndex.className = "step-index";
      const details = document.createElement("div");
      details.className = "step-details";
      const header = document.createElement("div");
      header.className = "step-header";
      const meta = document.createElement("div");
      meta.className = "step-meta";
      const typeBadge = document.createElement("span");
      const pageTag = document.createElement("span");
      pageTag.className = "step-page-tag";
      const statusTag = document.createElement("span");
      statusTag.className = "step-status-tag";
      statusTag.hidden = true;
      meta.append(typeBadge, pageTag, statusTag);
      const deleteButton = readOnly ? null : document.createElement("button");
      if (deleteButton) {
        deleteButton.className = "step-delete-btn";
        deleteButton.title = t("deleteStepTitle", [], "删除此步骤");
        deleteButton.innerHTML = iconSvg("trash", 14);
      }
      header.append(meta);
      if (deleteButton) header.append(deleteButton);
      const description = document.createElement("p");
      description.className = "step-description";
      const mediaRow = document.createElement("div");
      mediaRow.className = "step-media-row";
      mediaRow.id = `step-media-${viewId}-${++nextMediaId}`;
      const mediaToggle = readOnly ? null : document.createElement("button");
      if (mediaToggle) {
        mediaToggle.type = "button";
        mediaToggle.className = "step-screenshots-toggle";
        mediaToggle.hidden = true;
        mediaToggle.setAttribute("aria-controls", mediaRow.id);
        mediaToggle.addEventListener("click", () => {
          const current = currentActions[entry.index];
          if (!current) return;
          expansionOverrides.set(actionKey(current, entry.index), !ctx.isMediaExpanded(current, entry.index));
          const state = globalThis.RecorderCaptureState.resolve(current, currentCapture);
          ctx.syncMedia(entry, current, entry.index, state);
          ctx.syncCaptureState(entry, current, state);
        });
      }
      const beforeWrap = document.createElement("div");
      beforeWrap.className = "step-media-slot is-hidden";
      const beforeCaption = document.createElement("span");
      beforeCaption.className = "step-media-caption is-hidden";
      beforeCaption.textContent = t("stepBeforeShot", [], "操作前");
      beforeWrap.appendChild(beforeCaption);
      const mediaArrow = document.createElement("span");
      mediaArrow.className = "step-media-arrow is-hidden";
      mediaArrow.innerHTML = iconSvg("arrowRight", 14);
      const afterWrap = document.createElement("div");
      afterWrap.className = "step-media-slot is-hidden";
      const afterCaption = document.createElement("span");
      afterCaption.className = "step-media-caption is-hidden";
      afterCaption.textContent = t("stepAfterShot", [], "操作后");
      afterWrap.appendChild(afterCaption);
      mediaRow.append(beforeWrap, mediaArrow, afterWrap);
      details.append(header, description);
      if (mediaToggle) details.append(mediaToggle);
      details.append(mediaRow);
      if (checkbox) card.append(checkbox);
      card.append(stepIndex, details);
      const entry = {
        card, checkbox, stepIndex, details, description, typeBadge, pageTag, statusTag,
        deleteButton, mediaRow, mediaToggle, beforeWrap, afterWrap, mediaArrow, beforeCaption, afterCaption,
        index: -1, signature: null, beforeKey: undefined, afterKey: undefined, afterRenderKey: undefined,
        actionId: action.id || null, captureState: undefined, captureReason: undefined,
        beforeMedia: null, afterMedia: null
      };
      deleteButton?.addEventListener("click", event => {
        event.stopPropagation();
        deleteStep(entry.index).catch(error => reportError(error.message));
      });
      checkbox?.addEventListener("change", () => {
        if (checkbox.checked) selectedActionIds.add(entry.actionId);
        else selectedActionIds.delete(entry.actionId);
        card.classList.toggle("is-selected", checkbox.checked);
        updateSelection(currentActions);
      });
      return entry;
    }
    /**
     * A recording made with screenshots turned off has no frames to show, and two
     * empty slots on every card would say the same thing over and over. The list
     * as a whole is flagged instead: the frame rows are hidden and one note
     * explains why.
     *
     * A single step without a screenshot is a different case -- a click that opened
     * a child page, a capture that failed -- and keeps its own placeholder.
     */
    function syncScreenshotsDisabled(actions) {
      const { CAPTURE_DISABLED_REASON } = globalThis.RecorderCaptureState;
      const disabled = actions.length > 0 && actions.every(action =>
        !action.screenshotKey
        && !action.screenshotBeforeKey
        && action.screenshotSkippedReason === CAPTURE_DISABLED_REASON);
      stepsContainer.classList.toggle("screenshots-disabled", disabled);

      if (!disabled) {
        screenshotsDisabledNote?.remove();
        screenshotsDisabledNote = null;
        return;
      }
      if (!screenshotsDisabledNote) {
        screenshotsDisabledNote = document.createElement("p");
        screenshotsDisabledNote.className = "steps-screenshots-disabled";
        stepsContainer.prepend(screenshotsDisabledNote);
      }
      screenshotsDisabledNote.textContent = t("screenshotReasonCaptureDisabled", [], "录制时未启用截图");
    }

    function renderSteps(actions, capture = {}) {
      const count = actions.length;
      // Measured before this pass mutates the list, so it describes where the user
      // was looking, not where the new cards pushed them.
      const wasNearBottom = stepsContainer.scrollHeight - stepsContainer.scrollTop - stepsContainer.clientHeight <= 120;
      const appended = count > currentActions.length;
      currentActions = actions;
      currentCapture = capture;
      if (stepCountBadge) stepCountBadge.textContent = count;
      if (emptyState) emptyState.style.display = count > 0 ? "none" : "flex";
      if (downloadDocBtn) downloadDocBtn.disabled = count === 0;
      if (saveCurrentCaseBtn) saveCurrentCaseBtn.disabled = count === 0;
      syncScreenshotsDisabled(actions);
      const liveActionIds = new Set(actions.map(action => action.id).filter(Boolean));
      for (const id of selectedActionIds) if (!liveActionIds.has(id)) selectedActionIds.delete(id);
      const liveKeys = new Set(actions.map(actionKey));
      for (const key of expansionOverrides.keys()) if (!liveKeys.has(key)) expansionOverrides.delete(key);
      virtualWindow.reset(actions.map(actionKey), stepsContainer.classList.contains("screenshots-disabled") || !screenshotsExpandedDefault ? 85 : 130);
      resizeObserver.observe(stepsContainer);
      renderWindow();
      if (appended && (recording || (!firstRender && wasNearBottom))) scrollToLatest();
      firstRender = false;
      updateSelection(actions);
    }

    function renderWindow() {
      const actions = currentActions, capture = currentCapture;
      const virtual = actions.length > 200;
      const noteHeight = screenshotsDisabledNote ? screenshotsDisabledNote.offsetHeight + 6 : 0;
      const range = virtual ? virtualWindow.range(stepsContainer.scrollTop - noteHeight, stepsContainer.clientHeight)
        : { start: 0, end: actions.length, before: 0, after: 0 };
      const seen = new Set();
      // The empty state anchors the first card; with screenshots off the note takes
      // that place, so cards can never end up above the explanation for them.
      let cursor = emptyState?.parentElement === stepsContainer
        ? emptyState
        : screenshotsDisabledNote;
      if (screenshotsDisabledNote) cursor = screenshotsDisabledNote;
      topSpacer.hidden = !range.before;
      bottomSpacer.hidden = !range.after;
      topSpacer.style.height = `${range.before}px`;
      bottomSpacer.style.height = `${range.after}px`;
      if (range.before) {
        if (cursor) cursor.after(topSpacer); else stepsContainer.prepend(topSpacer);
        cursor = topSpacer;
      } else topSpacer.remove();
      for (let index = range.start; index < range.end; index++) {
        const action = actions[index];
        const key = actionKey(action, index);
        seen.add(key);
        const { desc } = describeStep(action);
        const signature = textSignature(action, desc);
        let entry = cardEntries.get(key);
        if (!entry) {
          entry = createCard(action, index);
          cardEntries.set(key, entry);
          entry.card.dataset.virtualKey = key;
          resizeObserver.observe(entry.card);
        }
        if (entry.signature !== signature) {
          entry.typeBadge.className = `step-type-badge ${String(action.type || "unknown").toLowerCase()}`;
          entry.typeBadge.textContent = window.StepDocGenerator
            ? window.StepDocGenerator.getActionLabel(action.type)
            : t("actionGeneric", [], "操作");
          entry.pageTag.textContent = action.pageName || "page1";
          entry.description.textContent = desc;
          entry.description.title = desc;
          entry.signature = signature;
        }
        entry.actionId = action.id || null;
        if (entry.checkbox) {
          entry.checkbox.checked = !!action.id && selectedActionIds.has(action.id);
          describeSelectionCheckbox(entry.checkbox, index);
          entry.card.classList.toggle("is-selected", entry.checkbox.checked);
        }
        const resolvedCaptureState = globalThis.RecorderCaptureState.resolve(action, capture);
        ctx.syncMedia(entry, action, index, resolvedCaptureState);
        ctx.syncCaptureState(entry, action, resolvedCaptureState);
        if (entry.index !== index) {
          entry.stepIndex.textContent = String(index + 1);
          entry.index = index;
        }
        const expectedPrevious = cursor;
        if (entry.card.previousElementSibling !== expectedPrevious || !entry.card.isConnected) {
          if (expectedPrevious) expectedPrevious.after(entry.card);
          else stepsContainer.prepend(entry.card);
        }
        cursor = entry.card;
        entry.card.classList.toggle("is-last-step", index === actions.length - 1);
      }
      if (range.after) {
        if (cursor) cursor.after(bottomSpacer); else stepsContainer.append(bottomSpacer);
      } else bottomSpacer.remove();
      for (const [key, entry] of cardEntries) {
        if (seen.has(key)) continue;
        ctx.releaseMedia(entry.beforeMedia);
        ctx.releaseMedia(entry.afterMedia);
        resizeObserver.unobserve(entry.card);
        entry.card.remove();
        cardEntries.delete(key);
      }
    }
    function updateCaptureState(capture) {
      const ids = new Set([currentCapture.activeActionId, capture.activeActionId]);
      currentCapture = capture;
      for (const entry of cardEntries.values()) {
        if (!ids.has(entry.actionId)) continue;
        const action = currentActions[entry.index];
        if (action) ctx.syncCaptureState(entry, action, globalThis.RecorderCaptureState.resolve(action, capture));
      }
    }
    function patchSteps(actions, capture, changedIds) {
      currentActions = actions;
      updateCaptureState(capture);
      for (const id of changedIds) {
        const entry = cardEntries.get(`id:${id}`);
        if (!entry) continue;
        const action = actions[entry.index];
        if (!action) continue;
        const state = globalThis.RecorderCaptureState.resolve(action, capture);
        ctx.syncMedia(entry, action, entry.index, state);
        ctx.syncCaptureState(entry, action, state);
        const { desc } = describeStep(action);
        entry.description.textContent = entry.description.title = desc;
        entry.signature = textSignature(action, desc);
      }
    }
    function dispose() {
      if (windowFrame) cancelAnimationFrame(windowFrame);
      windowFrame = 0;
      resizeObserver.disconnect();
      topSpacer.remove();
      bottomSpacer.remove();
      virtualWindow.clear();
      currentActions = [];
      currentCapture = {};
      firstRender = true;
      ctx.getObserver()?.disconnect();
      ctx.setObserver(null);
      for (const entry of cardEntries.values()) {
        ctx.releaseMedia(entry.beforeMedia);
        ctx.releaseMedia(entry.afterMedia);
        entry.card.remove();
      }
      cardEntries.clear();
      selectedActionIds.clear();
      expansionOverrides.clear();
      objectUrls.forEach(URL.revokeObjectURL);
      objectUrls.clear();
    }
    selectAllSteps?.addEventListener("change", () => {
      const checked = selectAllSteps.checked;
      for (const action of currentActions) {
        if (checked && action.id) selectedActionIds.add(action.id);
        else selectedActionIds.delete(action.id);
      }
      cardEntries.forEach(entry => {
        if (entry.checkbox) entry.checkbox.checked = selectAllSteps.checked;
        entry.card.classList.toggle("is-selected", selectAllSteps.checked);
      });
      updateSelection(currentActions);
    });
    deleteSelectedStepsBtn?.addEventListener("click", () => {
      deleteSelectedSteps().catch(error => {
        reportError(error.message);
        updateSelection(currentActions);
      });
    });
    return { dispose, renderSteps, patchSteps, updateCaptureState, setRecording, setScreenshotsExpandedDefault,
      setWorkspaceContext: value => { workspaceContext = value || {}; } };
  }
  window.RecorderStepView = { create };
}
export {};
