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
   * Non-blocking status message. Styling is inline so this works on both panel
   * pages without either stylesheet having to know about it.
   */
  function notify(message, { danger = false, timeoutMs = 4000 } = {}) {
    if (!message) return;
    let stack = document.querySelector(".recorder-toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "recorder-toast-stack";
      stack.setAttribute("role", "status");
      stack.setAttribute("aria-live", "polite");
      stack.style.cssText = "position:fixed;top:16px;left:12px;right:12px;z-index:2147483647;"
        + "display:flex;flex-direction:column;align-items:center;gap:8px;pointer-events:none;";
      document.body.appendChild(stack);
    }

    const toast = document.createElement("div");
    toast.className = `recorder-toast${danger ? " danger" : ""}`;
    toast.textContent = String(message);
    toast.style.cssText = "pointer-events:auto;width:fit-content;max-width:min(520px,calc(100vw - 24px));"
      + "padding:10px 14px;border-radius:10px;border:1px solid;"
      + "font:500 13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;"
      + "box-shadow:0 10px 30px rgba(15,23,42,.16);word-break:break-word;"
      + `background:${danger ? "#fef2f2" : "#f0fdf4"};`
      + `border-color:${danger ? "#fecaca" : "#bbf7d0"};`
      + `color:${danger ? "#991b1b" : "#166534"};`;
    stack.appendChild(toast);

    const remove = () => {
      toast.remove();
      if (!stack.childElementCount) stack.remove();
    };
    toast.addEventListener("click", remove);
    setTimeout(remove, Math.max(1200, timeoutMs));
  }

  function reportError(message) {
    notify(message || t("unexpectedError", [], "操作失败"), { danger: true, timeoutMs: 6000 });
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

      const finish = result => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      };
      const onKeyDown = event => {
        if (event.key === "Escape") finish(false);
        if (event.key === "Enter") finish(true);
      };

      cancelButton.addEventListener("click", () => finish(false));
      submitButton.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", event => {
        if (event.target === overlay) finish(false);
      });
      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(overlay);
      cancelButton.focus();
    });
  }

  /** Resolves with the trimmed text, or null if cancelled. */
  function promptText({
    title = t("confirmAction", [], "确认操作"),
    message = "",
    label = "",
    confirmText = t("confirm", [], "确认"),
    value = "",
    maxLength = 120
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
            <label class="recording-name-field">
              <span></span>
              <input type="text" autocomplete="off">
            </label>
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
      overlay.querySelector(".recording-name-field span").textContent = label || title;
      overlay.querySelector(".confirm-submit").textContent = confirmText;

      const input = overlay.querySelector("input");
      input.maxLength = maxLength;
      input.value = value;

      const finish = result => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      };
      const submit = () => finish(input.value.trim());
      const onKeyDown = event => {
        if (event.key === "Escape") finish(null);
        if (event.key === "Enter") submit();
      };

      overlay.querySelector(".confirm-cancel").addEventListener("click", () => finish(null));
      overlay.querySelector(".confirm-submit").addEventListener("click", submit);
      overlay.addEventListener("click", event => {
        if (event.target === overlay) finish(null);
      });
      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(overlay);
      input.focus();
      input.select();
    });
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
      const finish = result => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(result);
      };
      const onKeyDown = event => {
        if (event.key === "Escape") finish(null);
        if (event.key === "Enter") finish({ action: "save", name: input.value.trim() });
      };

      overlay.querySelector(".confirm-cancel").addEventListener("click", () => finish(null));
      overlay.querySelector(".confirm-discard").addEventListener("click", () => finish({ action: "discard" }));
      overlay.querySelector(".confirm-submit").addEventListener("click", () => finish({ action: "save", name: input.value.trim() }));
      overlay.addEventListener("click", event => {
        if (event.target === overlay) finish(null);
      });
      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(overlay);
      input.focus();
      input.select();
    });
  }

  globalThis.RecorderDialogs = {
    confirmAction,
    decideRecordingBeforeOpen,
    notify,
    promptText,
    reportError
  };
})();
