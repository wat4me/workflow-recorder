/** Shared step cards for the side panel and saved-case previews. */
import { attachStepMedia } from "./step-media.js";
import { iconSvg } from "../lib/icons.js";
import { recordingTabLabel } from "../lib/recording-tab-label.js";
import { createVirtualWindow } from "../lib/virtual-window.js";

function hashText(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
}

if (!window.RecorderStepView) {
  let viewSequence = 0;
  function create(options) {
    const {
      stepsContainer, emptyState, stepCountBadge, selectAllSteps,
      deleteSelectedStepsBtn, downloadDocBtn, saveCurrentCaseBtn, onChanged,
      stepMarker = null, onStepMarkerEdit = null,
      readOnly = false,
      // The read-only preview can still select steps to annotate them.
      selectable = !readOnly
    } = options;
    let selectionListener = null;
    // Shift+click selects every step between the last toggled one and this one.
    let selectionAnchor = null;
    let shiftToggle = false;
    const { t } = globalThis.RecorderI18n;
    const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
    const { getBlob, sendRuntimeMessage } = globalThis.RecorderBridge;
    const { confirmAction, notify, promptText, reportError } = globalThis.RecorderDialogs;
    const { openImagePreview } = globalThis.RecorderImagePreview;
    const objectUrls = new Set();
    const cardEntries = new Map();
    const pendingLoads = new WeakMap();
    const mediaUrls = new WeakMap();
    const selectedActionIds = new Set();
    const pageSelections = new Map();
    const collapsedSegments = new Set();
    const intentSections = new Map();
    const intentExpansion = new Map();
    let intentSteps = [];
    let intentByIndex = [];
    let lastIntentGroup = null;
    let workspaceContext = {};
    const expansionOverrides = new Map();
    const viewId = ++viewSequence;
    let nextMediaId = 0;
    let screenshotsExpandedDefault = true;
    // Which card opens a test step, decided by the panel from the annotation.
    // Returns null for steps that start nothing, so a plain recording renders
    // exactly as it did before annotations existed.
    let markerProvider = stepMarker;
    let endMarkerProvider = null;
    let markerEditHandler = onStepMarkerEdit;
    let highlightedRange = null;
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
      "opens-child-page": () => t("captureReasonOpensChildPage", [], "点击打开了新页面"),
      "browser-dialog": () => t("captureReasonBrowserDialog", [], "网页截图不包含浏览器原生弹窗")
    };
    // The saved-case preview mounts this view too and never records, so the panel
    // has to say when it is recording: only then is the newest step the one the
    // user is waiting for. It also scopes the "flow ends here" index highlight.
    let recording = false;
    let firstRender = true;
    let currentActions = [];
    let pageHueSeed = 0;
    let pageSegments = [];
    let visibleIndices = [];
    let currentCapture = {};
    let windowFrame = 0;
    stepsContainer.classList.toggle("steps-compact", !readOnly);
    const virtualWindow = createVirtualWindow(readOnly ? 6 : 0);
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
            resetStepWindow();
            changed = true;
          }
        } else if (item.target.dataset.virtualKey) {
          changed = virtualWindow.measure(item.target.dataset.virtualKey, item.target.getBoundingClientRect().height) || changed;
        }
      }
      if (changed && visibleIndices.length > 200) scheduleWindow();
    });
    stepsContainer.addEventListener("scroll", () => { if (visibleIndices.length > 200) scheduleWindow(); }, { passive: true });
    window.addEventListener("recorderLanguageChanged", scheduleWindow);
    function scrollToLatest() {
      requestAnimationFrame(() => { stepsContainer.scrollTop = stepsContainer.scrollHeight; });
    }
    function setRecording(value) {
      recording = !!value;
      stepsContainer.classList.toggle("is-recording", recording);
    }
    function syncIntentMarker(entry, index) {
      const group = intentByIndex[index];
      const spec = group?.start === index ? group : markerProvider?.(index);
      const current = entry.card.querySelector(":scope > .step-intent-marker");
      if (!spec) { current?.remove(); return; }
      const signature = JSON.stringify([spec.label, spec.detail, group?.title, group?.key, group?.end, isIntentCollapsed(group), index]);
      if (current?.dataset.signature === signature) return;
      const previousFocus = current?.contains(document.activeElement) ? document.activeElement.className : null;
      const node = current || document.createElement("div");
      node.dataset.signature = signature;
      if (!current) {
        node.className = "step-intent-marker";
        entry.card.prepend(node);
      }
      const parts = [];
      const label = document.createElement("span");
      label.className = "step-intent-marker-label";
      label.textContent = group ? group.title || group.heading : spec.label;
      label.title = label.textContent;
      parts.push(label);
      if (group) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "step-intent-group-toggle";
        toggle.setAttribute("aria-expanded", String(!isIntentCollapsed(group)));
        const content = document.createElement("span");
        content.className = "step-intent-group-content";
        const meta = document.createElement("span");
        meta.className = "step-intent-group-meta";
        const range = t("intentStepRange", [String(group.start + 1), String(group.end + 1)],
          `第 ${group.start + 1}–${group.end + 1} 步`);
        meta.textContent = group.title ? `${group.heading} · ${range}` : range;
        content.append(label, meta);
        toggle.innerHTML = iconSvg("chevronRight", 14);
        toggle.append(content);
        toggle.addEventListener("click", () => {
          const top = entry.card.getBoundingClientRect().top;
          intentExpansion.set(group.key, isIntentCollapsed(group));
          renderAroundHeading(entry, top);
        });
        parts[0] = toggle;
      } else if (spec.detail) {
        const detail = document.createElement("span");
        detail.className = "step-intent-marker-detail";
        detail.textContent = spec.detail;
        detail.title = spec.detail;
        parts.push(detail);
      }
      if (markerEditHandler) {
        const edit = document.createElement("button");
        edit.type = "button";
        edit.className = "icon-btn step-intent-marker-edit";
        edit.title = t("edit", [], "编辑");
        edit.setAttribute("aria-label", `${edit.title} ${spec.label}`);
        edit.setAttribute("aria-haspopup", "dialog");
        edit.innerHTML = iconSvg("pencil", 14);
        edit.addEventListener("click", event => {
          event.stopPropagation();
          markerEditHandler(group ? group.id : index);
        });
        parts.push(edit);
      }
      node.replaceChildren(...parts);
      if (previousFocus) [...node.querySelectorAll("button")].find(button => button.className === previousFocus)
        ?.focus({ preventScroll: true });
    }
    /**
     * Draws the closing rule of a test step, below its last recorded step.
     *
     * It only exists while the following steps have no annotation yet: once the
     * next test step starts there, its own marker is the divider, so two rules
     * would sit on top of each other.
     */
    function syncIntentEndMarker(entry, index) {
      const spec = endMarkerProvider ? endMarkerProvider(index) : null;
      const current = entry.card.querySelector(":scope > .step-intent-end");
      if (!spec) { current?.remove(); return; }
      const node = current || document.createElement("div");
      if (!current) {
        node.className = "step-intent-end";
        entry.card.append(node);
      }
      node.textContent = spec.label;
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
      isMediaExpanded: (action, index) => readOnly || (!isSegmentCollapsed(index)
        && (expansionOverrides.get(actionKey(action, index)) ?? screenshotsExpandedDefault))
    };
    attachStepMedia(ctx);
    function setScreenshotsExpandedDefault(value) {
      if (readOnly || screenshotsExpandedDefault === !!value) return;
      screenshotsExpandedDefault = !!value;
      expansionOverrides.clear();
      virtualWindow.clear();
      resetStepWindow();
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
    async function renameClickTarget(action) {
      const context = { ...workspaceContext };
      const name = await promptText({
        title: t("renameClickTarget", [], "设置点击目标名称"),
        label: t("clickTargetName", [], "自定义名称"),
        message: t("clickTargetNameHint", [], "名称会显示在此步骤和导出的文档中。留空可恢复自动识别的名称。"),
        value: action.customTargetName || "",
        confirmText: t("save", [], "保存")
      });
      if (name === null) return;
      const response = await sendRuntimeMessage({ action: MESSAGE.renameClickTarget, actionId: action.id, name, ...context });
      if (!response?.success) throw new Error(response?.error || t("clickTargetNameSaveFailed", [], "保存目标名称失败"));
      onChanged();
    }

    async function editInputValue(action) {
      const context = { ...workspaceContext };
      const value = await promptText({
        title: t("editInputValue", [], "编辑输入值"),
        label: t("inputValue", [], "输入值"),
        message: t("editInputValueHint", [], "保存后的值会用于步骤列表和导出。留空表示清空输入。"),
        value: action.value ?? "",
        multiline: true,
        maxLength: null,
        confirmText: t("save", [], "保存")
      });
      if (value === null) return;
      const response = await sendRuntimeMessage({ action: MESSAGE.editInputValue, actionId: action.id, value, ...context });
      if (!response?.success) throw new Error(response?.error || t("editInputValueFailed", [], "保存输入值失败"));
      onChanged();
    }

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
    function syncSelection(entry) {
      if (!entry.checkbox) return;
      entry.checkbox.checked = selectedActionIds.has(entry.actionId);
      entry.card.classList.toggle("is-selected", entry.checkbox.checked);
      if (!entry.pageHeading || entry.pageHeading.hidden) return;
      const { ids, selectedCount } = pageSelections.get(pageSegments[entry.index].page);
      entry.pageCheckbox.hidden = pageSelections.size < 2;
      entry.pageCheckbox.disabled = ids.length === 0;
      entry.pageCheckbox.checked = ids.length > 0 && selectedCount === ids.length;
      entry.pageCheckbox.indeterminate = selectedCount > 0 && selectedCount < ids.length;
    }
    function updateSelection() {
      if (!selectable) return;
      pageSelections.clear();
      let total = 0;
      let selectedCount = 0;
      for (const action of currentActions) {
        const name = stepPage(action);
        if (!pageSelections.has(name)) pageSelections.set(name, { ids: [], selectedCount: 0 });
        if (!action.id) continue;
        const page = pageSelections.get(name);
        page.ids.push(action.id);
        total++;
        if (selectedActionIds.has(action.id)) {
          page.selectedCount++;
          selectedCount++;
        }
      }
      if (!selectAllSteps || !deleteSelectedStepsBtn) return;
      selectAllSteps.checked = total > 0 && selectedCount === total;
      selectAllSteps.indeterminate = selectedCount > 0 && selectedCount < total;
      selectAllSteps.disabled = total === 0;
      deleteSelectedStepsBtn.disabled = selectedActionIds.size === 0;
      // The count badge doubles as the selection readout, so no separate label has
      // to share the row: "3/5" says both how many are picked and how many exist.
      if (stepCountBadge) {
        stepCountBadge.textContent = selectedCount > 0 ? `${selectedCount}/${total}` : String(total);
      }
      // The section head carries the selection state, so the batch action only takes
      // up room while it applies and the select-all control only appears once there
      // is something to select.
      const head = selectAllSteps.closest(".steps-section-head");
      head?.classList.toggle("is-selecting", selectedCount > 0);
      head?.classList.toggle("is-empty", total === 0);
    }
    /** Indices of the selected steps in the current list, ascending. */
    function selectedIndices() {
      return currentActions.flatMap((action, index) => (action.id && selectedActionIds.has(action.id) ? [index] : []));
    }
    /**
     * Rendering can move the selected indices. Listeners may re-render (to
     * highlight a range), so they hear about it once the render has finished.
     */
    let selectionNotifyQueued = false;
    function notifySelectionSoon() {
      if (!selectionListener || selectionNotifyQueued) return;
      selectionNotifyQueued = true;
      queueMicrotask(() => {
        selectionNotifyQueued = false;
        selectionListener?.(selectedIndices());
      });
    }
    function refreshSelection() {
      updateSelection();
      for (const entry of cardEntries.values()) syncSelection(entry);
      selectionListener?.(selectedIndices());
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
    function stepPage(action) { return action.pageName || "page1"; }
    function updateIntentGroups() {
      intentByIndex = [];
      lastIntentGroup = null;
      const live = new Set();
      for (const [position, step] of intentSteps.entries()) {
        const start = step.start - 1;
        const end = Math.min(step.open ? currentActions.length : step.end,
          (intentSteps[position + 1]?.start ?? Infinity) - 1, currentActions.length) - 1;
        if (start < 0 || start > end) continue;
        const group = {
          id: step.id,
          key: JSON.stringify([step.id, currentActions[start].id ?? start]),
          start,
          end,
          title: step.title,
          heading: globalThis.RecorderIntentDialog.stepLabel(null, position),
          label: globalThis.RecorderIntentDialog.stepLabel(step, position)
        };
        for (let index = start; index <= end; index++) intentByIndex[index] = group;
        lastIntentGroup = group.key;
        live.add(group.key);
      }
      for (const id of intentExpansion.keys()) if (!live.has(id)) intentExpansion.delete(id);
      stepsContainer.classList.toggle("has-intent-groups", live.size > 0);
    }
    function isIntentCollapsed(group) {
      return Boolean(group && !(intentExpansion.get(group.key) ?? (group.key === lastIntentGroup)));
    }
    function updatePageSegments() {
      if (readOnly) return;
      const live = new Set();
      let segment;
      pageSegments = currentActions.map((action, index) => {
        const page = stepPage(action);
        if (segment?.page !== page || intentByIndex[index] !== intentByIndex[index - 1]) {
          const key = JSON.stringify([page, actionKey(action, index)]);
          segment = { key, page, start: index, count: 0 };
          live.add(key);
        }
        segment.count++;
        return segment;
      });
      for (const key of collapsedSegments) if (!live.has(key)) collapsedSegments.delete(key);
    }
    function isSegmentCollapsed(index) {
      return collapsedSegments.has(pageSegments[index]?.key);
    }
    function windowKey(action, index) {
      const key = actionKey(action, index);
      const group = intentByIndex[index];
      const boundary = group?.start === index ? `intent:${group.id}:${isIntentCollapsed(group)}:` : "";
      return `${boundary}${isSegmentCollapsed(index) ? "collapsed:" : ""}${key}`;
    }
    function resetStepWindow() {
      visibleIndices = [];
      const keys = [];
      currentActions.forEach((action, index) => {
        const group = intentByIndex[index];
        if (isIntentCollapsed(group) && group.start !== index) return;
        if (isSegmentCollapsed(index) && pageSegments[index].start !== index) return;
        visibleIndices.push(index);
        keys.push(windowKey(action, index));
      });
      const compact = stepsContainer.classList.contains("screenshots-disabled") || !screenshotsExpandedDefault;
      virtualWindow.reset(keys, readOnly ? 130 : compact ? 40 : 120);
    }
    function togglePageSegment(entry) {
      const { key } = pageSegments[entry.index];
      const top = entry.card.getBoundingClientRect().top;
      if (collapsedSegments.has(key)) collapsedSegments.delete(key);
      else collapsedSegments.add(key);
      renderAroundHeading(entry, top);
    }
    function renderAroundHeading(entry, top) {
      const offset = top - stepsContainer.getBoundingClientRect().top;
      resetStepWindow();
      // Keep the activated heading in view when the scroll range changes.
      const position = visibleIndices.indexOf(entry.index);
      const scrollTop = virtualWindow.offsetAt(position) + noteHeight() - offset;
      renderWindow(scrollTop);
      if (visibleIndices.length > 200) stepsContainer.scrollTop = scrollTop;
      stepsContainer.scrollTop += entry.card.getBoundingClientRect().top - top;
    }
    // The checkbox has no visible label, so it carries its name twice: aria-label for
    // assistive tech, and title so it shows the same hint as every other per-card
    // control on hover.
    function describeSelectionCheckbox(checkbox, index) {
      const label = t("selectStep", [index + 1], `选择第 ${index + 1} 个步骤`);
      checkbox.setAttribute("aria-label", label);
      checkbox.title = label;
    }
    function syncStepText(entry, action) {
      const { desc, summary } = describeStep(action);
      const tabLabel = entry.pageTag ? recordingTabLabel(stepPage(action)) : "";
      const signature = [action.type || "", tabLabel, desc].join("\u0001");
      if (entry.signature === signature) return;
      entry.typeBadge.className = `step-type-badge ${String(action.type || "unknown").toLowerCase()}`;
      entry.typeBadge.textContent = window.StepDocGenerator
        ? window.StepDocGenerator.getActionLabel(action.type)
        : t("actionGeneric", [], "操作");
      if (entry.pageTag) entry.pageTag.textContent = tabLabel;
      // The type badge already names the action, so both views show the short
      // summary and keep the full sentence in the tooltip.
      entry.description.textContent = summary || desc;
      entry.description.title = desc;
      entry.signature = signature;
    }
    function syncPageHeading(entry, index) {
      if (!entry?.pageHeading) return;
      const action = currentActions[index];
      const page = stepPage(action);
      const pageNumber = Number(/^page(\d+)$/.exec(page)?.[1]);
      // A golden-angle step keeps neighboring numbered tabs visibly distinct.
      const hueOffset = Number.isSafeInteger(pageNumber) && pageNumber > 0
        ? (pageNumber - 1) * 137.508 : hashText(page);
      entry.card.style.setProperty("--step-page-hue", String((pageHueSeed + hueOffset) % 360));
      const { start, count } = pageSegments[index];
      const collapsed = isSegmentCollapsed(index);
      entry.card.classList.toggle("is-page-collapsed", collapsed);
      entry.pageHeading.hidden = index !== start;
      if (entry.pageHeading.hidden) return;
      const tabLabel = recordingTabLabel(page);
      const toggleLabel = collapsed
        ? t("expandPageSteps", [tabLabel, count], `展开 ${tabLabel}（${count} 步）`)
        : t("collapsePageSteps", [tabLabel, count], `折叠 ${tabLabel}（${count} 步）`);
      entry.pageToggle.setAttribute("aria-expanded", String(!collapsed));
      entry.pageToggle.setAttribute("aria-label", toggleLabel);
      entry.pageToggle.title = toggleLabel;
      entry.pageCount.textContent = String(count);
      const title = String(action.title || "").trim();
      if (entry.pageName.textContent === tabLabel && entry.pageTitle.textContent === title) return;
      entry.pageName.textContent = tabLabel;
      entry.pageTitle.textContent = title;
      entry.pageTitle.hidden = !title;
      entry.pageHeading.title = title ? `${title} · ${tabLabel}` : tabLabel;
      const label = t("selectPageSteps", [tabLabel], `选择 ${tabLabel} 的所有步骤`);
      entry.pageCheckbox.setAttribute("aria-label", label);
      entry.pageCheckbox.title = label;
    }
    function createCard(action, index) {
      const card = document.createElement("div");
      card.className = "step-card";
      const pageHeading = readOnly ? null : document.createElement("div");
      const pageCheckbox = pageHeading ? document.createElement("input") : null;
      const pageToggle = pageHeading ? document.createElement("button") : null;
      const pageCount = pageHeading ? document.createElement("span") : null;
      const pageName = pageHeading ? document.createElement("span") : null;
      const pageTitle = pageHeading ? document.createElement("span") : null;
      if (pageHeading) {
        pageHeading.className = "step-page-heading";
        const pageLabel = document.createElement("div");
        pageLabel.className = "step-page-label";
        pageLabel.setAttribute("role", "heading");
        pageLabel.setAttribute("aria-level", "3");
        pageCheckbox.type = "checkbox";
        pageCheckbox.className = "selection-checkbox step-page-checkbox";
        pageName.className = "step-page-name";
        pageTitle.className = "step-page-title";
        pageLabel.append(pageTitle, pageName);
        pageToggle.type = "button";
        pageToggle.className = "step-page-toggle";
        pageToggle.innerHTML = iconSvg("chevronRight", 14);
        pageToggle.prepend(pageCount);
        pageHeading.append(pageCheckbox, pageLabel, pageToggle);
        card.append(pageHeading);
      }
      const checkbox = selectable ? document.createElement("input") : null;
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
      const pageTag = readOnly ? document.createElement("span") : null;
      const statusTag = document.createElement("span");
      statusTag.className = "step-status-tag";
      statusTag.hidden = true;
      meta.append(typeBadge);
      if (pageTag) {
        pageTag.className = "step-page-tag";
        meta.append(pageTag, statusTag);
      }
      const deleteButton = readOnly ? null : document.createElement("button");
      if (deleteButton) {
        deleteButton.className = "step-delete-btn";
        deleteButton.title = t("deleteStepTitle", [], "删除此步骤");
        deleteButton.innerHTML = iconSvg("trash", 14);
      }
      header.append(meta);
      const description = document.createElement("p");
      description.className = "step-description";
      if (!readOnly) header.append(description);
      const editStep = action.type === "type" ? editInputValue : renameClickTarget;
      const renameButton = (action.type === "click" || action.type === "type") && action.id && !readOnly
        ? document.createElement("button") : null;
      const actions = readOnly ? null : document.createElement("div");
      if (actions) {
        actions.className = "step-card-actions";
        if (renameButton) {
          renameButton.type = "button";
          renameButton.className = "step-rename-btn";
          renameButton.title = action.type === "type"
            ? t("editInputValue", [], "编辑输入值") : t("renameClickTarget", [], "设置点击目标名称");
          renameButton.setAttribute("aria-label", renameButton.title);
          renameButton.innerHTML = iconSvg("pencil", 14);
          actions.append(renameButton);
        }
        actions.append(deleteButton);
        header.append(actions);
      }
      const mediaRow = document.createElement("div");
      mediaRow.className = "step-media-row";
      mediaRow.id = `step-media-${viewId}-${++nextMediaId}`;
      const mediaToggle = readOnly ? null : document.createElement("button");
      const mediaToggleCount = mediaToggle ? document.createElement("span") : null;
      if (mediaToggle) {
        mediaToggle.type = "button";
        mediaToggle.className = "step-screenshots-toggle";
        mediaToggle.hidden = true;
        mediaToggle.innerHTML = iconSvg("image", 14);
        mediaToggle.append(mediaToggleCount);
        deleteButton.before(mediaToggle);
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
      details.append(header, readOnly ? description : statusTag, mediaRow);
      if (checkbox) card.append(checkbox);
      card.append(stepIndex, details);
      const entry = {
        card, checkbox, stepIndex, details, description, typeBadge, pageTag, pageHeading, pageCheckbox, pageToggle, pageCount, pageName, pageTitle, statusTag,
        deleteButton, mediaRow, mediaToggle, mediaToggleCount, beforeWrap, afterWrap, mediaArrow, beforeCaption, afterCaption,
        index: -1, signature: null, beforeKey: undefined, afterKey: undefined, afterRenderKey: undefined,
        actionId: action.id || null, captureState: undefined, captureReason: undefined,
        beforeMedia: null, afterMedia: null
      };
      renameButton?.addEventListener("click", () => {
        const current = currentActions[entry.index];
        if (current?.type === action.type && current.id === entry.actionId) {
          editStep(current).catch(error => reportError(error.message));
        }
      });
      deleteButton?.addEventListener("click", event => {
        event.stopPropagation();
        deleteStep(entry.index).catch(error => reportError(error.message));
      });
      checkbox?.addEventListener("click", event => { shiftToggle = event.shiftKey; });
      checkbox?.addEventListener("change", () => {
        const from = shiftToggle && Number.isInteger(selectionAnchor) ? Math.min(selectionAnchor, entry.index) : entry.index;
        const to = shiftToggle && Number.isInteger(selectionAnchor) ? Math.max(selectionAnchor, entry.index) : entry.index;
        for (let index = from; index <= to; index++) {
          const id = currentActions[index]?.id;
          if (!id) continue;
          if (checkbox.checked) selectedActionIds.add(id);
          else selectedActionIds.delete(id);
        }
        shiftToggle = false;
        selectionAnchor = entry.index;
        refreshSelection();
      });
      pageCheckbox?.addEventListener("change", () => {
        const page = pageSelections.get(pageSegments[entry.index].page);
        for (const id of page.ids) {
          if (pageCheckbox.checked) selectedActionIds.add(id);
          else selectedActionIds.delete(id);
        }
        refreshSelection();
      });
      pageToggle?.addEventListener("click", () => togglePageSegment(entry));
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
      pageHueSeed = hashText(workspaceContext.workspaceDraftId || actions[0]?.id || actions[0]?.url || "");
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
      resizeObserver.observe(stepsContainer);
      updateSelection();
      // Steps may have been added or removed, which moves the selected indices.
      notifySelectionSoon();
      updateIntentGroups();
      updatePageSegments();
      resetStepWindow();
      renderWindow();
      if (appended && (recording || (!firstRender && wasNearBottom))) scrollToLatest();
      firstRender = false;
    }

    function noteHeight() { return screenshotsDisabledNote ? screenshotsDisabledNote.offsetHeight + 6 : 0; }
    function renderWindow(scrollTop = stepsContainer.scrollTop) {
      const actions = currentActions, capture = currentCapture;
      const count = visibleIndices.length;
      const range = count > 200 ? virtualWindow.range(scrollTop - noteHeight(), stepsContainer.clientHeight)
        : { start: 0, end: count, before: 0, after: 0 };
      const seen = new Set();
      const seenGroups = new Set();
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
      let groupCursor = null;
      for (let position = range.start; position < range.end; position++) {
        const index = visibleIndices[position];
        const action = actions[index];
        const group = intentByIndex[index];
        const key = actionKey(action, index);
        seen.add(key);
        let entry = cardEntries.get(key);
        if (!entry) {
          entry = createCard(action, index);
          cardEntries.set(key, entry);
          resizeObserver.observe(entry.card);
        }
        entry.card.dataset.virtualKey = windowKey(action, index);
        entry.card.dataset.stepIndex = String(index);
        syncStepText(entry, action);
        syncPageHeading(entry, index);
        entry.actionId = action.id || null;
        if (entry.index !== index) {
          entry.stepIndex.textContent = String(index + 1);
          entry.index = index;
        }
        if (entry.checkbox) describeSelectionCheckbox(entry.checkbox, index);
        syncSelection(entry);
        const resolvedCaptureState = globalThis.RecorderCaptureState.resolve(action, capture);
        ctx.syncMedia(entry, action, index, resolvedCaptureState);
        ctx.syncCaptureState(entry, action, resolvedCaptureState);
        if (group) {
          let section = intentSections.get(group.key);
          if (!section) {
            section = document.createElement("section");
            section.className = "step-intent-group";
            intentSections.set(group.key, section);
          }
          if (!seenGroups.has(group.key)) {
            seenGroups.add(group.key);
            section.setAttribute("aria-label", group.label);
            section.classList.toggle("is-intent-collapsed", isIntentCollapsed(group));
            section.classList.toggle("is-intent-start", index === group.start);
            if (section.parentElement !== stepsContainer || section.previousElementSibling !== cursor) {
              if (cursor) cursor.after(section); else stepsContainer.prepend(section);
            }
            groupCursor = null;
          }
          if (entry.card.parentElement !== section || entry.card.previousElementSibling !== groupCursor) {
            if (groupCursor) groupCursor.after(entry.card); else section.prepend(entry.card);
          }
          groupCursor = entry.card;
          const segment = pageSegments[index];
          const visibleEnd = isSegmentCollapsed(index) ? segment.start + segment.count - 1 : index;
          section.classList.toggle("is-intent-end", isIntentCollapsed(group) || visibleEnd === group.end);
          cursor = section;
        } else {
          if (entry.card.parentElement !== stepsContainer || entry.card.previousElementSibling !== cursor) {
            if (cursor) cursor.after(entry.card); else stepsContainer.prepend(entry.card);
          }
          cursor = entry.card;
        }
        entry.card.classList.toggle("is-last-step", index === actions.length - 1);
        entry.card.classList.toggle("is-intent-highlighted", Boolean(highlightedRange
          && index >= highlightedRange.start && index <= highlightedRange.end));
        syncIntentMarker(entry, index);
        syncIntentEndMarker(entry, index);
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
      for (const [id, section] of intentSections) {
        if (seenGroups.has(id)) continue;
        section.remove();
        intentSections.delete(id);
      }
    }
    function updateCaptureState(capture) {
      const ids = new Set([currentCapture.activeActionId, capture.activeActionId]);
      for (const state of [currentCapture, capture]) {
        for (const item of state.activeCaptures || []) ids.add(item.actionId);
      }
      currentCapture = capture;
      for (const entry of cardEntries.values()) {
        if (!ids.has(entry.actionId)) continue;
        const action = currentActions[entry.index];
        if (action) ctx.syncCaptureState(entry, action, globalThis.RecorderCaptureState.resolve(action, capture));
      }
    }
    function patchSteps(actions, capture, changedIds) {
      const pageChanged = !readOnly && actions.some((action, index) =>
        changedIds.has(action.id) && stepPage(action) !== stepPage(currentActions[index]));
      currentActions = actions;
      updateCaptureState(capture);
      if (pageChanged) {
        updateSelection();
        notifySelectionSoon();
        updatePageSegments();
        resetStepWindow();
        renderWindow();
        return;
      }
      for (const id of changedIds) {
        const entry = cardEntries.get(`id:${id}`);
        if (!entry) continue;
        const action = actions[entry.index];
        if (!action) continue;
        const state = globalThis.RecorderCaptureState.resolve(action, capture);
        ctx.syncMedia(entry, action, entry.index, state);
        ctx.syncCaptureState(entry, action, state);
        syncStepText(entry, action);
      }
      if (!readOnly) for (const entry of cardEntries.values()) syncPageHeading(entry, entry.index);
    }
    function dispose() {
      if (windowFrame) cancelAnimationFrame(windowFrame);
      windowFrame = 0;
      resizeObserver.disconnect();
      topSpacer.remove();
      bottomSpacer.remove();
      virtualWindow.clear();
      currentActions = [];
      pageSegments = [];
      visibleIndices = [];
      intentByIndex = [];
      lastIntentGroup = null;
      stepsContainer.classList.remove("has-intent-groups");
      currentCapture = {};
      firstRender = true;
      highlightedRange = null;
      ctx.getObserver()?.disconnect();
      ctx.setObserver(null);
      for (const entry of cardEntries.values()) {
        ctx.releaseMedia(entry.beforeMedia);
        ctx.releaseMedia(entry.afterMedia);
        entry.card.remove();
      }
      cardEntries.clear();
      for (const section of intentSections.values()) section.remove();
      intentSections.clear();
      intentExpansion.clear();
      selectedActionIds.clear();
      pageSelections.clear();
      collapsedSegments.clear();
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
      refreshSelection();
    });
    deleteSelectedStepsBtn?.addEventListener("click", () => {
      deleteSelectedSteps().catch(error => {
        reportError(error.message);
        refreshSelection();
      });
    });
    return { dispose, renderSteps, patchSteps, updateCaptureState, setRecording, setScreenshotsExpandedDefault,
      selectedIndices,
      /** Selected step ids, for callers that must re-resolve them against fresh data. */
      selectedIds: () => selectedIndices().map(index => currentActions[index].id),
      clearSelection() {
        if (!selectedActionIds.size) return;
        selectedActionIds.clear();
        selectionAnchor = null;
        refreshSelection();
      },
      setSelectionListener(listener) {
        selectionListener = listener;
        listener?.(selectedIndices());
      },
      setIntentGroups(steps, onEdit) {
        intentSteps = steps;
        markerEditHandler = onEdit;
      },
      highlightRange(start, end, revealIndex) {
        highlightedRange = Number.isInteger(start) && Number.isInteger(end) ? { start, end } : null;
        const position = visibleIndices.indexOf(revealIndex);
        if (position >= 0 && visibleIndices.length > 200) {
          stepsContainer.scrollTop = virtualWindow.offsetAt(position) + noteHeight();
        }
        renderWindow();
        if (position >= 0) {
          const card = cardEntries.get(actionKey(currentActions[revealIndex], revealIndex))?.card;
          card?.scrollIntoView({ block: "nearest", inline: "nearest", container: "nearest" });
        }
      },
      setStepMarker: (provider, onEdit = markerEditHandler) => {
        markerProvider = provider;
        markerEditHandler = onEdit;
        renderWindow();
      },
      setStepEndMarker: provider => {
        endMarkerProvider = provider;
        renderWindow();
      },
      setWorkspaceContext: value => {
        if (workspaceContext.workspaceDraftId !== value?.workspaceDraftId) {
          collapsedSegments.clear();
          intentExpansion.clear();
        }
        workspaceContext = value || {};
      } };
  }
  window.RecorderStepView = { create };
}
export {};
