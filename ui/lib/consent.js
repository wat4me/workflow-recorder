/**
 * The recording disclosure gate.
 *
 * Chrome Web Store policy requires data collection to be disclosed prominently
 * in-product, not only in the store listing. This therefore blocks the first
 * recording rather than living in a settings screen nobody opens.
 *
 * Kept separate from dialogs.js because this is a compliance obligation with its
 * own versioning rule, not a reusable UI primitive.
 */
(function () {
  if (globalThis.RecorderConsent) return;

  const { t } = globalThis.RecorderI18n;
  const { escapeHtml } = globalThis.RecorderDom;

  // Bump when the disclosure text changes materially, so previously granted
  // consent no longer covers it and users are asked again.
  const CONSENT_VERSION = 3;
  const CONSENT_KEY = "recordingConsentVersion";

  async function hasRecordingConsent() {
    try {
      const stored = await chrome.storage.local.get(CONSENT_KEY);
      return Number(stored[CONSENT_KEY]) >= CONSENT_VERSION;
    } catch (error) {
      return false;
    }
  }

  function disclosureItems() {
    return [
      t("consentItemUrls", [], "被录制页面的网址和标题"),
      t("consentItemActions", [], "点击、输入、选择、按键、悬停和拖拽操作"),
      t("consentItemElements", [], "操作元素的标签、有限 DOM 上下文和浏览器计算的可访问性信息"),
      t("consentItemValues", [], "表单输入值"),
      t("consentItemScreenshots", [], "步骤截图（如已启用）")
    ];
  }

  function showRecordingConsent() {
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.setAttribute("role", "presentation");
      overlay.innerHTML = `
        <div class="confirm-dialog consent-dialog" role="alertdialog" aria-modal="true"
             aria-labelledby="consent-title" aria-describedby="consent-intro">
          <div class="confirm-content">
            <h3 id="consent-title"></h3>
            <p id="consent-intro"></p>
            <ul class="consent-list"></ul>
            <p id="consent-local"></p>
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel">${escapeHtml(t("cancel", [], "取消"))}</button>
            <button type="button" class="confirm-submit"></button>
          </div>
        </div>`;

      // The itemized disclosure is taller than the side panel at its narrowest,
      // so the body scrolls and the action row stays reachable.
      const dialog = overlay.querySelector(".consent-dialog");
      dialog.style.cssText = "max-height:calc(100vh - 24px);display:flex;flex-direction:column;";
      const content = overlay.querySelector(".confirm-content");
      content.style.cssText = "overflow-y:auto;min-height:0;";
      overlay.querySelector(".confirm-actions").style.flex = "none";

      overlay.querySelector("#consent-title").textContent = t("consentTitle", [], "开始录制前请确认");
      overlay.querySelector("#consent-intro").textContent =
        t("consentIntro", [], "录制期间，扩展会在你的这台设备上记录：");
      overlay.querySelector("#consent-local").textContent =
        t("consentLocalOnly", [], "这些数据只保存在本机扩展存储中，不会上传到开发者或任何第三方服务器。请勿录制不希望留存的敏感内容。");

      const list = overlay.querySelector(".consent-list");
      list.style.cssText = "margin:8px 0;padding-left:18px;display:flex;flex-direction:column;gap:4px;";
      disclosureItems().forEach(text => {
        const item = document.createElement("li");
        item.textContent = text;
        list.appendChild(item);
      });

      const submitButton = overlay.querySelector(".confirm-submit");
      submitButton.textContent = t("consentAccept", [], "同意并开始录制");

      const finish = accepted => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(accepted);
      };
      const onKeyDown = event => {
        if (event.key === "Escape") finish(false);
      };

      const cancelButton = overlay.querySelector(".confirm-cancel");
      cancelButton.addEventListener("click", () => finish(false));
      submitButton.addEventListener("click", () => finish(true));
      overlay.addEventListener("click", event => {
        if (event.target === overlay) finish(false);
      });
      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(overlay);
      submitButton.focus();
    });
  }

  /** Resolves true when recording may proceed. Records consent once granted. */
  async function ensureRecordingConsent() {
    if (await hasRecordingConsent()) return true;
    if (!(await showRecordingConsent())) return false;
    await chrome.storage.local.set({ [CONSENT_KEY]: CONSENT_VERSION });
    return true;
  }

  globalThis.RecorderConsent = { ensureRecordingConsent };
})();
