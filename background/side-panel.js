/**
 * Tab-scoped side panel, and the page-fit layout that goes with it.
 *
 * The panel is deliberately not enabled window-wide. It is switched on for the
 * one tab where the user clicked the toolbar icon, so opening the extension on
 * one tab does not put a panel on every tab in the window.
 *
 * While the panel is open the recorded page is asked to shrink itself
 * (`setPageFit`) so the panel does not cover content. That has to be undone when
 * the panel closes, when it moves to another tab in the same window, or when the
 * panel page is torn down -- hence the windowId -> tabId map.
 */
import "../shared/protocol.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
import { ensurePageFitScript } from "./recording/injection.js";

const LAYOUT_PORT_NAME = "side-panel-layout";
const PANEL_PATH = "ui/popup.html";

export function createSidePanelController({ isRecordableTab }) {
  const layoutTabs = new Map();
  const layoutPorts = new Map();

  const ready = Promise.all([
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }),
    chrome.sidePanel.setOptions({ enabled: false })
  ]).catch(error => {
    console.error("[Background] Failed to configure tab-scoped side panel:", error);
  });

  function setPageFit(tabId, enabled) {
    if (!Number.isInteger(tabId)) return;
    chrome.tabs.sendMessage(tabId, { action: MESSAGE.setPageFit, enabled }).catch(() => {});
  }

  function openForTab(tab) {
    if (!isRecordableTab(tab)) return;

    // open() must be invoked synchronously in the click callback. Awaiting even
    // setOptions() first causes Chrome to discard the user-gesture permission.
    const configurePanel = chrome.sidePanel.setOptions({
      tabId: tab.id,
      path: PANEL_PATH,
      enabled: true
    });
    const openPanel = chrome.sidePanel.open({ tabId: tab.id });

    // The panel's layout handshake prepares the top frame once it is ready.
    Promise.all([ready, configurePanel, openPanel]).catch(error => {
      console.error(`[Background] Failed to open side panel for tab ${tab.id}:`, error);
    });
  }

  /**
   * Brings the panel up on a tab the user picked in the workbench's
   * continue-recording dialog. Full recording injection belongs to session start.
   */
  async function prepareForTab(tabId) {
    if (!Number.isInteger(tabId)) return { success: false, error: "Invalid target tab" };
    const tab = await chrome.tabs.get(tabId);
    if (!isRecordableTab(tab)) return { success: false, error: "目标页面不可录制" };
    await chrome.sidePanel.setOptions({ tabId, path: PANEL_PATH, enabled: true });
    await ensurePageFitScript(tabId);
    await chrome.tabs.update(tabId, { active: true });
    await chrome.sidePanel.open({ tabId });
    return { success: true, tabId, windowId: tab.windowId };
  }

  async function setLayout({ open, tabId, windowId }) {
    if (!Number.isInteger(windowId)) return { success: false };

    const previousTabId = layoutTabs.get(windowId);
    if (previousTabId && previousTabId !== tabId) setPageFit(previousTabId, false);

    if (!open) {
      layoutTabs.delete(windowId);
      setPageFit(tabId, false);
      return { success: true };
    }

    if (!Number.isInteger(tabId)) return { success: false };
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!isRecordableTab(tab) || tab.windowId !== windowId) return { success: false };
      await ensurePageFitScript(tabId);
      layoutTabs.set(windowId, tabId);
      await chrome.tabs.sendMessage(tabId, { action: MESSAGE.setPageFit, enabled: true });
      return { success: true };
    } catch (error) {
      layoutTabs.delete(windowId);
      return { success: false, error: error.message };
    }
  }

  /** Undoes page fit when the panel page goes away without telling us. */
  function restoreWindow(windowId) {
    const tabId = layoutTabs.get(windowId);
    layoutTabs.delete(windowId);
    setPageFit(tabId, false);
  }

  /**
   * The panel page holds a port open purely so its teardown is observable;
   * side panels get no unload event we can rely on.
   */
  function trackLayoutPort(port) {
    if (port.name !== LAYOUT_PORT_NAME) return false;
    let windowId = null;
    port.onMessage.addListener(message => {
      if (!Number.isInteger(message.windowId)) return;
      if (windowId !== null && windowId !== message.windowId && layoutPorts.get(windowId) === port) {
        layoutPorts.delete(windowId);
        restoreWindow(windowId);
      }
      windowId = message.windowId;
      layoutPorts.set(windowId, port);
    });
    port.onDisconnect.addListener(() => {
      void chrome.runtime.lastError;
      // A replacement may already have rebound the panel. Its predecessor's
      // delayed disconnect must not undo the newly restored page layout.
      if (windowId !== null && layoutPorts.get(windowId) === port) {
        layoutPorts.delete(windowId);
        restoreWindow(windowId);
      }
    });
    return true;
  }

  return { openForTab, prepareForTab, setLayout, trackLayoutPort };
}
