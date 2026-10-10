/** Shared step cards for the side panel and saved-case previews. */
import { attachStepMedia } from "./step-media.js";
import { iconSvg } from "../lib/icons.js";

if (!window.RecorderStepView) {
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
      observer: null, describeStep, scrollToLatest
    };
    attachStepMedia(ctx);
    // The "this recording has no screenshots" note, kept so a re-render updates it
    // instead of stacking another one.
    let screenshotsDisabledNote = null;
    async function deleteStep(index) {
      const confirmed = await confirmAction({
        title: t("deleteStep", [], "删除步骤"),
        message: t("deleteStepMessage", [index + 1], `确定删除第 ${index + 1} 个操作步骤吗？`),
        confirmText: t("delete", [], "删除"), danger: true
      });
      if (!confirmed) return;
      const response = await sendRuntimeMessage({ action: MESSAGE.deleteStep, index });
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
      const actionIds = [...selectedActionIds];
      if (actionIds.length === 0) return;
      const confirmed = await confirmAction({
        title: t("deleteSelectedSteps", [], "删除所选"),
        message: t("deleteSelectedStepsMessage", [actionIds.length], `确定删除选中的 ${actionIds.length} 个步骤吗？此操作不可恢复。`),
        confirmText: t("delete", [], "删除"), danger: true
      });
      if (!confirmed) return;
      deleteSelectedStepsBtn.disabled = true;
      const response = await sendRuntimeMessage({ action: MESSAGE.deleteSteps, actionIds });
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
      details.append(header, description, mediaRow);
      if (checkbox) card.append(checkbox);
      card.append(stepIndex, details);
      const entry = {
        card, checkbox, stepIndex, details, description, typeBadge, pageTag, statusTag,
        deleteButton, mediaRow, beforeWrap, afterWrap, mediaArrow, beforeCaption, afterCaption,
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
        updateSelection([...cardEntries.values()].map(item => ({ id: item.actionId })).filter(item => item.id));
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
      if (stepCountBadge) stepCountBadge.textContent = count;
      if (emptyState) emptyState.style.display = count > 0 ? "none" : "flex";
      if (downloadDocBtn) downloadDocBtn.disabled = count === 0;
      if (saveCurrentCaseBtn) saveCurrentCaseBtn.disabled = count === 0;
      syncScreenshotsDisabled(actions);
      const seen = new Set();
      const liveActionIds = new Set(actions.map(action => action.id).filter(Boolean));
      for (const id of selectedActionIds) if (!liveActionIds.has(id)) selectedActionIds.delete(id);
      let appended = false;
      // The empty state anchors the first card; with screenshots off the note takes
      // that place, so cards can never end up above the explanation for them.
      let cursor = emptyState?.parentElement === stepsContainer
        ? emptyState
        : screenshotsDisabledNote;
      actions.forEach((action, index) => {
        const key = actionKey(action, index);
        seen.add(key);
        const { desc } = describeStep(action);
        const signature = textSignature(action, desc);
        let entry = cardEntries.get(key);
        if (!entry) {
          entry = createCard(action, index);
          cardEntries.set(key, entry);
          appended = true;
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
      });
      for (const [key, entry] of cardEntries) {
        if (seen.has(key)) continue;
        ctx.releaseMedia(entry.beforeMedia);
        ctx.releaseMedia(entry.afterMedia);
        entry.card.remove();
        cardEntries.delete(key);
      }
      // Follow the newest step while recording. Otherwise leave the scroll position
      // alone on the first paint, so opening a saved case starts at step 1 rather
      // than at the last step.
      if (appended && (recording || (!firstRender && wasNearBottom))) scrollToLatest();
      firstRender = false;
      updateSelection(actions);
    }
    function dispose() {
      ctx.getObserver()?.disconnect();
      ctx.setObserver(null);
      for (const entry of cardEntries.values()) {
        ctx.releaseMedia(entry.beforeMedia);
        ctx.releaseMedia(entry.afterMedia);
        entry.card.remove();
      }
      cardEntries.clear();
      selectedActionIds.clear();
      objectUrls.forEach(URL.revokeObjectURL);
      objectUrls.clear();
    }
    selectAllSteps?.addEventListener("change", () => {
      const entries = [...cardEntries.values()].filter(entry => entry.actionId);
      entries.forEach(entry => {
        if (selectAllSteps.checked) selectedActionIds.add(entry.actionId);
        else selectedActionIds.delete(entry.actionId);
        if (entry.checkbox) entry.checkbox.checked = selectAllSteps.checked;
        entry.card.classList.toggle("is-selected", selectAllSteps.checked);
      });
      updateSelection(entries.map(entry => ({ id: entry.actionId })));
    });
    deleteSelectedStepsBtn?.addEventListener("click", () => {
      deleteSelectedSteps().catch(error => {
        reportError(error.message);
        updateSelection([...cardEntries.values()].map(entry => ({ id: entry.actionId })).filter(item => item.id));
      });
    });
    return { dispose, renderSteps, setRecording };
  }
  window.RecorderStepView = { create };
}
export {};
