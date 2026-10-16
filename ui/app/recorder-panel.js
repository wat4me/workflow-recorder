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
    const { readActions, sendRuntimeMessage: sendMessage } = globalThis.RecorderBridge;
    const { confirmAction, notify, promptText, reportError } = globalThis.RecorderDialogs;
    const { ensureRecordingConsent } = globalThis.RecorderConsent;
    const { exportWorkflow } = globalThis.RecorderExport;
    const { CAPTURE_SETTINGS_KEY, SESSION_CAPTURE_SETTINGS_KEY, recordingCapturePlanFor } = globalThis.RecorderCaptureSettings;
    const { openCaptureSettings } = globalThis.RecorderSettingsDialog;
    const { STEP_DISPLAY_SETTINGS_KEY, normalize: normalizeDisplaySettings } = globalThis.RecorderStepDisplaySettings;

    let isRecording = false;
    let recordingRequestPending = false;
    let copyRequestPending = false;
    let screenshotsEnabled = true;
    // The case name is asked for when it is needed instead of living in a field
    // on the page. Remembering the answer is what lets exporting and copying an
    // already-named workspace stay a single click.
    let caseName = "";
    let workspaceNameKey = "";
    // Kept so a capture-progress change can repaint the status tags without
    // re-reading every step: capture state is published several times per
    // screenshot, and each read is a message plus a lookup per stored step.
    let renderedActions = [];
    let renderedCaptureState = {};
    let renderedStored = null;
    let refreshPromise = null;
    let refreshVersion = 0;
    let lastStorageUpdateAt = 0;
    const draftSelect = elements.draftSelect;
    const draftStatus = elements.draftStatus;
    async function sendRuntimeMessage(message, timeoutMs) {
      return sendMessage({
        ...(renderedStored?.draftId ? { workspaceDraftId: renderedStored.draftId } : {}),
        ...(message.action === MESSAGE.getActions ? { scopeTabId: await resolveRootTabId() } : {}),
        ...message
      }, timeoutMs);
    }

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

    function refreshState() {
      ++refreshVersion;
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => {
        // Coalesce callers and serialize reads. A storage change during a read
        // invalidates that snapshot, so an older response cannot replace newer UI.
        await new Promise(resolve => setTimeout(resolve, 16));
        let version;
        do {
          version = refreshVersion;
          const tabId = await resolveRootTabId();
          const [stored, workspace] = await Promise.all([
            chrome.storage.local.get(["isRecording", "workspaceOrigin", "screenshotCaptureState", CAPTURE_SETTINGS_KEY, SESSION_CAPTURE_SETTINGS_KEY, STEP_DISPLAY_SETTINGS_KEY]),
            Number.isInteger(tabId) ? sendMessage({ action: MESSAGE.getDraftState, tabId }) : readActions().then(actions => ({ actions }))
          ]);
          if (workspace.success === false) throw new Error(workspace.error || "草稿读取失败");
          if (version === refreshVersion) renderState({ ...stored, ...(workspace.state || {}),
            draftId: workspace.draftId || null, draftActive: workspace.active !== false, drafts: workspace.drafts || [] }, workspace.actions);
        } while (version !== refreshVersion);
      })().finally(() => { refreshPromise = null; });
      return refreshPromise;
    }

    function renderState(stored, actions, changedIds = null) {
      renderedStored = stored;
      stepView.setWorkspaceContext?.({ workspaceDraftId: stored.draftId || null });
      if (draftSelect) {
        draftSelect.closest(".draft-toolbar").hidden = !stored.draftId;
        const signature = JSON.stringify([stored.draftId, stored.drafts?.map(draft => [draft.id, draft.title])]);
        if (draftSelect.dataset.signature !== signature) {
          draftSelect.replaceChildren(...(stored.drafts || []).map(draft => {
            const option = document.createElement("option");
            option.value = draft.id;
            option.textContent = draft.title || draft.url || t("unnamedCase", [], "未命名用例");
            return option;
          }));
          draftSelect.value = stored.draftId || "";
          draftSelect.dataset.signature = signature;
        }
        draftSelect.disabled = recordingRequestPending;
      }
      if (draftStatus) {
        draftStatus.textContent = stored.draftActive === false
          ? t("draftInactive", [], "已暂停 · 点击继续录制可返回此草稿")
          : t("draftAutoSaved", [], "草稿自动保留 · 切换页面互不混入");
      }
      // Names belong to a workspace, not the lifetime of this side-panel page.
      // The origin survives edits; root recordings are identified by their first step.
      const origin = stored.workspaceOrigin;
      const nameKey = actions.length === 0 ? "" : origin?.caseId
        ? JSON.stringify([origin.caseId, origin.loadedAt, origin.caseNameSnapshot]) : actions[0].id;
      if (nameKey !== workspaceNameKey) {
        workspaceNameKey = nameKey;
        caseName = actions.length ? origin?.caseNameSnapshot || "" : "";
      }
      isRecording = !!stored.isRecording;
      // Read on the same round trip as the rest of the panel state: this decides
      // whether the screenshot actions are offered at all.
      screenshotsEnabled = recordingCapturePlanFor(stored).screenshots;
      stepView.setScreenshotsExpandedDefault(normalizeDisplaySettings(stored[STEP_DISPLAY_SETTINGS_KEY]).screenshotsExpanded);
      renderedActions = actions;
      const canContinue = !isRecording && actions.length > 0;
      if (copyTaskBtn) copyTaskBtn.disabled = copyRequestPending || actions.length === 0;

      recordBtn.disabled = recordingRequestPending;
      setRecordButtonState(isRecording, canContinue);
      updateSecondaryActions(canContinue);
      const captureState = acceptCaptureState(stored.screenshotCaptureState || {});
      updateManualScreenshotAction(captureState);
      if (changedIds && stepView.patchSteps) stepView.patchSteps(actions, captureState, changedIds);
      else stepView.renderSteps(actions, captureState);
      onStateRendered({ isRecording, actions });
    }

    /** Repaints capture status only. Deliberately does not re-read the steps. */
    function refreshCaptureState(captureState) {
      const acceptedState = acceptCaptureState(captureState || {});
      updateManualScreenshotAction(acceptedState);
      if (renderedActions.length === 0) return;
      stepView.updateCaptureState(acceptedState);
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
      draftSelect?.addEventListener("change", async () => {
        const draftId = draftSelect.value;
        draftSelect.disabled = true;
        const response = await sendMessage({ action: MESSAGE.selectDraft, draftId, tabId: await resolveRootTabId() }, 30000);
        if (!response?.success) reportError(response?.error || "草稿切换失败");
        await refreshState();
      });
      captureSettingsBtn?.addEventListener("click", async () => {
        // Offered next to the recording controls rather than inside the more-actions
        // menu: that menu only appears once there are steps, and the capture policy
        // has to be settable before the first recording starts.
        if (await openCaptureSettings()) {
          await refreshState();
          notify(t("captureSettingsSaved", [], "设置已保存。截图显示立即生效，采集设置在下次录制时生效。"));
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
        const workspaceDraftId = renderedStored?.draftId;
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
        const response = await sendRuntimeMessage({ action: MESSAGE.clearSteps, workspaceDraftId });
        if (!response?.success) {
          reportError(response?.error || t("clearStepsFailed", [], "清空步骤失败"));
        } else if (response.cleanupPending) {
          notify(t("screenshotCleanupDeferred", [], "操作已完成，截图将在后台重试清理"));
        }
        refreshState();
      });

      saveCurrentCaseBtn.addEventListener("click", async () => {
        const workspaceDraftId = renderedStored?.draftId;
        if (saveCurrentCaseBtn.disabled) return;
        saveCurrentCaseBtn.disabled = true;
        try {
          const [folderResponse, caseResponse, workspace] = await Promise.all([
            sendRuntimeMessage({ action: MESSAGE.listCaseFolders }),
            sendRuntimeMessage({ action: MESSAGE.listCases }),
            chrome.storage.local.get(["activeCaseId", "workspaceOrigin"])
          ]);
          if (!folderResponse?.success || !caseResponse?.success) {
            throw new Error(folderResponse?.error || caseResponse?.error || t("saveCaseFailed", [], "保存用例失败"));
          }
          const folders = folderResponse.folders || [];
          const byId = new Map(folders.map(folder => [folder.id, folder]));
          const folderOptions = [];
          const visited = new Set();
          const addFolder = (folder, ancestors = []) => {
            if (visited.has(folder.id)) return;
            visited.add(folder.id);
            const path = [...ancestors, folder.name];
            folderOptions.push({ value: folder.id, name: folder.name, label: path.join(" / "), depth: ancestors.length });
            for (const child of folders.filter(item => item.parentId === folder.id)) {
              addFolder(child, path);
            }
          };
          folders.filter(folder => !byId.has(folder.parentId)).forEach(folder => addFolder(folder));
          folders.forEach(folder => addFolder(folder));
          const originId = workspace.activeCaseId || workspace.workspaceOrigin?.caseId;
          const currentCase = (caseResponse.cases || []).find(item => item.id === originId);
          const answer = await promptText({
            title: t("saveCaseAction", [], "保存用例"),
            message: t("saveCaseHint", [], "保存后可在工作台查看全部用例。"),
            label: t("caseName", [], "用例名称"),
            value: caseName,
            confirmText: t("save", [], "保存"),
            validate: (name, folderId) => name && (caseResponse.cases || []).some(item =>
              (item.folderId || null) === (folderId || null)
              && item.name.trim().toLowerCase() === name.toLowerCase())
              ? t("errorCaseNameExists", [], "当前文件夹已存在同名用例，请换一个名称") : "",
            selection: {
              label: t("saveCaseFolder", [], "保存分类"),
              value: byId.has(currentCase?.folderId) ? currentCase.folderId : "",
              options: [
                { value: "", label: t("unfiledCases", [], "未分类") },
                ...folderOptions
              ]
            }
          });
          if (answer === null) return;

          const response = await sendRuntimeMessage({
            action: MESSAGE.saveCase, name: answer.text,
            workspaceDraftId,
            snapshot: isRecording, folderId: answer.selection || null
          });
          if (response?.success) {
            // The worker generates a name when this one is empty and files the case
            // under that, so remember what it actually used.
            caseName = response.case?.name || caseName;
            const targetFolderId = answer.selection || null;
            // An already-running worker may still use the old save route, which
            // ignores folderId. Verify its result before reporting a successful save.
            if ((response.case?.folderId || null) !== targetFolderId) {
              if (!response.case?.id) throw new Error(t("saveCaseFailed", [], "保存用例失败"));
              const moved = await sendRuntimeMessage({
                action: MESSAGE.moveCasesToFolder,
                caseIds: [response.case.id], folderId: targetFolderId
              });
              if (!moved?.success) {
                throw new Error(moved?.error || t("moveCasesFailed", [], "移动用例失败"));
              }
            }
            flashSaved();
            if (answer.text.trim() && caseName !== answer.text.trim()) {
              notify(t("caseSavedAs", [caseName], `已保存为“${caseName}”`));
            }
          } else {
            reportError(response?.error || t("saveCaseFailed", [], "保存用例失败"));
          }
        } catch (error) {
          reportError(error.message || t("saveCaseFailed", [], "保存用例失败"));
        } finally {
          saveCurrentCaseBtn.disabled = renderedActions.length === 0;
        }
      });

      async function downloadRecording() {
        const workspaceDraftId = renderedStored?.draftId;
        // `activeCaseId` only names the workspace while it still matches that case:
        // recording or editing a step clears it. That is what says whether this
        // download has to bank the recording before handing over the archive.
        const { activeCaseId, workspaceOrigin } = renderedStored?.draftId
          ? renderedStored : await chrome.storage.local.get(["activeCaseId", "workspaceOrigin"]);
        // The name is asked for once: a workspace that was saved or exported
        // already carries one, and re-asking on every download would be noise.
        let name = caseName || await askCaseName({
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
            const history = await sendRuntimeMessage({ action: MESSAGE.listCases });
            if (!history?.success) throw new Error(history?.error || t("listCasesFailed", [], "读取历史用例失败"));
            const source = (history.cases || []).find(item => item.id === workspaceOrigin?.caseId);
            const saved = await sendRuntimeMessage({
              action: MESSAGE.saveCase, name, snapshot: isRecording, folderId: source?.folderId || null,
              workspaceDraftId
            });
            if (!saved?.success) {
              // The archive would be the only copy of steps the workbench never
              // sees, so a refused save stops the download rather than hiding it.
              reportError(saved?.error || t("saveCaseFailed", [], "保存用例失败"));
              return;
            }
            name = saved.case?.name || name;
            caseName = name;
            flashSaved();
          }
          const response = await sendRuntimeMessage({ action: MESSAGE.getActions, workspaceDraftId });
          if (!response?.success) throw new Error(response?.error || "草稿读取失败");
          await exportWorkflow(response.actions, name);
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
        if (copyRequestPending) return;
        copyRequestPending = true;
        copyTaskBtn.disabled = true;
        try {
          // Rendering can lag behind a storage update. Copy the committed steps
          // and surface read failures rather than silently copying stale data.
          const response = await sendRuntimeMessage({ action: MESSAGE.getActions });
          if (!response?.success || !Array.isArray(response.actions)) {
            throw new Error(response?.error || t("copyFailed", [], "复制失败"));
          }
          const actions = response.actions;
          if (!actions.length) throw new Error(t("noSteps", [], "暂无录制步骤"));
          const sameWorkspace = actions[0].id === renderedActions[0]?.id;
          const name = (sameWorkspace && caseName) || t("unnamedCase", [], "未命名用例");
          const language = globalThis.RecorderI18n.getLanguage?.() || "zh_CN";
          await navigator.clipboard.writeText(globalThis.StepDocGenerator.generateTask(name, actions, language));
          notify(t("copyTaskCopied", [], "任务说明已复制"));
        } catch (error) {
          reportError(error.message || t("copyFailed", [], "复制失败"));
        } finally {
          copyRequestPending = false;
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
        if (request.action === MESSAGE.stepsUpdated && Date.now() - lastStorageUpdateAt > 500) refreshState();
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (changes.activeRecordingDraftId || changes.recordingDraftIndex ||
            (renderedStored?.draftId && renderedStored.draftActive === false &&
              Object.keys(changes).some(key => key.startsWith("recordingDraft:")))) {
          refreshState();
          return;
        }
        if (renderedStored?.draftActive === false) return;
        if (changes[STEP_DISPLAY_SETTINGS_KEY]) {
          refreshState();
          return;
        }
        const stateKeys = ["isRecording", "workspaceOrigin", "screenshotCaptureState", CAPTURE_SETTINGS_KEY, SESSION_CAPTURE_SETTINGS_KEY];
        const changedRecords = Object.keys(changes).filter(key => key.startsWith("action:"));
        // actionOrder changes on append and delete; an `action:` key changes
        // when a screenshot binds to an existing step.
        const touchedActions = changes.actionOrder || changes.isRecording || changes.workspaceOrigin ||
          Object.keys(changes).some(key => key.startsWith("action:"));
        if (touchedActions) {
          lastStorageUpdateAt = Date.now();
          if (!renderedStored || refreshPromise) { refreshState(); return; }
          const stored = { ...renderedStored };
          for (const key of stateKeys) if (changes[key]) stored[key] = changes[key].newValue;
          const byId = new Map(renderedActions.map(action => [action.id, action]));
          for (const key of changedRecords) {
            const id = key.slice(7);
            if (changes[key].newValue) byId.set(id, changes[key].newValue);
            else byId.delete(id);
          }
          const order = changes.actionOrder?.newValue || renderedActions.map(action => action.id);
          if (order.some(id => !byId.has(id))) { refreshState(); return; }
          renderState(stored, order.map(id => byId.get(id)), changes.actionOrder || changes.isRecording || changes.workspaceOrigin
            ? null : new Set(changedRecords.map(key => key.slice(7))));
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
