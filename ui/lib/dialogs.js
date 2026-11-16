/**
 * Modal and toast replacements for the native dialogs.
 *
 * alert(), confirm() and prompt() all freeze the whole side panel, cannot be
 * styled, and cannot be localized, so none of them are used anywhere in the UI.
 * Each function here resolves a promise instead and cleans up its own listeners.
 */
(function () {
  if (globalThis.RecorderDialogs) return;

  const { t } = globalThis.RecorderI18n;
  const { escapeHtml } = globalThis.RecorderDom;

  /**
   * Every modal shares one keyboard and focus contract: Escape dismisses the
   * topmost modal only, Tab stays inside it, the page behind it is inert, and
   * focus returns to the control that opened it.
   */
  const modalStack = [];
  let lastFocused = null;
  document.addEventListener("focusin", event => { lastFocused = event.target; }, true);
  const FOCUSABLE = "a[href], button, input, select, textarea, summary, [tabindex]";

  function focusableIn(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(element => {
      if (element.disabled || (element.tabIndex < 0 && !element.matches("summary"))) return false;
      // Content of a collapsed <details> is not reachable; its own summary is.
      const collapsed = element.closest("details:not([open])");
      if (collapsed && !(element.matches("summary") && element.parentElement === collapsed)) return false;
      return element.getClientRects().length > 0;
    });
  }

  function trapFocus(event, root) {
    const focusable = focusableIn(root);
    if (!focusable.length) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable.at(-1);
    const active = document.activeElement;
    if (!root.contains(active)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey ? active === first : active === last) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  document.addEventListener("keydown", event => {
    const top = modalStack.at(-1);
    if (!top) return;
    if (event.key === "Escape" && !event.isComposing) {
      // Capture phase plus stopPropagation: page-level Escape handlers (menus,
      // panels) must not also act on the key that closed the modal.
      event.preventDefault();
      event.stopPropagation();
      top.dismiss();
      return;
    }
    if (event.key === "Tab") trapFocus(event, top.overlay);
    top.onKeyDown?.(event);
  }, true);

  /**
   * Shows `overlay` as a modal. Returns `close()`, which hides it, re-enables
   * the page and restores focus. `onDismiss` runs for Escape and, unless
   * `dismissOnBackdrop` is false, for a click on the backdrop.
   */
  function openModal(overlay, { onDismiss, dismissOnBackdrop = true, onKeyDown = null, remove = true } = {}) {
    // A button that disables itself while it prepares the dialog has already
    // dropped focus to <body>; it is still the control the user pressed.
    const active = document.activeElement;
    const trigger = active && active !== document.body ? active : lastFocused;
    const background = [...document.body.children].filter(element => element !== overlay && !element.inert
      && !element.matches(".recorder-toast-stack"));
    for (const element of background) element.inert = true;
    const entry = { overlay, dismiss: () => onDismiss?.(), onKeyDown };
    modalStack.push(entry);

    // A press that starts inside the dialog and ends on the backdrop (selecting
    // text, dragging a slider) is not a backdrop click.
    let pressedBackdrop = false;
    const onPointerDown = event => { pressedBackdrop = event.target === overlay; };
    const onClick = event => {
      if (dismissOnBackdrop && pressedBackdrop && event.target === overlay) onDismiss?.();
      pressedBackdrop = false;
    };
    overlay.addEventListener("pointerdown", onPointerDown);
    overlay.addEventListener("click", onClick);
    if (!overlay.isConnected) document.body.appendChild(overlay);

    let closed = false;
    return function close({ restoreFocus = true } = {}) {
      if (closed) return;
      closed = true;
      overlay.removeEventListener("pointerdown", onPointerDown);
      overlay.removeEventListener("click", onClick);
      const index = modalStack.indexOf(entry);
      if (index >= 0) modalStack.splice(index, 1);
      const focusInside = overlay.contains(document.activeElement);
      if (remove) overlay.remove();
      for (const element of background) element.inert = false;
      if (restoreFocus && (focusInside || focusLost())) returnFocus(trigger);
    };
  }

  const focusLost = () => !document.activeElement || document.activeElement === document.body;

  /** Focuses `element` now, or as soon as its busy state ends if it is disabled. */
  function returnFocus(element) {
    if (!element?.isConnected) return;
    if (!element.disabled) {
      element.focus({ preventScroll: true });
      return;
    }
    const observer = new MutationObserver(() => {
      if (element.disabled) return;
      observer.disconnect();
      clearTimeout(timer);
      if (element.isConnected && focusLost()) element.focus({ preventScroll: true });
    });
    const timer = setTimeout(() => observer.disconnect(), 10000);
    observer.observe(element, { attributes: true, attributeFilter: ["disabled"] });
  }

  /** Non-blocking status message. Styled by `.recorder-toast` with the page theme tokens. */
  function notify(message, { danger = false, timeoutMs = 4000 } = {}) {
    if (!message) return;
    let stack = document.querySelector(".recorder-toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "recorder-toast-stack";
      stack.setAttribute("role", "status");
      stack.setAttribute("aria-live", "polite");
      document.body.appendChild(stack);
    }

    const toast = document.createElement("div");
    toast.className = `recorder-toast${danger ? " danger" : ""}`;
    toast.textContent = String(message);
    stack.appendChild(toast);

    const remove = () => {
      toast.remove();
      if (!stack.childElementCount) stack.remove();
    };
    toast.addEventListener("click", remove);
    setTimeout(remove, Math.max(1200, timeoutMs));
    return remove;
  }

  function reportError(message) {
    return notify(message || t("unexpectedError", [], "操作失败"), { danger: true, timeoutMs: 6000 });
  }

  function confirmAction({
    title = t("confirmAction", [], "确认操作"),
    message = t("confirmContinue", [], "确定继续吗？"),
    confirmText = t("confirm", [], "确认"),
    danger = false
  } = {}) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.setAttribute("role", "presentation");
      overlay.innerHTML = `
        <div class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message">
          <div class="confirm-icon ${danger ? "danger" : ""}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4"></path><path d="M12 17h.01"></path><path d="M10.3 3.8 2.3 18a2 2 0 0 0 1.7 3h16a2 2 0 0 0 1.7-3l-8-14.2a2 2 0 0 0-3.4 0Z"></path>
            </svg>
          </div>
          <div class="confirm-content">
            <h3 id="confirm-title"></h3>
            <p id="confirm-message"></p>
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel">${escapeHtml(t("cancel", [], "取消"))}</button>
            <button type="button" class="confirm-submit ${danger ? "danger" : ""}"></button>
          </div>
        </div>`;

      overlay.querySelector("#confirm-title").textContent = title;
      overlay.querySelector("#confirm-message").textContent = message;
      overlay.querySelector(".confirm-submit").textContent = confirmText;
      const cancelButton = overlay.querySelector(".confirm-cancel");
      const submitButton = overlay.querySelector(".confirm-submit");

      // Escape cancels. Enter is left to the focused button: the default focus
      // is Cancel, so a global Enter handler used to confirm the very deletion
      // the user was backing out of.
      const finish = result => {
        close();
        resolve(result);
      };
      const close = openModal(overlay, { onDismiss: () => finish(false) });

      cancelButton.addEventListener("click", () => finish(false));
      submitButton.addEventListener("click", () => finish(true));
      cancelButton.focus();
    });
  }

  function limitNameInput(input, maxLength = 120) {
    input.maxLength = maxLength;
    input.value = input.value.slice(0, maxLength);
    const counter = document.createElement("small");
    counter.className = "name-length-counter";
    const update = () => {
      counter.textContent = t("nameLengthHint", [input.value.length, maxLength], `${input.value.length} / ${maxLength}`);
    };
    input.after(counter);
    input.addEventListener("input", update);
    input.addEventListener("paste", event => {
      if (!event.clipboardData) return;
      event.preventDefault();
      const start = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? start;
      const available = Math.max(0, maxLength - (input.value.length - (end - start)));
      const text = event.clipboardData.getData("text/plain").slice(0, available).replace(/[\r\n]/g, " ");
      input.setRangeText(text, start, end, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    update();
  }

  /** Resolves with text and any extra fields, or null if cancelled. A null value omits the text field. */
  function promptText({
    title = t("confirmAction", [], "确认操作"),
    message = "",
    label = "",
    confirmText = t("confirm", [], "确认"),
    value = "",
    maxLength = 120,
    multiline = false,
    selection = null,
    validate = null,
    checkbox = null
  } = {}) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.setAttribute("role", "presentation");
      overlay.innerHTML = `
        <div class="confirm-dialog save-recording-dialog prompt-text-dialog" role="dialog" aria-modal="true" aria-labelledby="prompt-title">
          <div class="confirm-content">
            <h3 id="prompt-title"></h3>
            <p id="prompt-message"></p>
            ${value === null ? "" : `<label class="recording-name-field">
              <span></span>
              ${multiline ? '<textarea rows="4" spellcheck="false"></textarea>' : '<input type="text" autocomplete="off">'}
            </label>`}
            ${checkbox ? `<label class="capture-screenshots-toggle">
              <input type="checkbox" id="export-include-screenshots" aria-describedby="prompt-checkbox-hint">
              <span>${escapeHtml(checkbox.label)}</span>
            </label>
            <p class="capture-settings-hint" id="prompt-checkbox-hint">${escapeHtml(checkbox.hint)}</p>` : ""}
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel">${escapeHtml(t("cancel", [], "取消"))}</button>
            <button type="button" class="confirm-submit"></button>
          </div>
        </div>`;

      overlay.querySelector("#prompt-title").textContent = title;
      const messageEl = overlay.querySelector("#prompt-message");
      messageEl.textContent = message;
      messageEl.hidden = !message;
      overlay.querySelector(".confirm-submit").textContent = confirmText;

      const input = overlay.querySelector('input[type="text"], textarea');
      const checkboxInput = overlay.querySelector('input[type="checkbox"]');
      if (checkboxInput) checkboxInput.checked = checkbox.checked;
      const error = document.createElement("p");
      const clearError = () => {
        error.hidden = true;
        input?.removeAttribute("aria-invalid");
      };
      if (input) {
        overlay.querySelector(".recording-name-field span").textContent = label || title;
        input.value = value;
        if (maxLength !== null) limitNameInput(input, maxLength);
        error.id = "prompt-validation-error";
        error.className = "prompt-validation-error";
        error.setAttribute("role", "alert");
        error.hidden = true;
        input.setAttribute("aria-describedby", error.id);
        input.closest("label").after(error);
        input.addEventListener("input", clearError);
      }

      let picker = null;
      if (selection) {
        const field = document.createElement("div");
        field.className = "recording-name-field";
        const caption = document.createElement("span");
        caption.textContent = selection.label;
        picker = globalThis.RecorderFolderPicker.create(selection);
        picker.element.addEventListener("change", clearError);
        field.append(caption, picker.element);
        overlay.querySelector(".confirm-content").appendChild(field);
      }

      const finish = result => {
        close();
        resolve(result);
      };
      const submit = () => {
        const text = (multiline ? input?.value : input?.value.trim()) ?? "";
        const message = validate?.(text, picker?.value);
        if (message) {
          error.textContent = message;
          error.hidden = false;
          input.setAttribute("aria-invalid", "true");
          input.focus();
          return;
        }
        if (checkboxInput) finish({ text, checked: checkboxInput.checked });
        else finish(picker ? { text, selection: picker.value } : text);
      };
      const onKeyDown = event => {
        // Enter submits only from the name field. On a focused button Enter
        // belongs to that button, and an IME composition keeps its Enter for itself.
        if (!multiline && event.key === "Enter" && !event.isComposing && event.target === input) {
          event.preventDefault();
          submit();
        }
      };
      const close = openModal(overlay, { onDismiss: () => finish(null), onKeyDown });

      overlay.querySelector(".confirm-cancel").addEventListener("click", () => finish(null));
      overlay.querySelector(".confirm-submit").addEventListener("click", submit);
      (input || checkboxInput || overlay.querySelector(".confirm-submit")).focus();
      input?.select();
    });
  }

  async function promptDocumentExport({ title, message, value = null }) {
    const { EXPORT_SCREENSHOTS_KEY, readIncludeScreenshots } = globalThis.RecorderExport;
    const result = await promptText({
      title,
      message,
      value,
      label: t("caseName", [], "用例名称"),
      confirmText: title,
      checkbox: {
        label: t("exportScreenshotsLabel", [], "导出文档时附带截图"),
        hint: t("exportScreenshotsRemembered", [], "下次导出会沿用此次选择。"),
        checked: await readIncludeScreenshots()
      }
    });
    if (result === null) return null;
    await chrome.storage.local.set({ [EXPORT_SCREENSHOTS_KEY]: result.checked });
    return { name: result.text, includeScreenshots: result.checked };
  }

  /**
   * Three-way choice shown when opening a saved case would discard a live
   * recording. Resolves { action: "save", name } | { action: "discard" } | null.
   */
  function decideRecordingBeforeOpen({ caseName = "", defaultName = "" } = {}) {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.setAttribute("role", "presentation");
      overlay.innerHTML = `
        <div class="confirm-dialog save-recording-dialog" role="dialog" aria-modal="true" aria-labelledby="recording-dialog-title">
          <div class="confirm-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="3" fill="currentColor"></circle>
            </svg>
          </div>
          <div class="confirm-content">
            <h3 id="recording-dialog-title">${escapeHtml(t("currentlyRecording", [], "当前正在录制"))}</h3>
            <p>${escapeHtml(t("saveBeforeOpen", [caseName], `打开历史用例「${caseName}」前，是否保存当前录制？`))}</p>
            <label class="recording-name-field">
              <span>${escapeHtml(t("caseName", [], "用例名称"))}</span>
              <input type="text" maxlength="120" autocomplete="off">
            </label>
          </div>
          <div class="confirm-actions three-actions">
            <button type="button" class="confirm-cancel">${escapeHtml(t("cancel", [], "取消"))}</button>
            <button type="button" class="confirm-discard">${escapeHtml(t("discardAndOpen", [], "不保存并打开"))}</button>
            <button type="button" class="confirm-submit">${escapeHtml(t("saveAndOpen", [], "保存并打开"))}</button>
          </div>
        </div>`;

      const input = overlay.querySelector("input");
      input.value = defaultName;
      limitNameInput(input);
      const finish = result => {
        close();
        resolve(result);
      };
      const onKeyDown = event => {
        // Enter saves only from the name field, so the other two buttons keep
        // the action their label promises.
        if (event.key === "Enter" && !event.isComposing && event.target === input) {
          event.preventDefault();
          finish({ action: "save", name: input.value.trim() });
        }
      };
      const close = openModal(overlay, { onDismiss: () => finish(null), onKeyDown });

      overlay.querySelector(".confirm-cancel").addEventListener("click", () => finish(null));
      overlay.querySelector(".confirm-discard").addEventListener("click", () => finish({ action: "discard" }));
      overlay.querySelector(".confirm-submit").addEventListener("click", () => finish({ action: "save", name: input.value.trim() }));
      input.focus();
      input.select();
    });
  }

  globalThis.RecorderDialogs = {
    confirmAction,
    decideRecordingBeforeOpen,
    notify,
    openModal,
    promptDocumentExport,
    promptText,
    reportError
  };
})();
