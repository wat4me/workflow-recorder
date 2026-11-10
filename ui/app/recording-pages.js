/** Shows recording membership independently from whichever draft the panel renders. */
export function createRecordingPages() {
  const { t } = globalThis.RecorderI18n;
  const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
  const { sendRuntimeMessage } = globalThis.RecorderBridge;
  const { notify, reportError } = globalThis.RecorderDialogs;
  const section = document.getElementById("recording-pages");
  const count = document.getElementById("recording-pages-count");
  const status = document.getElementById("recording-pages-status");
  const list = document.getElementById("recording-pages-list");
  const join = document.getElementById("join-recording-page");
  const form = document.getElementById("join-recording-page-form");
  const select = document.getElementById("join-recording-page-select");
  const cancel = document.getElementById("join-recording-page-cancel");
  const confirm = document.getElementById("join-recording-page-confirm");
  const scopeKeys = ["isRecording", "recordingTabIds", "tabsMapping", "activeRecordingDraftId"];
  let scopeIds = [];
  let draftId = null;
  let pickerDraftId = null;
  let candidates = [];
  let version = 0;

  function closePicker() {
    form.hidden = true;
    join.hidden = false;
    pickerDraftId = null;
    candidates = [];
    select.replaceChildren();
  }

  async function refresh() {
    const request = ++version;
    const [state, [current]] = await Promise.all([
      chrome.storage.local.get(scopeKeys),
      chrome.tabs.query({ active: true, currentWindow: true })
    ]);
    if (request !== version) return;
    scopeIds = state.recordingTabIds || [];
    draftId = state.activeRecordingDraftId || null;
    section.hidden = !state.isRecording || scopeIds.length === 0;
    if (section.hidden || (pickerDraftId && pickerDraftId !== draftId)) closePicker();
    if (section.hidden) {
      section.open = false;
      return;
    }

    const included = scopeIds.includes(current?.id);
    status.textContent = included
      ? t("currentPageInRecording", [], "当前页面在录制范围内")
      : t("currentPageOutsideRecording", [], "当前页面未加入录制");
    status.dataset.inScope = String(included);
    count.textContent = String(scopeIds.length);
    join.disabled = !draftId;
    if (!section.open) return;

    const tabs = await Promise.all(scopeIds.map(id => chrome.tabs.get(id).catch(() => null)));
    if (request !== version) return;
    list.replaceChildren(...tabs.map((tab, index) => {
      const row = document.createElement("li");
      const page = document.createElement("span");
      const title = document.createElement("span");
      page.className = "recording-page-handle";
      page.textContent = state.tabsMapping?.[scopeIds[index]] || t("recordingPagePendingHandle", [], "待编号");
      title.className = "recording-page-title";
      title.textContent = tab?.title || tab?.url || t("untitledPage", [], "未命名页面");
      title.title = tab?.url || title.textContent;
      if (tab?.id === current?.id) row.setAttribute("aria-current", "true");
      row.append(page, title);
      return row;
    }));
  }

  function refreshQuietly() {
    refresh().catch(error => console.warn("[Recording pages] Could not refresh the page list:", error));
  }

  join.addEventListener("click", async () => {
    const requestedDraftId = draftId;
    if (!requestedDraftId) return;
    join.disabled = true;
    try {
      const [tabs, currentWindow] = await Promise.all([chrome.tabs.query({}), chrome.windows.getCurrent()]);
      if (section.hidden || draftId !== requestedDraftId) return;
      candidates = tabs.filter(tab => !scopeIds.includes(tab.id) && /^(https?|file):/i.test(tab.url || ""));
      if (!candidates.length) {
        notify(t("noRecordingPagesToJoin", [], "没有可加入的其他页面"));
        return;
      }
      candidates.sort((a, b) => Number(b.windowId === currentWindow.id) - Number(a.windowId === currentWindow.id)
        || a.windowId - b.windowId || a.index - b.index);
      select.replaceChildren(new Option(t("joinRecordingPageSelect", [], "选择已打开的页面"), ""));
      let group;
      let windowId;
      for (const tab of candidates) {
        if (windowId !== tab.windowId) {
          windowId = tab.windowId;
          group = document.createElement("optgroup");
          group.label = windowId === currentWindow.id
            ? t("currentWindow", [], "当前窗口")
            : t("otherWindow", [windowId], `窗口 ${windowId}`);
          select.append(group);
        }
        const label = tab.title ? `${tab.title} · ${tab.url}` : tab.url;
        group.append(new Option(label, String(tab.id)));
      }
      pickerDraftId = requestedDraftId;
      join.hidden = true;
      form.hidden = false;
      confirm.disabled = true;
      select.focus();
    } catch (error) {
      reportError(error.message);
    } finally {
      join.disabled = !draftId;
    }
  });

  select.addEventListener("change", () => { confirm.disabled = !select.value; });
  cancel.addEventListener("click", () => { closePicker(); join.focus(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const tab = candidates.find(item => String(item.id) === select.value);
    if (!tab || !pickerDraftId || select.disabled) return;
    select.disabled = cancel.disabled = confirm.disabled = true;
    try {
      const response = await sendRuntimeMessage({
        action: MESSAGE.joinRecordingPage, tabId: tab.id, url: tab.url, workspaceDraftId: pickerDraftId
      });
      if (!response?.success) throw new Error(response?.error || t("joinRecordingPageFailed", [], "无法加入此页面，请重新选择"));
      closePicker();
      join.focus();
      refreshQuietly();
      notify(t("recordingPageJoined", [response.pageName], `已加入录制（${response.pageName}）`));
    } catch (error) {
      reportError(error.message);
    } finally {
      select.disabled = cancel.disabled = false;
      confirm.disabled = !select.value;
    }
  });

  section.addEventListener("toggle", refreshQuietly);
  window.addEventListener("recorderLanguageChanged", refreshQuietly);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && scopeKeys.some(key => key in changes)) refreshQuietly();
  });
  chrome.tabs.onActivated.addListener(refreshQuietly);
  chrome.windows.onFocusChanged.addListener(refreshQuietly);
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (section.open && scopeIds.includes(tabId) && (change.title !== undefined || change.url !== undefined)) refreshQuietly();
  });
  refreshQuietly();
}
