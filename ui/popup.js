/**
 * Side panel page.
 *
 * Recording controls and current-workspace actions live in app/recorder-panel.js.
 * Full case management belongs to the fullscreen workbench. What stays here is
 * specific to the panel: keeping the recorded page fitted while it is open, the
 * steps/document tab strip, and the shortcut that opens the workbench.
 */
const { MESSAGE } = globalThis.WorkflowRecorderProtocol;

document.addEventListener("DOMContentLoaded", async () => {
  await window.RecorderI18n.ready;
  window.RecorderI18n.applyI18n();
  window.RecorderI18n.bindLanguageToggle(document.getElementById("language-btn"));

  const elements = {
    recordBtn: document.getElementById("record-btn"),
    recordBtnLabel: document.getElementById("record-btn-label"),
    manualScreenshotBtn: document.getElementById("manual-screenshot-btn"),
    downloadDocCompactBtn: document.getElementById("download-doc-compact-btn"),
    clearStepsBtn: document.getElementById("clear-steps-btn"),
    captureSettingsBtn: document.getElementById("capture-settings-btn"),
    downloadDocBtn: document.getElementById("download-doc-btn"),
    moreActionsBtn: document.getElementById("more-actions-btn"),
    moreActionsMenu: document.getElementById("more-actions-menu"),
    copyTaskBtn: document.getElementById("copy-task-btn"),
    saveCurrentCaseBtn: document.getElementById("save-current-case-btn"),
    recoverRecordingsBtn: document.getElementById("recover-recordings-btn"),
    closeRecoveryBtn: document.getElementById("close-recording-recovery-btn"),
    recoveryPanel: document.getElementById("recording-recovery-panel"),
    recoveryList: document.getElementById("recording-recovery-list")
  };

  const openConsoleBtn = document.getElementById("open-console-btn");
  const compactLayout = matchMedia("(max-width: 560px)");

  function updateToolbarLayout() {
    if (compactLayout.matches) {
      elements.moreActionsMenu.hidden = true;
      elements.moreActionsBtn.setAttribute("aria-expanded", "false");
    }
    for (const button of [elements.manualScreenshotBtn, elements.downloadDocCompactBtn]) {
      button.classList.add("icon-only");
    }
  }

  compactLayout.addEventListener("change", updateToolbarLayout);

  let layoutTabId = null;
  let layoutWindowId = null;
  let layoutPort = null;
  let layoutReconnectTimer = null;
  let resumePromise = null;
  let disposed = false;

  function getLayoutPort() {
    if (layoutPort) return layoutPort;
    const port = chrome.runtime.connect({ name: "side-panel-layout" });
    layoutPort = port;
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      if (layoutPort !== port) return;
      layoutPort = null;
      if (!disposed && document.visibilityState === "visible") {
        clearTimeout(layoutReconnectTimer);
        layoutReconnectTimer = setTimeout(resumePanelContext, 1000);
      }
    });
    return port;
  }

  function bindLayoutPort(windowId) {
    // postMessage can throw before onDisconnect has cleared a stale port.
    // Retry once with a fresh connection; later failures remain observable.
    for (let attempt = 0; attempt < 2; attempt++) {
      const port = getLayoutPort();
      try {
        port.postMessage({ windowId });
        return;
      } catch (error) {
        if (layoutPort === port) layoutPort = null;
        try { port.disconnect(); } catch { /* Already disconnected. */ }
        if (attempt === 1) throw error;
      }
    }
  }

  const stepView = window.RecorderStepView.create({
    stepsContainer: document.getElementById("steps-container"),
    emptyState: document.getElementById("empty-state"),
    stepCountBadge: document.getElementById("step-count"),
    selectAllSteps: document.getElementById("step-select-all"),
    deleteSelectedStepsBtn: document.getElementById("batch-delete-steps-btn"),
    downloadDocBtn: elements.downloadDocBtn,
    saveCurrentCaseBtn: elements.saveCurrentCaseBtn,
    onChanged: () => panel.refreshState()
  });

  const panel = window.RecorderPanel.create({
    elements,
    stepView,
    onStateRendered: updateToolbarLayout,
    // A recording attaches to the tab this panel is fitted to, not to whichever
    // tab happens to be active when the button is pressed.
    resolveRootTabId: () => layoutTabId,
    // A manual screenshot follows the page the user is currently viewing. The
    // worker still rejects tabs outside the active recording scope.
    resolveCaptureTabId: async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id || layoutTabId;
    }
  });

  async function syncPageLayout(open) {
    if (!open) {
      if (layoutTabId === null || layoutWindowId === null) return;
      chrome.runtime.sendMessage({
        action: MESSAGE.setSidePanelLayout,
        open: false,
        tabId: layoutTabId,
        windowId: layoutWindowId
      }).catch(() => {});
      layoutTabId = null;
      layoutWindowId = null;
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (disposed) return;
    if (!tab?.id || !Number.isInteger(tab.windowId) || !/^(https?|file):/i.test(tab.url || "") || tab.url.startsWith(chrome.runtime.getURL(""))) {
      await syncPageLayout(false);
      return;
    }
    layoutTabId = tab.id;
    layoutWindowId = tab.windowId;
    bindLayoutPort(tab.windowId);
    await chrome.runtime.sendMessage({
      action: MESSAGE.setSidePanelLayout,
      open: true,
      tabId: tab.id,
      windowId: tab.windowId
    }).catch(() => {});
  }

  openConsoleBtn.addEventListener("click", async () => {
    chrome.tabs.create({ url: chrome.runtime.getURL("ui/console.html") });
    window.close();
  });

  function resumePanelContext() {
    if (disposed || document.visibilityState !== "visible") return Promise.resolve();
    return refreshPanelContext();
  }

  function refreshPanelContext() {
    if (disposed) return Promise.resolve();
    if (resumePromise) return resumePromise;
    clearTimeout(layoutReconnectTimer);
    layoutReconnectTimer = null;
    resumePromise = (async () => {
      try {
        await syncPageLayout(true);
      } catch (error) {
        console.warn("[SidePanel] Layout binding failed:", error);
      }
      // A layout connection failure must not block the draft/steps refresh.
      if (!disposed) await panel.refreshState();
    })().catch(error => console.warn("[SidePanel] State refresh failed:", error))
      .finally(() => { resumePromise = null; });
    return resumePromise;
  }
  document.addEventListener("visibilitychange", resumePanelContext);
  window.addEventListener("focus", resumePanelContext);

  window.addEventListener("unload", () => {
    disposed = true;
    clearTimeout(layoutReconnectTimer);
    compactLayout.removeEventListener("change", updateToolbarLayout);
    document.removeEventListener("visibilitychange", resumePanelContext);
    window.removeEventListener("focus", resumePanelContext);
    stepView.dispose();
    syncPageLayout(false);
    const port = layoutPort;
    layoutPort = null;
    try { port?.disconnect(); } catch { /* Already disconnected. */ }
  });

  // Initial rendering must also run when Chrome creates the panel hidden.
  await refreshPanelContext();
});
