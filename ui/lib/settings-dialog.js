/**
 * Recording settings dialog.
 *
 * Screenshots are the only part of a recording whose cost the user can trade away,
 * so this dialog is where that trade is made: capture them or do not. There used to
 * be three sharpness presets beside the switch; measurement showed they differed by
 * less than the run-to-run noise of a single preset, so the switch is the honest
 * version of that choice and the presets are gone.
 *
 * A change applies to the next recording, which is what the note at the bottom
 * says: the screencast parameters are fixed when a session starts, and silently
 * re-tuning a recording in progress would change the frames midway through it.
 */
(function () {
  if (globalThis.RecorderSettingsDialog) return;

  const { t } = globalThis.RecorderI18n;
  const { escapeHtml } = globalThis.RecorderDom;
  const settings = globalThis.RecorderCaptureSettings;

  /**
   * Resolves true when settings were saved, false when the user backed out.
   */
  async function openCaptureSettings() {
    const current = await settings.readCaptureSettings();
    return new Promise(resolve => {
      const overlay = document.createElement("div");
      overlay.className = "confirm-overlay";
      overlay.innerHTML = `
        <div class="confirm-dialog capture-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="capture-settings-title">
          <div class="confirm-content">
            <h3 id="capture-settings-title">${escapeHtml(t("captureSettingsTitle", [], "录制设置"))}</h3>
            <p id="capture-settings-message">${escapeHtml(t(
              "captureSettingsMessage",
              [],
              "步骤截图是录制里最占资源的部分。这里的取舍只影响截图，不影响操作步骤的记录。"
            ))}</p>
            <label class="capture-screenshots-toggle">
              <input type="checkbox" id="capture-screenshots-enabled">
              <span>${escapeHtml(t("captureScreenshotsLabel", [], "录制时保存步骤截图"))}</span>
            </label>
            <p class="capture-settings-hint">${escapeHtml(t(
              "captureScreenshotsHint",
              [],
              "关闭后不会附加调试器、不会抓取任何画面：内存和 CPU 占用最低，Chrome 也不会再显示“正在调试此浏览器”。"
            ))}</p>
            <p class="capture-settings-footnote">${escapeHtml(t(
              "captureSettingsFootnote",
              [],
              "截图始终按标签页当前的原生分辨率保存，不做缩放。内存开销随步骤数增长，与录制时长基本无关。修改在下次开始或继续录制时生效，不影响正在进行的录制。"
            ))}</p>
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel">${escapeHtml(t("cancel", [], "取消"))}</button>
            <button type="button" class="confirm-submit">${escapeHtml(t("save", [], "保存"))}</button>
          </div>
        </div>`;

      const toggle = overlay.querySelector("#capture-screenshots-enabled");
      toggle.checked = current.screenshots;

      const finish = async saved => {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        if (saved) await settings.writeCaptureSettings({ screenshots: toggle.checked });
        resolve(saved);
      };
      const onKeyDown = event => {
        if (event.key === "Escape") finish(false);
        if (event.key === "Enter") finish(true);
      };

      overlay.querySelector(".confirm-cancel").addEventListener("click", () => finish(false));
      overlay.querySelector(".confirm-submit").addEventListener("click", () => finish(true));
      overlay.addEventListener("click", event => {
        if (event.target === overlay) finish(false);
      });
      document.addEventListener("keydown", onKeyDown);
      document.body.appendChild(overlay);
      toggle.focus();
    });
  }

  globalThis.RecorderSettingsDialog = { openCaptureSettings };
})();
