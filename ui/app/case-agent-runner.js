(function () {
  if (globalThis.RecorderCaseAgentRunner) return;

  const CHUNK_BYTES = 192 * 1024;
  function buildManualPrompt(caseRecord, language = "zh_CN") {
    const pages = new Map((caseRecord.pages || []).map(page => [page.name, page]));
    const actions = (caseRecord.actions || []).map(action => {
      const page = pages.get(action.pageName);
      return {
        ...action,
        url: action.url || page?.url || "",
        title: action.title || page?.title || ""
      };
    });
    return globalThis.StepDocGenerator.generateTask(caseRecord.name, actions, language);
  }

  function create(options) {
    const {
      providerField,
      providerSelect,
      workspaceField,
      workspaceInput,
      executeButton,
      cancelButton,
      modeHint,
      status,
      progress,
      recordsProgress,
      events,
      empty,
      recordsLink,
      sendRuntimeMessage,
      historySelect,
      followupInput,
      followupButton
    } = options;
    const { t } = globalThis.RecorderI18n;
    const { MESSAGE, isAgentActive } = globalThis.WorkflowRecorderProtocol;
    const { confirmAction, notify, reportError } = globalThis.RecorderDialogs;
    const { buildCasePackage } = globalThis.RecorderCasePackage;
    const planButton = options.planButton || null;
    const writeClipboard = options.writeClipboard || (text => navigator.clipboard.writeText(text));
    let currentCase = null;
    let currentJob = null;
    let caseJobs = [];
    let preferredJobId = null;
    let disposed = false;
    let bridgeState = typeof options.bridgeAvailable === "boolean"
      ? (options.bridgeAvailable ? "available" : "unavailable")
      : "unknown";
    let bridgeCheck = null;
    const workspaceStorageKey = "workflow-recorder-zcode-workspace";

    async function detectBridge() {
      if (bridgeCheck) return bridgeCheck;
      bridgeState = "checking";
      render();
      bridgeCheck = sendRuntimeMessage({ action: MESSAGE.agentConnect }, 35000).then(response => {
        bridgeState = response?.success ? "available" : "unavailable";
        return bridgeState;
      }).catch(() => {
        bridgeState = "unavailable";
        return bridgeState;
      }).finally(() => {
        bridgeCheck = null;
        render();
      });
      return bridgeCheck;
    }

    function persistWorkspacePath(value = workspaceInput?.value || "") {
      try {
        globalThis.localStorage?.setItem(workspaceStorageKey, value.trim());
      } catch (_) {}
    }

    if (workspaceInput) {
      try {
        workspaceInput.value = globalThis.localStorage?.getItem(workspaceStorageKey) || "";
      } catch (_) {
        workspaceInput.value = "";
      }
    }

    function statusText(job) {
      const labels = {
        "awaiting-input": t("agentStatusUploading", [], "正在上传"),
        validating: t("agentStatusValidating", [], "正在校验"),
        ready: t("agentStatusReady", [], "准备执行"),
        running: job?.execution?.mode === "execute"
          ? t("agentStatusExecuting", [], "正在执行")
          : t("agentStatusPlanning", [], "正在分析"),
        cancelling: t("agentStatusCancelling", [], "正在取消"),
        completed: t("agentStatusCompleted", [], "已完成"),
        failed: t("agentStatusFailed", [], "执行失败"),
        cancelled: t("agentStatusCancelled", [], "已取消"),
        "timed-out": t("agentStatusTimedOut", [], "已超时")
      };
      return labels[job?.status] || t("agentStatusIdle", [], "尚未提交");
    }

    function eventText(event) {
      if (event.category === "stdout" || event.category === "stderr") {
        return t("agentRawDiagnosticHidden", [], "原始 Provider 诊断已记录，可在任务报告中查看");
      }
      if (["progress", "diagnostic", "result", "text"].includes(event.category)) return event.data?.text || "";
      if (["tool-use", "tool-result"].includes(event.category)) {
        const lines = [event.data?.text || ""];
        if (event.data?.tool) lines.push(t("agentEventTool", [event.data.tool], `工具：${event.data.tool}`));
        if (event.data?.detail) lines.push(t("agentEventCommand", [event.data.detail], `命令：${event.data.detail}`));
        if (Number.isInteger(event.data?.exitCode)) {
          lines.push(t("agentEventExitCode", [event.data.exitCode], `退出码：${event.data.exitCode}`));
        }
        return lines.filter(Boolean).join("\n");
      }
      if (event.category === "process") return t("agentProcessStarted", [event.data?.command || ""], `已启动 ${event.data?.command || "Provider"}`);
      if (event.category === "status") return event.data?.text || statusText({ status: event.data?.status });
      return JSON.stringify(event.data || {});
    }

    function eventBody(event) {
      const body = document.createElement("div");
      body.className = "agent-event-body";
      if (["tool-use", "tool-result"].includes(event.category)) {
        const title = document.createElement("strong");
        title.className = "agent-event-title";
        title.textContent = event.data?.text || "";
        body.append(title);

        const meta = document.createElement("div");
        meta.className = "agent-event-meta";
        if (event.data?.tool) {
          const tool = document.createElement("span");
          tool.textContent = event.data.tool;
          meta.append(tool);
        }
        if (Number.isInteger(event.data?.exitCode)) {
          const exitCode = document.createElement("span");
          exitCode.textContent = t("agentEventExitCode", [event.data.exitCode], `退出码：${event.data.exitCode}`);
          meta.append(exitCode);
        }
        if (meta.children.length > 0) body.append(meta);

        if (event.data?.detail) {
          const command = document.createElement("code");
          command.className = "agent-event-command";
          command.textContent = event.data.detail;
          command.title = event.data.detail;
          body.append(command);
        }
        return body;
      }

      const text = document.createElement("div");
      text.className = event.category === "text" ? "agent-event-message" : "agent-event-copy";
      text.textContent = eventText(event);
      body.append(text);
      return body;
    }

    function runLabel(job) {
      const time = new Date(job.createdAt || job.updatedAt).toLocaleString([], {
        month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
      });
      const mode = job.execution?.mode === "execute"
        ? t("agentModeExecute", [], "执行")
        : t("agentModePlan", [], "分析");
      return t("agentRunOption", [time, job.provider || "Agent", mode, statusText(job)],
        `${time} · ${job.provider || "Agent"} · ${mode} · ${statusText(job)}`);
    }

    function render() {
      const bridgeAvailable = bridgeState === "available";
      const checkingBridge = bridgeState === "unknown" || bridgeState === "checking";
      const active = bridgeAvailable && isAgentActive(currentJob?.status);
      const providerLocked = bridgeAvailable && (active || Boolean(currentJob?.execution));
      const isZCode = bridgeAvailable && providerSelect.value === "zcode";
      if (providerField) providerField.hidden = !bridgeAvailable;
      providerSelect.disabled = checkingBridge || providerLocked;
      if (workspaceField) workspaceField.hidden = !isZCode;
      if (workspaceInput) workspaceInput.disabled = checkingBridge || active || !isZCode;
      if (planButton) planButton.hidden = true;
      executeButton.disabled = !currentCase || checkingBridge || active;
      executeButton.textContent = bridgeAvailable
        ? t("agentExecute", [], "执行")
        : t("agentManualCopy", [], "复制给AI");
      cancelButton.disabled = !active;
      cancelButton.hidden = !active;
      status.hidden = !checkingBridge && !bridgeAvailable;
      progress.hidden = !bridgeAvailable;
      if (modeHint) modeHint.hidden = checkingBridge;
      if (recordsLink) recordsLink.hidden = !bridgeAvailable;
      followupButton.disabled = !bridgeAvailable || !currentJob || active || !["completed", "failed", "cancelled", "timed-out"].includes(currentJob.status);
      status.textContent = checkingBridge
        ? t("agentBridgeChecking", [], "正在检测 Bridge")
        : bridgeAvailable
          ? statusText(currentJob)
          : t("agentStatusManual", [], "手动交接");
      status.dataset.state = checkingBridge ? "checking" : bridgeAvailable ? currentJob?.status || "idle" : "manual";
      if (modeHint && !checkingBridge) {
        modeHint.textContent = bridgeAvailable
          ? t("agentBridgeModeHint", [], "将通过本机 Workflow Recorder Agent Bridge 启动所选工具并跟踪执行结果。")
          : t("agentManualModeHint", [], "点击“复制给AI”会将当前用例的页面、操作步骤和控件上下文整理为 Markdown 并复制到剪贴板。可粘贴到你使用的 AI 工具中，帮助分析流程或生成自动化脚本。");
      }
      historySelect.replaceChildren();
      if (caseJobs.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = t("agentNoRuns", [], "暂无运行");
        historySelect.append(option);
      } else {
        for (const job of caseJobs) {
          const option = document.createElement("option");
          option.value = job.jobId;
          option.textContent = runLabel(job);
          historySelect.append(option);
        }
      }
      historySelect.value = currentJob?.jobId || "";
      const received = currentJob?.progress?.bytesReceived || 0;
      const total = currentJob?.progress?.totalBytes || 0;
      const latestEventText = [...(currentJob?.events || [])]
        .reverse()
        .map(eventText)
        .find(Boolean) || "";
      const progressText = total > 0 && received < total
        ? t("agentUploadProgress", [Math.round(received / total * 100)], `上传 ${Math.round(received / total * 100)}%`)
        : currentJob?.execution?.resultSummary
          ? t("agentResultSummary", [
            currentJob.execution.resultSummary.statusCounts?.completed || 0,
            currentJob.execution.resultSummary.statusCounts?.failed || 0,
            currentJob.execution.resultSummary.statusCounts?.["not-executed"] || 0
          ], "")
          : latestEventText || ((currentJob?.attempts || []).length > 0
            ? t("agentAttemptSummary", [currentJob.attempt || currentJob.attempts.length, currentJob.attempts.length], `第 ${currentJob.attempt || currentJob.attempts.length} 次尝试 · 共 ${currentJob.attempts.length} 次`)
            : "");
      progress.textContent = progressText;
      if (recordsProgress) recordsProgress.textContent = progressText || statusText(currentJob);
      const eventItems = currentJob?.events || [];
      empty.hidden = eventItems.length > 0 || Boolean(currentJob?.error);
      const rows = eventItems.map(event => {
        const row = document.createElement("div");
        row.className = `agent-event agent-event-${event.category || "progress"} agent-event-${event.level || "info"}`;
        const time = document.createElement("time");
        time.textContent = new Date(event.timestamp).toLocaleTimeString();
        const body = eventBody(event);
        if (event.data?.tool) row.dataset.tool = event.data.tool;
        row.append(time, body);
        return row;
      });
      if (currentJob?.error) {
        const row = document.createElement("div");
        row.className = "agent-event agent-event-error";
        const body = document.createElement("div");
        body.className = "agent-event-copy";
        body.textContent = `${currentJob.error.code || "ERROR"}: ${currentJob.error.message || currentJob.connectionError || ""}`;
        row.append(body);
        rows.push(row);
      }
      events.replaceChildren(...rows);
      events.scrollTop = events.scrollHeight;
    }

    async function sha256(bytes) {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
    }

    function bytesToBase64(bytes) {
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    }

    async function refresh(caseId = currentCase?.id) {
      if (!caseId || bridgeState !== "available") return;
      const response = await sendRuntimeMessage({ action: MESSAGE.agentListJobs });
      if (!response?.success) return;
      const matches = Object.values(response.jobs || {})
        .filter(job => job.clientCaseId === caseId)
        .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
      caseJobs = matches;
      const selectedJobId = preferredJobId || historySelect.value || currentJob?.jobId;
      currentJob = matches.find(job => job.jobId === selectedJobId) || matches[0] || null;
      preferredJobId = null;
      if (currentJob?.provider) providerSelect.value = currentJob.provider;
      if (currentJob?.provider === "zcode" && currentJob.workspacePath && workspaceInput) {
        workspaceInput.value = currentJob.workspacePath;
        persistWorkspacePath(currentJob.workspacePath);
      }
      if (currentJob?.jobId) historySelect.value = currentJob.jobId;
      render();
    }

    async function selectRun(jobId) {
      if (!jobId) return;
      const response = await sendRuntimeMessage({ action: MESSAGE.agentListJobs });
      if (!response?.success) return;
      currentJob = Object.values(response.jobs || {}).find(job => job.jobId === jobId) || currentJob;
      caseJobs = Object.values(response.jobs || {})
        .filter(job => job.clientCaseId === currentCase?.id)
        .sort((left, right) => Number(right.updatedAt) - Number(left.updatedAt));
      if (currentJob?.provider) providerSelect.value = currentJob.provider;
      if (currentJob?.provider === "zcode" && currentJob.workspacePath && workspaceInput) {
        workspaceInput.value = currentJob.workspacePath;
        persistWorkspacePath(currentJob.workspacePath);
      }
      render();
    }

    async function copyManualPrompt() {
      const language = globalThis.RecorderI18n.getLanguage?.() || "zh_CN";
      await writeClipboard(buildManualPrompt(currentCase, language));
      notify(t("agentManualCopied", [], "任务说明已复制"));
    }

    async function run(mode = "execute") {
      if (!currentCase || (bridgeState === "available" && isAgentActive(currentJob?.status))) return;
      if (bridgeState === "unknown" || bridgeState === "checking") await detectBridge();
      if (bridgeState !== "available") {
        try {
          await copyManualPrompt();
        } catch (error) {
          reportError(error.message || t("copyFailed", [], "复制失败"));
        }
        return;
      }
      const provider = providerSelect.value;
      const isZCode = provider === "zcode";
      const workspacePath = workspaceInput?.value?.trim() || "";
      if (isZCode && !workspacePath) {
        reportError(t("agentWorkspaceRequired", [], "使用 ZCode 时请填写项目目录"));
        workspaceInput?.focus?.();
        return;
      }
      if (isZCode) persistWorkspacePath(workspacePath);
      if (mode === "execute") {
        const isWorkBuddy = provider === "workbuddy";
        const confirmed = await confirmAction({
          title: isWorkBuddy
            ? t("agentWorkBuddyConfirmTitle", [], "交接到 WorkBuddy")
            : t("agentExecuteConfirmTitle", [], "执行真实页面测试"),
          message: isWorkBuddy
            ? t("agentWorkBuddyConfirmMessage", [], "将打开 WorkBuddy 并复制任务指令。打开后粘贴并发送即可，无需下载或 @ 上传录制包。")
            : t("agentExecuteConfirmMessage", [], "将调用本机 Agent，并允许它根据录制用例执行真实页面操作。确定继续吗？"),
          confirmText: isWorkBuddy
            ? t("agentWorkBuddyOpen", [], "打开 WorkBuddy")
            : t("agentExecute", [], "执行"),
          danger: true
        });
        if (!confirmed) return;
      }
      if (planButton) planButton.disabled = true;
      executeButton.disabled = true;
      status.textContent = t("agentStatusPackaging", [], "正在打包用例");
      try {
        const archive = await buildCasePackage([currentCase]);
        if (!archive) throw new Error(t("agentPackageEmpty", [], "用例没有可提交的步骤"));
        const wholeHash = await sha256(archive);
        // The case name is display metadata, not a transport path. Keep the
        // uploaded filename ASCII and stable so Chinese or punctuation-heavy
        // user names cannot fail the Host's safe filename validation.
        const fileName = "recording.swrcase";
        const created = await sendRuntimeMessage({
          action: MESSAGE.agentCreateJob,
          provider,
          workspacePath: isZCode ? workspacePath : undefined,
          skill: "test-base",
          timeoutMs: 600000,
          caseId: currentCase.id,
          caseName: currentCase.name,
          fileName,
          totalBytes: archive.byteLength,
          sha256: wholeHash
        }, 60000);
        if (!created?.success) throw new Error(created?.error || t("agentCreateFailed", [], "创建 Agent 任务失败"));
        const { jobId, inputId, maxChunkBytes } = created.message.payload;
        currentJob = { jobId, clientCaseId: currentCase.id, provider, status: "awaiting-input", events: [] };
        caseJobs = [currentJob, ...caseJobs.filter(job => job.jobId !== jobId)];
        render();
        const chunkSize = Math.min(CHUNK_BYTES, maxChunkBytes || CHUNK_BYTES);
        const totalChunks = Math.ceil(archive.byteLength / chunkSize);
        for (let offset = 0, index = 0; offset < archive.byteLength; offset += chunkSize, index++) {
          const bytes = archive.slice(offset, Math.min(archive.byteLength, offset + chunkSize));
          const uploaded = await sendRuntimeMessage({
            action: MESSAGE.agentUploadChunk,
            jobId,
            chunk: {
              inputId,
              fileName,
              index,
              totalChunks,
              byteOffset: offset,
              byteLength: bytes.byteLength,
              encoding: "base64",
              data: bytesToBase64(bytes),
              chunkSha256: await sha256(bytes),
              isFinal: index === totalChunks - 1
            }
          }, 60000);
          if (!uploaded?.success) throw new Error(uploaded?.error || t("agentUploadFailed", [], "上传用例失败"));
          currentJob = { ...currentJob, ...(uploaded.message.payload || {}) };
          render();
        }
        const started = await sendRuntimeMessage({
          action: MESSAGE.agentCommitAndStart,
          jobId,
          mode,
          commit: { inputId, totalChunks, totalBytes: archive.byteLength, sha256: wholeHash }
        }, 150000);
        if (!started?.success) throw new Error(started?.error || t("agentStartFailed", [], "启动 Agent 任务失败"));
        currentJob = { ...currentJob, ...(started.message.payload || {}) };
        render();
      } catch (error) {
        reportError(error.message);
        await refresh();
      }
    }

    async function cancel() {
      if (!currentJob?.jobId) return;
      const response = await sendRuntimeMessage({ action: MESSAGE.agentCancel, jobId: currentJob.jobId }, 60000);
      if (!response?.success) {
        reportError(response?.error || t("agentCancelFailed", [], "取消 Agent 任务失败"));
        return;
      }
      currentJob = { ...currentJob, ...(response.message.payload || {}) };
      render();
    }

    async function followup() {
      const message = followupInput.value.trim();
      if (!currentJob?.jobId || !message) {
        reportError(t("agentFollowupEmpty", [], "请先填写需要补充的信息"));
        return;
      }
      followupButton.disabled = true;
      try {
        if (currentJob.provider) providerSelect.value = currentJob.provider;
        const response = await sendRuntimeMessage({
          action: MESSAGE.agentFollowup,
          jobId: currentJob.jobId,
          message,
          mode: currentJob.execution?.mode || "execute"
        }, 60000);
        if (!response?.success) throw new Error(response?.error || t("agentFollowupFailed", [], "提交补充信息失败"));
        followupInput.value = "";
        currentJob = { ...currentJob, ...(response.message.payload || {}), provider: currentJob.provider, status: "running" };
        render();
      } catch (error) {
        reportError(error.message);
        await refresh();
      }
    }

    const onRuntimeMessage = message => {
      if (message?.action !== MESSAGE.agentJobUpdated) return;
      if (message.message?.jobId !== currentJob?.jobId) return;
      refresh().catch(() => {});
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    planButton?.addEventListener("click", () => run("plan"));
    executeButton.addEventListener("click", () => run("execute"));
    cancelButton.addEventListener("click", cancel);
    providerSelect.addEventListener("change", render);
    workspaceInput?.addEventListener("input", () => persistWorkspacePath());
    historySelect.addEventListener("change", () => selectRun(historySelect.value).catch(() => {}));
    followupButton.addEventListener("click", followup);

    async function setCase(caseRecord, jobId = null) {
      currentCase = caseRecord;
      currentJob = null;
      caseJobs = [];
      preferredJobId = jobId;
      render();
      if (bridgeState === "unknown") await detectBridge();
      if (bridgeState === "available") await refresh(caseRecord?.id);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    }

    render();
    return { setCase, selectRun, refresh, run, cancel, dispose };
  }

  globalThis.RecorderCaseAgentRunner = { buildManualPrompt, create };
})();
