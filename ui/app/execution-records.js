/** Global Agent execution history linked back to saved cases. */
(function () {
  if (globalThis.RecorderExecutionRecords) return;

  function create(options) {
    const {
      list,
      emptyState,
      countBadge,
      searchInput,
      statusFilter,
      sendRuntimeMessage,
      onOpenRun,
      onOpenCase
    } = options;
    const { t } = globalThis.RecorderI18n;
    const { MESSAGE, isAgentActive } = globalThis.WorkflowRecorderProtocol;
    let jobs = [];
    let liveCases = null;
    let disposed = false;

    function localeTag() {
      return globalThis.RecorderI18n.getLanguage() === "zh_CN" ? "zh-CN" : "en";
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

    function modeText(job) {
      return job.execution?.mode === "execute"
        ? t("agentModeExecute", [], "执行")
        : t("agentModePlan", [], "分析");
    }

    function caseExists(job) {
      return liveCases === null || liveCases.has(job.clientCaseId);
    }

    function button(text, className, handler, disabled = false) {
      const control = document.createElement("button");
      control.type = "button";
      control.className = className;
      control.textContent = text;
      control.disabled = disabled;
      if (!disabled) control.addEventListener("click", handler);
      return control;
    }

    function summaryText(job) {
      const counts = job.execution?.resultSummary?.statusCounts;
      if (counts) {
        return t("agentResultSummary", [
          counts.completed || 0,
          counts.failed || 0,
          counts["not-executed"] || 0
        ], `完成 ${counts.completed || 0} · 失败 ${counts.failed || 0} · 未执行 ${counts["not-executed"] || 0}`);
      }
      const eventCount = job.events?.length || 0;
      return eventCount > 0
        ? t("agentRecordEventCount", [eventCount], `${eventCount} 条执行事件`)
        : t("agentRecordNoEvents", [], "暂无执行事件");
    }

    function buildRecord(job) {
      const record = document.createElement("article");
      record.className = `execution-record execution-record-${job.status || "unknown"}`;
      record.dataset.jobId = job.jobId;
      record.dataset.caseId = job.clientCaseId || "";

      const marker = document.createElement("div");
      marker.className = "execution-record-marker";
      const status = document.createElement("span");
      status.className = "execution-record-status";
      status.textContent = statusText(job);

      const body = document.createElement("div");
      body.className = "execution-record-body";
      const heading = document.createElement("div");
      heading.className = "execution-record-heading";
      const title = document.createElement("strong");
      title.textContent = liveCases?.get(job.clientCaseId)?.name || job.clientCaseName || t("agentUnknownCase", [], "未命名用例");
      const id = document.createElement("code");
      id.textContent = job.jobId;
      heading.append(title, status, id);

      const timeValue = job.execution?.startedAt || job.createdAt || job.updatedAt;
      const time = new Date(timeValue).toLocaleString(localeTag(), {
        year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
      });
      const meta = document.createElement("div");
      meta.className = "execution-record-meta";
      const values = [job.provider || "Agent", modeText(job), time];
      if (job.attempt || job.attemptCount) {
        values.push(t("agentAttemptNumber", [job.attempt || job.attemptCount], `第 ${job.attempt || job.attemptCount} 次尝试`));
      }
      meta.textContent = values.join(" · ");

      const summary = document.createElement("p");
      summary.className = "execution-record-summary";
      summary.textContent = caseExists(job)
        ? summaryText(job)
        : t("agentLinkedCaseDeleted", [], "关联用例已删除，执行记录仍保留");
      body.append(heading, meta, summary);

      const actions = document.createElement("div");
      actions.className = "execution-record-actions";
      const missing = !caseExists(job);
      actions.append(
        button(
          t("agentOpenRunDetail", [], "查看本次执行"),
          "btn btn-accent btn-compact",
          () => onOpenRun(job),
          missing
        ),
        button(
          missing
            ? t("agentLinkedCaseDeletedShort", [], "用例已删除")
            : t("agentOpenLinkedCase", [], "查看关联用例"),
          "btn btn-secondary btn-compact",
          () => onOpenCase(job),
          missing
        )
      );

      record.append(marker, body, actions);
      return record;
    }

    function render() {
      const query = searchInput.value.trim().toLocaleLowerCase(localeTag());
      const selectedStatus = statusFilter.value;
      const filtered = jobs.filter(job => {
        const matchesStatus = !selectedStatus || selectedStatus === "active"
          ? (!selectedStatus || isAgentActive(job.status))
          : job.status === selectedStatus;
        const searchable = `${job.clientCaseName || ""} ${job.clientCaseId || ""} ${job.jobId || ""} ${job.provider || ""}`
          .toLocaleLowerCase(localeTag());
        return matchesStatus && (!query || searchable.includes(query));
      });
      list.replaceChildren(...filtered.map(buildRecord));
      countBadge.textContent = String(jobs.length);
      emptyState.hidden = filtered.length > 0;
      list.hidden = filtered.length === 0;
      const title = emptyState.querySelector("p");
      const hint = emptyState.querySelector("span");
      if (jobs.length > 0 && filtered.length === 0) {
        title.textContent = t("agentNoMatchingRecords", [], "没有匹配的执行记录");
        hint.textContent = t("agentAdjustRecordFilters", [], "请调整搜索词或状态筛选");
      } else {
        title.textContent = t("agentNoGlobalRuns", [], "暂无执行记录");
        hint.textContent = t("agentNoGlobalRunsHint", [], "从任意用例启动 Agent 后，运行会集中显示在这里");
      }
    }

    async function refresh() {
      const [jobResponse, caseResponse] = await Promise.all([
        sendRuntimeMessage({ action: MESSAGE.agentListJobs }),
        sendRuntimeMessage({ action: MESSAGE.listCases })
      ]);
      if (!jobResponse?.success) throw new Error(jobResponse?.error || t("agentRecordsLoadFailed", [], "读取执行记录失败"));
      jobs = Object.values(jobResponse.jobs || {}).sort((left, right) =>
        Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
      liveCases = caseResponse?.success
        ? new Map((caseResponse.cases || []).map(item => [item.id, item]))
        : null;
      render();
    }

    searchInput.addEventListener("input", render);
    statusFilter.addEventListener("change", render);
    const onRuntimeMessage = message => {
      if (!disposed && message?.action === MESSAGE.agentJobUpdated) refresh().catch(() => {});
    };
    const onStorageChanged = (changes, area) => {
      if (!disposed && area === "local" && changes.caseIndex) refresh().catch(() => {});
    };
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
    chrome.storage.onChanged.addListener(onStorageChanged);

    function dispose() {
      if (disposed) return;
      disposed = true;
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
      chrome.storage.onChanged.removeListener(onStorageChanged);
    }

    render();
    return { dispose, refresh };
  }

  globalThis.RecorderExecutionRecords = { create };
})();
