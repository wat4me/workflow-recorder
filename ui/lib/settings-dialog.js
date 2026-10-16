/**
 * Recording settings dialog.
 *
 * Screenshots are the only part of a recording whose cost the user can trade away,
 * so this dialog is where that trade is made: capture them or do not. There used to
 * be three sharpness presets beside the switch; measurement showed they differed by
 * less than the run-to-run noise of a single preset, so the switch is the honest
 * version of that choice and the presets are gone.
 *
 * Capture changes apply to the next recording. Side-panel display preferences
 * apply immediately and are stored separately from the session capture policy.
 */
(function () {
  if (globalThis.RecorderSettingsDialog) return;

  const { t } = globalThis.RecorderI18n;
  const { escapeHtml } = globalThis.RecorderDom;
  const settings = globalThis.RecorderCaptureSettings;
  const displaySettings = globalThis.RecorderStepDisplaySettings;

  /**
   * Resolves true when settings were saved, false when the user backed out.
   */
  async function openCaptureSettings() {
    const [current, storedDisplay] = await Promise.all([
      settings.readCaptureSettings(), chrome.storage.local.get(displaySettings.STEP_DISPLAY_SETTINGS_KEY)
    ]);
    const currentDisplay = displaySettings.normalize(storedDisplay[displaySettings.STEP_DISPLAY_SETTINGS_KEY]);
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
              "关闭后不采集或保存截图，操作步骤和浏览器可访问性信息仍会记录；Chrome 仍可能显示调试提示。"
            ))}</p>
            <label class="capture-screenshots-toggle">
              <input type="checkbox" id="sidebar-screenshots-expanded">
              <span>${escapeHtml(t("sidebarScreenshotsExpanded", [], "侧边栏截图默认展开"))}</span>
            </label>
            <p class="capture-settings-hint">${escapeHtml(t(
              "sidebarScreenshotsExpandedHint", [],
              "关闭后，侧边栏截图默认折叠，可逐步展开查看。保存后立即生效，不影响截图采集、保存和导出。"
            ))}</p>
            <p class="capture-settings-footnote">${escapeHtml(t(
              "captureSettingsFootnote",
              [],
              "截图始终按标签页当前的原生分辨率保存，不做缩放。截图采集设置在下次开始或继续录制时生效；侧边栏显示设置保存后立即生效。"
            ))}</p>
          </div>
          <div class="confirm-actions">
            <button type="button" class="confirm-cancel">${escapeHtml(t("cancel", [], "取消"))}</button>
            <button type="button" class="confirm-submit">${escapeHtml(t("save", [], "保存"))}</button>
          </div>
        </div>`;

      const toggle = overlay.querySelector("#capture-screenshots-enabled");
      toggle.checked = current.screenshots;
      const expandedToggle = overlay.querySelector("#sidebar-screenshots-expanded");
      expandedToggle.checked = currentDisplay.screenshotsExpanded;

      let finishing = false;
      const finish = async saved => {
        if (finishing) return;
        finishing = true;
        const submit = overlay.querySelector(".confirm-submit");
        submit.disabled = true;
        try {
          if (saved) await chrome.storage.local.set({
            [settings.CAPTURE_SETTINGS_KEY]: settings.normalizeCaptureSettings({ screenshots: toggle.checked }),
            [displaySettings.STEP_DISPLAY_SETTINGS_KEY]: displaySettings.normalize({ screenshotsExpanded: expandedToggle.checked })
          });
          document.removeEventListener("keydown", onKeyDown);
          overlay.remove();
          resolve(saved);
        } catch (error) {
          finishing = false;
          submit.disabled = false;
          globalThis.RecorderDialogs.reportError(error.message);
        }
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
