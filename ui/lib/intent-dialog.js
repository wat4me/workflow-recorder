/**
 * The annotation editor.
 *
 * Recording captures atomic actions; a test is made of logical steps that span
 * several of them. The header adds the next range, a marker edits its step,
 * and the annotation list lets the tester choose an existing step.
 *
 * A saved test step is drawn in front of the first recorded step it covers, with
 * an end rule when the following steps have no annotation yet. Nothing here is
 * generated: the plugin only offers the template, the step numbers and a place
 * to type; every word in the exported document is the tester's.
 */
(function () {
  if (globalThis.RecorderIntentDialog) return;

  const { escapeHtml } = globalThis.RecorderDom;
  // escapeHtml is for text nodes; inside an attribute a quote would end the value.
  const attr = text => escapeHtml(text).replace(/"/g, "&quot;");

  function t(key, fallback) {
    return globalThis.RecorderI18n?.t(key, [], fallback) || fallback;
  }

  /** Same as `t`, for strings that carry a value. */
  function tSub(key, substitutions, fallback) {
    return globalThis.RecorderI18n?.t(key, substitutions, fallback) || fallback;
  }

  let editorOpen = false;

  function newStepId() {
    return `step-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  }

  /**
   * The recorded steps each test step covers, straight from its own range.
   *
   * `open` means the test step runs to the end of the recording, which is what a
   * step inserted while recording does until it is closed.
   */
  function stepRanges(steps, stepCount = 0) {
    const sorted = Array.isArray(steps) ? [...steps].sort((a, b) => a.start - b.start) : [];
    return sorted.map(step => ({
      from: step.start,
      to: step.open ? stepCount : Math.min(step.end ?? stepCount, stepCount)
    }));
  }

  /**
   * Where the next, not yet annotated range starts.
   *
   * Each save appends one test step, so a fresh annotation always begins right
   * after the last covered recorded step. Steps that start past the recording
   * (a placeholder waiting for more recording) do not cover anything.
   */
  function nextUnannotatedStart(steps, stepCount = 0) {
    const list = Array.isArray(steps) ? steps : [];
    let covered = 0;
    for (const step of list) {
      const end = step?.open ? stepCount : Number(step?.end);
      if (!Number.isFinite(end)) continue;
      covered = Math.max(covered, Math.min(Math.round(end), stepCount));
    }
    return Math.min(covered + 1, stepCount + 1);
  }

  function firstUnannotatedRange(steps, stepCount) {
    let start = 1;
    for (const { from, to } of stepRanges(steps, stepCount)) {
      if (from > start && start <= stepCount) return { start, end: Math.min(from - 1, stepCount) };
      start = Math.max(start, to + 1);
    }
    return start <= stepCount ? { start, end: stepCount } : null;
  }


  /** Whether a test step carries anything the tester typed. */
  function hasStepText(step) {
    return Boolean((step?.title || "").trim() || (step?.purpose || "").trim()
      || (step?.note || "").trim()
      || String(step?.goal || "").trim()
      || (step?.preconditions || []).some(item => String(item).trim())
      || (step?.checks || []).some(check => String(check).trim())
      || (step?.pass || []).some(item => String(item).trim()));
  }

  /**
   * Puts a new test step into the list, letting it claim its range.
   *
   * When the range is already covered -- the recorded steps were all annotated
   * as one block before the tester split them -- the new test step takes its
   * range out of the old one instead of being refused. Text in front of the new
   * range stays with the old step; everything after it is left unannotated for
   * the next save. An empty new step may not delete a filled one, so a stray
   * click on save cannot wipe the tester's words.
   */
  function placeNewStep(existingSteps, addedStep, stepCount = 0) {
    const list = Array.isArray(existingSteps) ? existingSteps : [];
    const added = { ...addedStep, open: addedStep.open === true || addedStep.end >= stepCount };
    const placed = [];
    let droppedText = false;
    for (const step of list) {
      const start = Number(step?.start);
      const end = step?.open ? stepCount : Number(step?.end);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > stepCount) {
        placed.push(step);
        continue;
      }
      if (start > added.end || end < added.start) {
        placed.push(step);
        continue;
      }
      // The new range owns the overlap. Only the part in front of it keeps the
      // old text; the rest is left unannotated so the tester can describe it
      // with the next save instead of inheriting words for another range.
      let keptText = false;
      if (start < added.start) {
        const left = { ...step, end: Math.min(end, added.start - 1), open: false };
        if (hasStepText(left)) {
          placed.push(left);
          keptText = true;
        }
      }
      if (hasStepText(step) && !keptText) droppedText = true;
    }
    if (droppedText && !hasStepText(added)) return { error: "intentEmptySplit" };
    placed.push(added);
    return { steps: placed.sort((a, b) => a.start - b.start) };
  }

  /**
   * Soft checks on what the tester typed.
   *
   * Nothing here blocks a save: the tester knows which of these are deliberate.
   * The hard conflicts -- overlapping ranges -- are refused separately, because
   * storing them would silently drop one of them.
   */
  function validateIntent(intent) {
    const warnings = [];
    if (!intent || typeof intent !== "object") return warnings;
    const steps = Array.isArray(intent.steps) ? intent.steps : [];
    for (const step of steps) {
      if (step?.ignore && (String(step.goal || "").trim()
        || (step.preconditions || []).length > 0
        || (step.checks || []).length > 0 || (step.pass || []).length > 0)) {
        warnings.push("checkOnSkippedStep");
        break;
      }
    }
    return warnings;
  }

  const WARNING_TEXT = {
    checkOnSkippedStep: ["intentCheckOnSkippedStep", "标记为“不参与测试”的步骤里填了前置条件、验证点或通过标准"]
  };

  function mountExtraSection(rowEl) {
    const extra = rowEl.querySelector(".intent-extra-section");
    const extraCount = extra.querySelector(".intent-extra-count");
    const extraFields = [...extra.querySelectorAll("input, textarea")];
    const updateExtraCount = () => {
      const count = extraFields.filter(field => field.type === "checkbox" ? field.checked : field.value.trim()).length;
      extraCount.hidden = count === 0;
      extraCount.textContent = count ? tSub("intentExtraCount", [String(count)], `已填 ${count} 项`) : "";
    };
    extra.addEventListener("input", updateExtraCount);
    updateExtraCount();
  }

  function rangeLabel(from, to, stepCount) {
    if (from === stepCount + 1 && to === stepCount) return t("intentPendingRange", "等待录制");
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > stepCount || from > to) {
      return t("intentRangeInvalidShort", "范围无效");
    }
    return tSub("intentStepRange", [String(from), String(to)], `第 ${from}–${to} 步`);
  }

  function renderRangePreview(row, actions, from, to) {
    const list = row.querySelector(".intent-range-preview");
    const valid = Number.isInteger(from) && Number.isInteger(to)
      && from >= 1 && from <= to && to <= actions.length;
    list.hidden = !valid;
    const items = document.createDocumentFragment();
    for (let number = from; valid && number <= to; number++) {
      const item = document.createElement("li");
      const index = document.createElement("span");
      index.className = "intent-range-preview-number";
      index.textContent = String(number);
      const description = document.createElement("span");
      description.className = "intent-range-preview-description";
      description.textContent = globalThis.StepDocGenerator.describeStep(actions[number - 1]).desc;
      description.title = description.textContent;
      item.append(index, description);
      items.append(item);
    }
    list.replaceChildren(items);
    list.scrollTop = 0;
  }

  function stepRow(step, stepCount, index, range, showRangePreview) {
    const start = Number.isInteger(step?.start) ? step.start : 1;
    const end = Number.isInteger(step?.end) ? step.end : stepCount;
    const goal = step?.goal || "";
    const preconditions = (step?.preconditions || []).join("\n");
    const checks = (step?.checks || []).join("\n");
    const pass = (step?.pass || []).join("\n");
    return `<li class="intent-step-row" data-index="${index}">
      <div class="intent-step-head">
        <div class="intent-range-heading">
          <span class="intent-field-label">${escapeHtml(t("intentStepRangeHint", "录制范围"))}</span>
          <output class="intent-step-range">${escapeHtml(rangeLabel(range.from, range.to, stepCount))}</output>
        </div>
        <label class="intent-field intent-field--position">
          <span class="intent-field-label">${escapeHtml(t("intentStepStart", "从第几步开始"))}</span>
          <input type="number" min="1" max="${stepCount + 1}" step="1" class="intent-step-position" value="${start}" required>
        </label>
        <label class="intent-field intent-field--position">
          <span class="intent-field-label">${escapeHtml(t("intentStepEnd", "到第几步结束"))}</span>
          <input type="number" min="0" max="${stepCount}" step="1" class="intent-step-end" value="${end}" required>
        </label>
        ${showRangePreview ? `<ul class="intent-range-preview" tabindex="0"
          aria-label="${attr(t("operationSteps", "操作步骤"))}" hidden></ul>` : ""}
      </div>
      <label class="intent-field">
        <span class="intent-field-label">${escapeHtml(t("intentStepTitleLabel", "阶段名称"))}</span>
        <input type="text" class="intent-step-title" maxlength="120" value="${attr(step?.title || "")}"
          placeholder="${attr(t("intentStepTitlePlaceholder", "示例：选择关联文档；留空则导出为“测试步骤 N”"))}">
      </label>
      <label class="intent-field">
        <span class="intent-field-label">${escapeHtml(t("intentGoal", "测试目标"))}</span>
        <textarea class="intent-step-goal" rows="2" spellcheck="false"
          placeholder="${attr(t("intentGoalPlaceholder", "示例：验证关联文档的上传与回显"))}">${escapeHtml(goal)}</textarea>
      </label>
      <label class="intent-field">
        <span class="intent-field-label">${escapeHtml(t("intentStepChecksLabel", "验证点"))}</span>
        <textarea class="intent-step-checks" rows="2" spellcheck="false"
          placeholder="${attr(t("intentStepChecksPlaceholder", "示例：保存后列表出现关联文档（每行一个）"))}">${escapeHtml(checks)}</textarea>
      </label>
      <details class="intent-form-section intent-extra-section">
        <summary>
          <span>${escapeHtml(t("intentExtraDetails", "补充说明"))}</span>
          <span class="intent-section-count intent-extra-count" hidden></span>
        </summary>
        <div class="intent-section-fields">
          <label class="intent-field">
            <span class="intent-field-label">${escapeHtml(t("intentPassCriteria", "通过标准"))}</span>
            <textarea class="intent-step-pass" rows="2" spellcheck="false"
              placeholder="${attr(t("intentStepPassPlaceholder", "示例：上传成功的文件能被正常读取（每行一个）"))}">${escapeHtml(pass)}</textarea>
          </label>
          <label class="intent-field">
            <span class="intent-field-label">${escapeHtml(t("intentPreconditions", "前置条件"))}</span>
            <textarea class="intent-step-preconditions" rows="2" spellcheck="false"
              placeholder="${attr(t("intentStepPreconditionsPlaceholder", "示例：已登录，且已打开目标页面（每行一个）"))}">${escapeHtml(preconditions)}</textarea>
          </label>
          <label class="intent-field">
            <span class="intent-field-label">${escapeHtml(t("intentStepPurposeLabel", "本段目的"))}</span>
            <textarea class="intent-step-purpose" rows="2" spellcheck="false"
              placeholder="${attr(t("intentStepPurposePlaceholder", "示例：确认选择、保存、回显都正常"))}">${escapeHtml(step?.purpose || "")}</textarea>
          </label>
          <label class="intent-field">
            <span class="intent-field-label">${escapeHtml(t("intentStepNoteLabel", "注意事项"))}</span>
            <input type="text" class="intent-step-note" maxlength="1000" value="${attr(step?.note || "")}"
              placeholder="${attr(t("intentStepNotePlaceholder", "示例：附件超过 15MB 会被拒绝"))}">
          </label>
          <label class="intent-step-ignore">
            <input type="checkbox" class="intent-step-skip"${step?.ignore ? " checked" : ""}>
            <span>${escapeHtml(t("intentStepIgnoreLabel", "不参与测试"))}</span>
          </label>
        </div>
      </details>
    </li>`;
  }

  /** "测试步骤 N · 标题", the one heading format for a test step everywhere it is listed. */
  function stepLabel(step, index) {
    const label = tSub("intentStepHeading", [String(index + 1)], `测试步骤 ${index + 1}`);
    return step?.title ? `${label} · ${step.title}` : label;
  }

  function stepDetail(step) {
    return step.ignore ? t("intentStepSkipped", "不参与测试")
      : step.goal || step.purpose || (step.checks || []).find(Boolean) || step.note || "";
  }

  /** The marker drawn in the card a test step starts at, or null. */
  function stepMarker(steps, cardIndex) {
    const position = (steps || []).findIndex(step => step.start === cardIndex + 1);
    if (position < 0) return null;
    const step = steps[position];
    return {
      label: stepLabel(step, position),
      detail: stepDetail(step)
    };
  }

  /**
   * The closing rule below a test step's last recorded step. Omitted when the
   * next test step starts right there: its marker is already the divider.
   */
  function stepEndMarker(steps, cardIndex, stepCount) {
    const list = steps || [];
    const position = list.findIndex(step => step.end === cardIndex + 1 && step.end < stepCount
      && !step.open && step.end >= step.start);
    if (position < 0) return null;
    const step = list[position];
    if (list.some(other => other.start === step.end + 1)) return null;
    return { label: tSub("intentStepEndHeading", [String(position + 1)], `测试步骤 ${position + 1} 结束`) };
  }

  /**
   * Test steps whose recorded range shares a step with `range`, except `except`.
   * A placeholder still waiting for recording covers nothing.
   */
  function overlappingSteps(steps, range, stepCount, except = null) {
    return (steps || []).filter(step => {
      if (step === except || !Number.isInteger(step?.start) || step.start > stepCount) return false;
      const end = step.open ? stepCount : Math.min(step.end ?? stepCount, stepCount);
      return step.start <= end && step.start <= range.end && end >= range.start;
    });
  }

  /**
   * The range a selection annotates: first to last selected step, 1-based.
   * A test step is contiguous, so unselected steps in between are included and
   * reported as `gaps`.
   */
  function selectionRange(indices) {
    if (!indices?.length) return null;
    const start = Math.min(...indices) + 1;
    const end = Math.max(...indices) + 1;
    return { start, end, gaps: end - start + 1 > new Set(indices).size };
  }

  /** "标注第 2–5 步", the action label for a selected range. */
  function annotateRangeLabel(range) {
    return range.start === range.end
      ? tSub("intentAnnotateStep", [String(range.start)], `标注第 ${range.start} 步`)
      : tSub("intentAnnotateRange", [String(range.start), String(range.end)], `标注第 ${range.start}–${range.end} 步`);
  }

  /**
   * Asks before a new range replaces existing test steps; their whole
   * annotation is discarded on save. Steps already in `confirmed` are not asked
   * about again, and newly accepted ones are added to it.
   */
  async function confirmReplace(steps, { allSteps = [], stepCount = 0, confirmText, confirmed = new Set() } = {}) {
    const unconfirmed = steps.filter(step => !confirmed.has(step));
    if (!unconfirmed.length) return true;
    const ranges = stepRanges(allSteps, stepCount);
    const sorted = [...allSteps].sort((a, b) => a.start - b.start);
    const names = unconfirmed.map(step => {
      const index = allSteps.indexOf(step);
      const range = ranges[sorted.indexOf(step)] || { from: step.start, to: step.end };
      return tSub("intentOverlapItem", [stepLabel(step, index), String(range.from), String(range.to)],
        `「${stepLabel(step, index)}」（第 ${range.from}–${range.to} 步）`);
    }).join(t("listSeparator", "、"));
    const accepted = await globalThis.RecorderDialogs.confirmAction({
      title: t("intentOverlapDiscardTitle", "覆盖已有标注"),
      message: tSub("intentOverlapDiscardMessage", [names], `所选范围包含${names}。保存后，这些测试步骤原有的标注会被丢弃。`),
      confirmText: confirmText || t("intentOverlapDiscardContinue", "继续选择"),
      danger: true
    });
    if (accepted) for (const step of unconfirmed) confirmed.add(step);
    return accepted;
  }

  function chooseStep(steps, stepCount, canAdd) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay intent-overlay";
      const ranges = stepRanges(steps, stepCount);
      overlay.innerHTML = `
        <div class="confirm-dialog intent-dialog intent-picker" role="dialog" aria-modal="true" aria-labelledby="intent-picker-title">
          <header class="intent-dialog-header">
            <h3 id="intent-picker-title">${escapeHtml(t("intentManage", "查看标注"))}</h3>
          </header>
          <div class="confirm-content">
            <ul class="intent-picker-list">${steps.map((step, index) => {
              const range = ranges[index];
              const detail = stepDetail(step);
              return `<li><button type="button" class="intent-picker-item" data-step-index="${index}">
                <span class="intent-picker-content"><strong>${escapeHtml(stepLabel(step, index))}</strong>
                  <small>${escapeHtml(rangeLabel(range.from, range.to, stepCount))}</small>
                  ${detail ? `<small class="intent-picker-detail" title="${attr(detail)}">${escapeHtml(detail)}</small>` : ""}</span>
                <span class="intent-picker-edit">${escapeHtml(t("edit", "编辑"))}</span>
              </button></li>`;
            }).join("")}</ul>
          </div>
          <footer class="intent-dialog-footer">
            <div class="confirm-actions">
              <button type="button" class="confirm-cancel">${escapeHtml(t("close", "关闭"))}</button>
              ${canAdd ? `<button type="button" class="confirm-submit">${escapeHtml(t(
                nextUnannotatedStart(steps, stepCount) <= stepCount ? "intentNewStep" : "intentSplitStep", "新增测试步骤"
              ))}</button>` : ""}
            </div>
          </footer>
        </div>`;
      function finish(value) {
        // Focus goes back to the opener even when the editor follows, so the
        // editor in turn returns it there.
        close();
        resolve(value);
      }
      overlay.querySelector(".intent-picker-list").addEventListener("click", event => {
        const button = event.target.closest(".intent-picker-item");
        if (button) finish(Number(button.dataset.stepIndex));
      });
      overlay.querySelector(".confirm-cancel").addEventListener("click", () => finish(undefined));
      overlay.querySelector(".confirm-submit")?.addEventListener("click", () => finish(null));
      const close = globalThis.RecorderDialogs.openModal(overlay, { onDismiss: () => finish(undefined) });
      overlay.querySelector(".intent-picker-item")?.focus({ preventScroll: true });
    });
  }

  /**
   * Opens the editor. Resolves with the annotation, or null when cancelled.
   *
   * `stepCount` bounds every boundary so no row can point past the recording.
   * `stepIndex` opens the editor for that one test step only; without it the
   * dialog starts a new, blank test step for the next unannotated range.
   */
  async function open(options) {
    if (editorOpen) return null;
    editorOpen = true;
    try {
      return await openEditor(options);
    } finally {
      editorOpen = false;
    }
  }

  async function openEditor({ intent = null, stepCount = 0, stepIndex = null, manage = false, actions = [], save,
    container = null, initialRange = null, onRangeChange = () => {}, onReady = null, resolveOverlap = null, signal } = {}) {
    const trigger = document.activeElement;
    const steps = Array.isArray(intent?.steps) ? intent.steps : [];
    const last = steps.at(-1);
    const canAdd = nextUnannotatedStart(steps, stepCount) <= stepCount || last?.end > last?.start;
    // A given range is a decision already made: go straight to the new step.
    if (!container && !initialRange && !Number.isInteger(stepIndex) && steps.length && (manage || !canAdd)) {
      stepIndex = await chooseStep(steps, stepCount, canAdd);
      if (stepIndex === undefined) {
        trigger?.focus();
        return null;
      }
    }
    return new Promise(resolve => {
      const existingSteps = Array.isArray(intent?.steps) ? intent.steps : [];
      // Copy the focused row: the dialog mutates data values while editing, and
      // cancelling must leave the stored annotation untouched.
      const focused = Number.isInteger(stepIndex) && existingSteps[stepIndex]
        ? structuredClone(existingSteps[stepIndex]) : null;
      const nextStart = nextUnannotatedStart(existingSteps, stepCount);
      const lastStep = [...existingSteps].sort((a, b) => a.start - b.start).at(-1);
      // Every recorded step is covered, but the last test step still spans more
      // than one step: the header can split a new one out of it. Without this,
      // annotating the whole recording once leaves no way to divide it later.
      const canSplit = !focused && nextStart > stepCount
        && Number.isInteger(lastStep?.start) && lastStep.end - lastStep.start + 1 >= 2;
      const splitMode = !initialRange && canSplit;
      const adding = !focused && (initialRange || nextStart <= stepCount || splitMode);
      const start = initialRange?.start ?? (splitMode ? lastStep.start : nextStart);
      // In split mode leave the last recorded step with the old section; the
      // tester moves the end back to the real split point.
      const end = initialRange?.end ?? (splitMode ? Math.max(lastStep.start, stepCount - 1) : stepCount);
      const addedStep = adding ? {
        id: newStepId(),
        title: "",
        goal: "",
        purpose: "",
        start,
        end,
        open: end >= stepCount,
        note: "",
        preconditions: [],
        checks: [],
        pass: [],
        ignore: false
      } : null;
      const overlay = document.createElement("div");
      overlay.className = container ? "preview-intent-editor" : "confirm-overlay intent-overlay";

      overlay.innerHTML = `
        <div class="intent-dialog ${container ? "intent-inline-dialog" : "confirm-dialog"}"
          role="${container ? "region" : "dialog"}" ${container ? "" : 'aria-modal="true"'} aria-labelledby="intent-title">
          <header class="intent-dialog-header">
            <h3 id="intent-title">${escapeHtml(focused
              ? tSub("intentFocusedTitle", [String(stepIndex + 1)], `编辑测试步骤 ${stepIndex + 1}`)
              : t(splitMode ? "intentSplitStep" : "intentNewStep", splitMode ? "切分测试步骤" : "新增测试步骤"))}</h3>
            ${splitMode ? `<p class="intent-hint">${escapeHtml(t("intentSplitHelp", "所选范围会使用新标注，原分段中位于其后的录制步骤可另行标注。"))}</p>` : ""}
          </header>
          <div class="confirm-content">
            <ul class="intent-step-list"></ul>
          </div>
          <footer class="intent-dialog-footer">
            <ul class="intent-warning-list" role="status" hidden></ul>
            <p class="intent-error" role="alert" hidden></p>
            <div class="confirm-actions">
              <button type="button" class="confirm-cancel">${escapeHtml(t("cancel", "取消"))}</button>
              <button type="button" class="confirm-submit"${adding || focused ? "" : " disabled"}>${escapeHtml(t("intentSave", "保存标注"))}</button>
            </div>
          </footer>
        </div>`;

      const list = overlay.querySelector(".intent-step-list");
      const errorEl = overlay.querySelector(".intent-error");
      const warningEl = overlay.querySelector(".intent-warning-list");
      const submitBtn = overlay.querySelector(".confirm-submit");
      const cancelBtn = overlay.querySelector(".confirm-cancel");
      let acknowledged = false;
      let submitting = false;
      const rows = focused ? [focused] : addedStep ? [addedStep] : [];

      const render = () => {
        const ranges = stepRanges(rows, stepCount);
        const showRangePreview = !container && actions.length > 0 && Boolean(globalThis.StepDocGenerator);
        list.innerHTML = rows.map((step, index) => stepRow(step, stepCount, index, ranges[index], showRangePreview)).join("");
        list.hidden = rows.length === 0;
        rows.forEach((step, index) => {
          const row = list.querySelector(`.intent-step-row[data-index="${index}"]`);
          mountExtraSection(row);
          const startField = row.querySelector(".intent-step-position");
          const endField = row.querySelector(".intent-step-end");
          const output = row.querySelector(".intent-step-range");
          const updateRange = edge => {
            const from = startField.valueAsNumber;
            const to = endField.valueAsNumber;
            output.textContent = rangeLabel(from, to, stepCount);
            if (showRangePreview) renderRangePreview(row, actions, from, to);
            onRangeChange(from, to, edge);
          };
          for (const [field, edge] of [[startField, "start"], [endField, "end"]]) {
            field.addEventListener("input", () => updateRange(edge));
          }
          updateRange("start");
        });
      };

      /**
       * Reads the form back. `sort: false` keeps the DOM order.
       */
      const collect = ({ sort = true } = {}) => {
        const steps = [...list.querySelectorAll(".intent-step-row")].map((row, index) => {
          const start = Number(row.querySelector(".intent-step-position").value);
          const end = Number(row.querySelector(".intent-step-end").value);
          const source = rows[index] || {};
          return {
            id: source.id || newStepId(),
            title: row.querySelector(".intent-step-title").value.trim(),
            purpose: row.querySelector(".intent-step-purpose").value.trim(),
            goal: row.querySelector(".intent-step-goal").value.trim(),
            start: Number.isFinite(start) ? Math.min(Math.max(Math.round(start), 1), stepCount + 1) : 1,
            end: Number.isFinite(end) ? Math.min(Math.max(Math.round(end), 0), stepCount) : stepCount,
            open: false,
            note: row.querySelector(".intent-step-note").value.trim(),
            preconditions: row.querySelector(".intent-step-preconditions").value.split("\n").map(line => line.trim()).filter(Boolean),
            checks: row.querySelector(".intent-step-checks").value.split("\n").map(line => line.trim()).filter(Boolean),
            pass: row.querySelector(".intent-step-pass").value.split("\n").map(line => line.trim()).filter(Boolean),
            ignore: row.querySelector(".intent-step-skip").checked
          };
        });
        const sorted = [...steps].sort((a, b) => a.start - b.start);
        // A test step that ends at the end of the recording keeps growing as
        // more steps are recorded, which is what an inserted placeholder needs.
        const last = sorted[sorted.length - 1];
        if (last && last.end >= stepCount) last.open = true;
        return { steps: sort ? sorted : steps };
      };

      // As a modal, Escape and Tab belong to the shared modal contract; inline in
      // the workbench pane, Escape still cancels while focus is in the editor.
      function onKeyDown(event) {
        if (container && event.key === "Escape") {
          event.preventDefault();
          finish(null);
        }
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          submit();
        }
      }

      function abort() { finish(null, true); }

      const finish = (result, aborted = false) => {
        if (submitting && !result && !aborted) return;
        if (container) overlay.removeEventListener("keydown", onKeyDown);
        signal?.removeEventListener("abort", abort);
        if (container) {
          overlay.remove();
          if (!aborted && trigger?.isConnected) trigger.focus({ preventScroll: true });
        } else {
          close({ restoreFocus: !aborted });
        }
        resolve(result);
      };

      const submit = async () => {
        if (submitting || !rows.length || signal?.aborted) return;
        const invalidRange = [...list.querySelectorAll('input[type="number"]')]
          .find(input => !input.checkValidity());
        if (invalidRange) {
          errorEl.textContent = t("intentRangeInvalidShort", "范围无效");
          errorEl.hidden = false;
          invalidRange.focus();
          return;
        }
        const collected = collect();
        const edited = collected.steps[0];
        // With `resolveOverlap`, a range that covers other test steps may replace
        // them once the caller agrees; without it, overlap stays a hard refusal.
        let kept = existingSteps;
        if (resolveOverlap && edited && edited.start <= edited.end) {
          const overlapping = overlappingSteps(existingSteps, edited, stepCount, focused ? existingSteps[stepIndex] : null);
          if (overlapping.length) {
            if (!(await resolveOverlap(overlapping)) || signal?.aborted) return;
            kept = existingSteps.filter(step => !overlapping.includes(step));
          }
        }
        // Focused mode edits one row and keeps everything else exactly as it was
        // read, so annotating step 2 cannot drop step 1.
        let next;
        // The goal, preconditions and pass criteria are per step now; never
        // carry the deprecated case-level values forward into a new annotation.
        const { note: _legacyNote, setup: _legacySetup, pass: _legacyPass, ...intentRest } = intent || {};
        if (focused) {
          next = {
            ...intentRest,
            steps: kept.map(step => (step === existingSteps[stepIndex]
              ? { ...edited, id: step.id }
              : step)).sort((a, b) => a.start - b.start)
          };
        } else {
          const placed = initialRange ? { steps: [...kept, edited] } : adding
            ? placeNewStep(kept, edited, stepCount)
            : { steps: kept };
          if (placed.error) {
            errorEl.textContent = t("intentEmptySplit", "新分段还没有填写内容，保存会清空原有标注；请先填写内容");
            errorEl.hidden = false;
            return;
          }
          next = {
            ...intentRest,
            steps: placed.steps
          };
        }

        // A placeholder waiting for more recording is empty on purpose; every
        // other test step must own at least one recorded step.
        const pendingPlaceholder = step => step.start === stepCount + 1 && step.end === stepCount;
        for (const step of next.steps) {
          if (!pendingPlaceholder(step) && step.start > step.end) {
            errorEl.textContent = t("intentRangeInvalid", "结束步骤不能早于开始步骤");
            errorEl.hidden = false;
            return;
          }
        }

        const active = next.steps.filter(step => !pendingPlaceholder(step) && step.start <= step.end)
          .sort((a, b) => a.start - b.start);
        // Two test steps covering the same recorded step would silently drop one
        // of them on the way in, so this is a hard refusal.
        for (let index = 1; index < active.length; index += 1) {
          if (active[index].start <= active[index - 1].end) {
            errorEl.textContent = t("intentOverlap", "两个测试步骤覆盖了同一步，请调整起止位置");
            errorEl.hidden = false;
            return;
          }
        }
        errorEl.hidden = true;

        // Everything else is the tester's call: show it once, and a second click
        // saves. The button says so, so nothing is lost by accident.
        const warnings = acknowledged ? [] : validateIntent(next);
        if (warnings.length > 0) {
          acknowledged = true;
          warningEl.innerHTML = warnings
            .map(key => `<li>${escapeHtml(t(WARNING_TEXT[key][0], WARNING_TEXT[key][1]))}</li>`).join("");
          warningEl.hidden = false;
          submitBtn.textContent = t("intentSaveAnyway", "仍然保存");
          return;
        }
        submitting = true;
        submitBtn.disabled = true;
        cancelBtn.disabled = true;
        submitBtn.textContent = t("intentSaving", "正在保存…");
        try {
          const saved = await save(next);
          if (!saved?.success) throw new Error(saved?.error || t("intentSaveFailed", "保存标注失败"));
        } catch (error) {
          submitting = false;
          submitBtn.disabled = false;
          cancelBtn.disabled = false;
          submitBtn.textContent = t("intentSave", "保存标注");
          errorEl.textContent = error?.message || t("intentSaveFailed", "保存标注失败");
          errorEl.hidden = false;
          return;
        }
        finish(next);
      };

      overlay.querySelector(".confirm-submit").addEventListener("click", submit);
      cancelBtn.addEventListener("click", () => finish(null));
      // A long form: a stray click on the backdrop must not throw the typing away.
      let close = null;
      if (container) {
        overlay.addEventListener("keydown", onKeyDown);
        container.append(overlay);
      } else {
        close = globalThis.RecorderDialogs.openModal(overlay, {
          onDismiss: () => finish(null), dismissOnBackdrop: false, onKeyDown
        });
      }
      signal?.addEventListener("abort", abort, { once: true });
      render();
      // Lets the workbench drive the range from its step list. The fields stay
      // the source of truth, so typed and picked ranges validate the same way.
      onReady?.({
        setRange(from, to) {
          const row = list.querySelector(".intent-step-row");
          if (!row) return;
          const startField = row.querySelector(".intent-step-position");
          const endField = row.querySelector(".intent-step-end");
          startField.value = String(from);
          endField.value = String(to);
          startField.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      overlay.querySelector(".intent-step-title")?.focus();
    });
  }

  globalThis.RecorderIntentDialog = { open, overlappingSteps, selectionRange, annotateRangeLabel, confirmReplace, stepLabel, stepMarker, stepEndMarker, stepRanges, firstUnannotatedRange, nextUnannotatedStart, placeNewStep, validateIntent };
})();
