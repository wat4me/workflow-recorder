/** Side-panel recorder and current-workspace actions. */
(function () {
  function create(options) {
    const {
      elements,
      stepView,
      // A new recording attaches to the tab whose layout the side panel owns.
      resolveRootTabId,
      resolveCaptureTabId = resolveRootTabId,
      // Runs after every state refresh so a page can update its own extras.
      onStateRendered = () => {}
    } = options;

    const {
      recordBtn, recordBtnLabel, manualScreenshotBtn,
      downloadDocCompactBtn, clearStepsBtn, moreActionsBtn, moreActionsMenu,
      captureSettingsBtn, downloadDocBtn, copyTaskBtn, saveCurrentCaseBtn,
    } = elements;

    const { t } = globalThis.RecorderI18n;
    const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
    const { readActions, sendRuntimeMessage } = globalThis.RecorderBridge;
    const { confirmAction, notify, promptText, reportError } = globalThis.RecorderDialogs;
    const { ensureRecordingConsent } = globalThis.RecorderConsent;
    const { exportWorkflow } = globalThis.RecorderExport;
    const { CAPTURE_SETTINGS_KEY, SESSION_CAPTURE_SETTINGS_KEY, recordingCapturePlanFor } = globalThis.RecorderCaptureSettings;
    const { openCaptureSettings } = globalThis.RecorderSettingsDialog;

    let isRecording = false;
    let recordingRequestPending = false;
    let screenshotsEnabled = true;
    // The case name is asked for when it is needed instead of living in a field
    // on the page. Remembering the answer is what lets exporting and copying an
    // already-named workspace stay a single click.
    let caseName = "";
    // Kept so a capture-progress change can repaint the status tags without
    // re-reading every step: capture state is published several times per
    // screenshot, and each read is a message plus a lookup per stored step.
    let renderedActions = [];
    let renderedCaptureState = {};

    function closeMoreActions() {
      if (!moreActionsMenu || !moreActionsBtn) return;
      moreActionsMenu.hidden = true;
      moreActionsBtn.setAttribute("aria-expanded", "false");
    }

    /**
     * Asks for the case name and remembers it. Resolves null when the user
     * cancels, which callers must treat as "do nothing" rather than as an empty
     * name: an empty name is a deliberate choice and means "let the worker name
     * it" for a save, or the default export name for a download.
     */
    async function askCaseName({ title, message = "", confirmText }) {
      const answer = await promptText({
        title,
        message,
        label: t("caseName", [], "用例名称"),
        value: caseName,
        confirmText
      });
      if (answer === null) return null;
      caseName = answer;
      return answer;
    }

    /** The confirmation flash shared by the save button and a saving download. */
    function flashSaved() {
      saveCurrentCaseBtn.classList.add("success");
      saveCurrentCaseBtn.querySelector(".btn-label").textContent = t("saved", [], "已保存");
      setTimeout(() => {
        saveCurrentCaseBtn.classList.remove("success");
        saveCurrentCaseBtn.querySelector(".btn-label").textContent = t("saveCaseAction", [], "保存用例");
      }, 1400);
    }

    function updateSecondaryActions(canContinue) {
      if (moreActionsBtn) {
        moreActionsBtn.hidden = !canContinue;
        moreActionsBtn.disabled = recordingRequestPending;
        if (!canContinue) closeMoreActions();
      }
      downloadDocBtn.hidden = !canContinue;
      if (downloadDocCompactBtn) {
        downloadDocCompactBtn.hidden = !canContinue;
        downloadDocCompactBtn.disabled = recordingRequestPending || renderedActions.length === 0;
      }
      if (clearStepsBtn) clearStepsBtn.disabled = recordingRequestPending || !canContinue;
    }

    function updateManualScreenshotAction(captureState = {}) {
      if (!manualScreenshotBtn) return;
      // A recording that is not saving screenshots has nothing for a manual
      // capture to do, so the action is not offered at all.
      manualScreenshotBtn.hidden = !isRecording || !screenshotsEnabled;
      manualScreenshotBtn.disabled = recordingRequestPending
        || !isRecording
        || !screenshotsEnabled
        || renderedActions.length === 0
        || !!captureState.busy
        || Number(captureState.pendingCount) > 0;
    }

    function acceptCaptureState(captureState = {}) {
      const currentAt = Number(renderedCaptureState.updatedAt) || 0;
      const nextAt = Number(captureState.updatedAt) || 0;
      if (nextAt < currentAt) return renderedCaptureState;
      renderedCaptureState = captureState;
      return renderedCaptureState;
    }

    async function refreshState() {
      const [stored, actions] = await Promise.all([
        chrome.storage.local.get(["isRecording", "screenshotCaptureState", CAPTURE_SETTINGS_KEY, SESSION_CAPTURE_SETTINGS_KEY]),
        readActions()
      ]);
      isRecording = !!stored.isRecording;
      // Read on the same round trip as the rest of the panel state: this decides
      // whether the screenshot actions are offered at all.
      screenshotsEnabled = recordingCapturePlanFor(stored).screenshots;
      renderedActions = actions;
      const canContinue = !isRecording && actions.length > 0;
      if (copyTaskBtn) copyTaskBtn.disabled = actions.length === 0;

      recordBtn.disabled = recordingRequestPending;
      setRecordButtonState(isRecording, canContinue);
      updateSecondaryActions(canContinue);
      const captureState = acceptCaptureState(stored.screenshotCaptureState || {});
      updateManualScreenshotAction(captureState);
      stepView.renderSteps(actions, captureState);
      onStateRendered({ isRecording, actions });
    }

    /** Repaints capture status only. Deliberately does not re-read the steps. */
    function refreshCaptureState(captureState) {
      const acceptedState = acceptCaptureState(captureState || {});
      updateManualScreenshotAction(acceptedState);
      if (renderedActions.length === 0) return;
      stepView.renderSteps(renderedActions, acceptedState);
    }

    function setRecordButtonState(recording, canContinue = false) {
      const recordBtnIcon = recordBtn.querySelector(".btn-icon");
      if (recording) {
        recordBtn.className = "btn btn-primary recording-state";
        recordBtn.dataset.recordingMode = "";
        recordBtnLabel.textContent = t("stopRecording", [], "停止录制");
        if (recordBtnIcon) {
          recordBtnIcon.innerHTML = `
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <rect x="8.5" y="8.5" width="7" height="7" rx="1.5" fill="currentColor"></rect>
            </svg>
          `;
        }
        return;
      }

      recordBtn.className = "btn btn-primary start-state";
      recordBtn.dataset.recordingMode = canContinue ? "continue" : "restart";
      recordBtnLabel.textContent = canContinue
        ? t("continueRecording", [], "继续录制")
        : t("startRecording", [], "开始录制");
      if (recordBtnIcon) {
        recordBtnIcon.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M8 5v14l11-7z"></path>
          </svg>
        `;
      }
    }

    async function startRecording(recordingMode) {
      if (recordingRequestPending) return;
      // Asked before anything is captured, and before the button flips to a
      // recording state, so declining leaves the panel untouched.
      if (!(await ensureRecordingConsent())) return;
      recordingRequestPending = true;
      recordBtn.disabled = true;
      setRecordButtonState(true);

      const response = await sendRuntimeMessage({
        action: MESSAGE.toggleRecording,
        start: true,
        recordingMode,
        rootTabId: await resolveRootTabId()
      }, 30000);
      isRecording = !!response?.success;
      if (!response?.success) {
        reportError(response?.error || t(
          "startRecordingFailed",
          [],
          "无法开始录制。请确保当前处于有效的网页上（不可在 chrome:// 页面录制）。"
        ));
      }
      recordingRequestPending = false;
      refreshState();
    }

    async function stopRecording() {
      if (recordingRequestPending) return;
      recordingRequestPending = true;
      recordBtn.disabled = true;
      setRecordButtonState(false);
      const response = await sendRuntimeMessage({ action: MESSAGE.toggleRecording, start: false }, 30000);
      isRecording = !response?.success;
      if (!response?.success) {
        reportError(response?.error || t("stopRecordingFailed", [], "停止当前录制失败"));
      }
      recordingRequestPending = false;
      refreshState();
    }

    function bindEvents() {
      captureSettingsBtn?.addEventListener("click", async () => {
        // Offered next to the recording controls rather than inside the more-actions
        // menu: that menu only appears once there are steps, and the capture policy
        // has to be settable before the first recording starts.
        if (await openCaptureSettings()) {
          await refreshState();
          notify(t("captureSettingsSaved", [], "录制设置已保存，下次开始录制时生效"));
        }
      });

      recordBtn.addEventListener("click", () => {
        if (recordingRequestPending) return;
        if (isRecording) stopRecording();
        else startRecording(recordBtn.dataset.recordingMode || "restart");
      });

      manualScreenshotBtn?.addEventListener("click", async () => {
        manualScreenshotBtn.disabled = true;
        try {
          const response = await sendRuntimeMessage({
            action: MESSAGE.manualScreenshot,
            tabId: await resolveCaptureTabId()
          }, 30000);
          if (!response?.success) {
            reportError(response?.error || t("manualScreenshotFailed", [], "更新操作后截图失败"));
          }
        } finally {
          refreshState();
        }
      });

      moreActionsBtn?.addEventListener("click", event => {
        event.stopPropagation();
        const opening = moreActionsMenu.hidden;
        moreActionsMenu.hidden = !opening;
        moreActionsBtn.setAttribute("aria-expanded", String(opening));
        if (opening) moreActionsMenu.querySelector("button:not([hidden]):not(:disabled)")?.focus();
      });

      clearStepsBtn?.addEventListener("click", async () => {
        closeMoreActions();
        const confirmed = await confirmAction({
          title: t("clearSteps", [], "清空步骤"),
          message: t(
            "clearStepsMessage",
            [],
            "将删除当前工作区的全部步骤和未被用例引用的截图，不会自动保存，已保存用例不受影响。清空后不会开始录制。此操作不可恢复，确定继续吗？"
          ),
          confirmText: t("clearSteps", [], "清空步骤"),
          danger: true
        });
        if (!confirmed) return;

        clearStepsBtn.disabled = true;
        const response = await sendRuntimeMessage({ action: MESSAGE.clearSteps });
        if (!response?.success) {
          reportError(response?.error || t("clearStepsFailed", [], "清空步骤失败"));
        } else if (response.cleanupPending) {
          notify(t("screenshotCleanupDeferred", [], "操作已完成，截图将在后台重试清理"));
        }
        refreshState();
      });

      saveCurrentCaseBtn.addEventListener("click", async () => {
        const name = await askCaseName({
          title: t("saveCaseAction", [], "保存用例"),
          message: t("saveCaseHint", [], "保存后可在工作台查看全部用例。"),
          confirmText: t("save", [], "保存")
        });
        if (name === null) return;

        saveCurrentCaseBtn.disabled = true;
        const response = await sendRuntimeMessage({ action: MESSAGE.saveCase, name, snapshot: isRecording });
        if (response?.success) {
          // The worker generates a name when this one is empty and files the case
          // under that, so remember what it actually used.
          caseName = response.case?.name || caseName;
          flashSaved();
        } else {
          reportError(response?.error || t("saveCaseFailed", [], "保存用例失败"));
        }
        saveCurrentCaseBtn.disabled = renderedActions.length === 0;
      });

      async function downloadRecording() {
        // `activeCaseId` only names the workspace while it still matches that case:
        // recording or editing a step clears it. That is what says whether this
        // download has to bank the recording before handing over the archive.
        const { activeCaseId } = await chrome.storage.local.get("activeCaseId");
        // The name is asked for once: a workspace that was saved or exported
        // already carries one, and re-asking on every download would be noise.
        const name = caseName || await askCaseName({
          title: t("exportResult", [], "下载录制结果"),
          message: activeCaseId
            ? t(
              "exportAlreadySavedHint",
              [],
              "当前录制已保存为用例，下载不会重复保存；可在工作台查看全部用例。"
            )
            : t(
              "exportSaveCaseHint",
              [],
              "下载会同时把当前录制保存为用例，之后可在工作台查看全部用例。"
            ),
          confirmText: t("exportResult", [], "下载录制结果")
        });
        if (name === null) return;

        downloadDocBtn.disabled = true;
        if (downloadDocCompactBtn) downloadDocCompactBtn.disabled = true;
        try {
          if (!activeCaseId) {
            const saved = await sendRuntimeMessage({ action: MESSAGE.saveCase, name, snapshot: isRecording });
            if (!saved?.success) {
              // The archive would be the only copy of steps the workbench never
              // sees, so a refused save stops the download rather than hiding it.
              reportError(saved?.error || t("saveCaseFailed", [], "保存用例失败"));
              return;
            }
            caseName = saved.case?.name || caseName;
            flashSaved();
          }
          await exportWorkflow(await readActions(), name);
        } catch (error) {
          reportError(error.message || t("exportFailed", [], "导出失败"));
        } finally {
          downloadDocBtn.disabled = false;
          if (downloadDocCompactBtn) downloadDocCompactBtn.disabled = false;
        }
      }

      downloadDocBtn.addEventListener("click", async () => {
        closeMoreActions();
        await downloadRecording();
      });
      downloadDocCompactBtn?.addEventListener("click", downloadRecording);

      copyTaskBtn?.addEventListener("click", async () => {
        copyTaskBtn.disabled = true;
        try {
          const name = caseName || t("unnamedCase", [], "未命名用例");
          const language = globalThis.RecorderI18n.getLanguage?.() || "zh_CN";
          await navigator.clipboard.writeText(globalThis.StepDocGenerator.generateTask(name, renderedActions, language));
          notify(t("agentManualCopied", [], "任务说明已复制"));
        } catch (error) {
          reportError(error.message || t("copyFailed", [], "复制失败"));
        } finally {
          copyTaskBtn.disabled = renderedActions.length === 0;
        }
      });

      document.addEventListener("click", event => {
        if (!moreActionsMenu || moreActionsMenu.hidden) return;
        if (!moreActionsBtn.parentElement.contains(event.target)) closeMoreActions();
      });
      document.addEventListener("keydown", event => {
        if (event.key === "Escape") closeMoreActions();
      });

      // The worker announces changes, and storage events cover a notification
      // missed while Chrome suspends it.
      chrome.runtime.onMessage.addListener(request => {
        if (request.action === MESSAGE.stepsUpdated) refreshState();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        // actionOrder changes on append and delete; an `action:` key changes
        // when a screenshot binds to an existing step.
        const touchedActions = changes.actionOrder || changes.isRecording ||
          Object.keys(changes).some(key => key.startsWith("action:"));
        if (touchedActions) {
          refreshState();
          return;
        }
        // Progress only: which step is capturing changed, the steps did not.
        if (changes.screenshotCaptureState) {
          refreshCaptureState(changes.screenshotCaptureState.newValue);
        }
      });
    }

    bindEvents();
    return { refreshState };
  }

  window.RecorderPanel = { create };
})();
