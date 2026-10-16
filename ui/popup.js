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
    draftSelect: document.getElementById("recording-draft-select"),
    draftStatus: document.getElementById("recording-draft-status")
  };

  const openConsoleBtn = document.getElementById("open-console-btn");
  const compactLayout = matchMedia("(max-width: 560px)");

  function fitToolbarLabels() {
    const { recordBtn, manualScreenshotBtn, downloadDocCompactBtn } = elements;
    if (compactLayout.matches) {
      elements.moreActionsMenu.hidden = true;
      elements.moreActionsBtn.setAttribute("aria-expanded", "false");
    }
    const button = !manualScreenshotBtn.hidden ? manualScreenshotBtn : downloadDocCompactBtn;
    if (!button.getClientRects().length) return;
    // Measure with the full label so resizing back out restores it. Prioritize
    // the recording action, whose translated text must never be squeezed out.
    button.classList.remove("icon-only");
    button.classList.toggle("icon-only", recordBtn.scrollWidth > recordBtn.clientWidth);
  }

  const toolbarObserver = new ResizeObserver(fitToolbarLabels);
  compactLayout.addEventListener("change", fitToolbarLabels);
  toolbarObserver.observe(document.querySelector(".header-record-actions"));
  const labelObserver = new MutationObserver(fitToolbarLabels);
  for (const button of [elements.manualScreenshotBtn, elements.downloadDocCompactBtn]) {
    labelObserver.observe(button.querySelector(".btn-label"), {
      childList: true, characterData: true, subtree: true
    });
  }

  let layoutTabId = null;
  let layoutWindowId = null;
  const layoutPort = chrome.runtime.connect({ name: "side-panel-layout" });

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
    onStateRendered: fitToolbarLabels,
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
    if (!tab?.id || !Number.isInteger(tab.windowId) || !/^(https?|file):/i.test(tab.url || "") || tab.url.startsWith(chrome.runtime.getURL(""))) {
      await syncPageLayout(false);
      return;
    }
    layoutTabId = tab.id;
    layoutWindowId = tab.windowId;
    layoutPort.postMessage({ windowId: tab.windowId });
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
    if (document.visibilityState !== "visible") return;
    syncPageLayout(true).then(() => panel.refreshState()).catch(error => console.warn("[Drafts] Panel binding failed:", error));
  }
  document.addEventListener("visibilitychange", resumePanelContext);
  window.addEventListener("focus", resumePanelContext);

  window.addEventListener("unload", () => {
    compactLayout.removeEventListener("change", fitToolbarLabels);
    toolbarObserver.disconnect();
    labelObserver.disconnect();
    document.removeEventListener("visibilitychange", resumePanelContext);
    window.removeEventListener("focus", resumePanelContext);
    stepView.dispose();
    syncPageLayout(false);
    layoutPort.disconnect();
  });

  await syncPageLayout(true);
  panel.refreshState();
});
