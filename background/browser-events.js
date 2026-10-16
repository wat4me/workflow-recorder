import { readRecordingCapturePlan } from "../shared/capture-settings.js";

const RECORDING_KEEPALIVE_PORT = "recording-keepalive";

/** Attaches Chrome browser events for the lifetime of the Service Worker. */
export function registerBrowserEventHandlers({
  injectRecordingScripts,
  injectRecordingScriptsIntoFrame,
  queueAction,
  queueTabRegistration,
  scope,
  screencast,
  screenshots,
  sidePanel,
  drafts,
  queueRecordingTransition
}) {
  const keepalivePorts = new Set();

  chrome.runtime.onConnect.addListener(port => {
    if (sidePanel.trackLayoutPort(port)) return;
    if (port.name !== RECORDING_KEEPALIVE_PORT) return;
    keepalivePorts.add(port);
    port.onDisconnect.addListener(() => keepalivePorts.delete(port));
  });

  chrome.action.onClicked.addListener(tab => sidePanel.openForTab(tab));

  chrome.tabs.onCreated.addListener(tab => {
    scope.noteBrowserChange({
      type: "tab-created",
      tabId: tab.id,
      windowId: tab.windowId,
      openerTabId: tab.openerTabId
    });
    queueTabRegistration(() => scope.registerDescendantTab(tab)).catch(() => {});
  });

  chrome.windows.onCreated.addListener(window => {
    scope.noteBrowserChange({ type: "window-created", windowId: window.id });
  });

  chrome.tabs.onRemoved.addListener(tabId => {
    screenshots.markContextClosed(tabId);
    screencast.stop(tabId).catch(() => {});
    queueAction(() => scope.forgetTab(tabId)).catch(() => {});
    if (drafts) queueRecordingTransition(() => drafts.unbind(tabId)).catch(() => {});
  });

  chrome.windows.onRemoved.addListener(windowId => screenshots.markContextClosed(null, windowId));
  chrome.runtime.onStartup?.addListener(() => {
    if (drafts) queueRecordingTransition(() => drafts.unbind()).catch(() => {});
  });

  chrome.webNavigation.onDOMContentLoaded.addListener(async details => {
    if (!/^(https?|file):/i.test(details.url || "") || details.url.startsWith(chrome.runtime.getURL(""))) return;

    await queueTabRegistration.drain();
    if (!(await scope.isInScope(details.tabId))) return;

    if (details.frameId !== 0) {
      await injectRecordingScriptsIntoFrame(details.tabId, details.frameId).catch(error => {
        console.warn(`[Background] Subframe ${details.frameId} injection failed for tab ${details.tabId}:`, error.message);
      });
      return;
    }

    await injectRecordingScripts(details.tabId, false).catch(error => {
      console.warn(`[Background] Injection after navigation failed for tab ${details.tabId}:`, error.message);
    });
    // Re-attaching after a navigation happens for every page of a recording, so it
    // has to honour the session's capture policy too.
    const capturePlan = await readRecordingCapturePlan();
    if (!screencast.has(details.tabId)) {
      screencast.start(details.tabId, capturePlan).catch(error => {
        console.warn(`[Screencast] Failed to start after navigation in tab ${details.tabId}:`, error.message);
      });
    }
  });

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    await queueAction.drain();
    if (!(await scope.isInScope(tabId))) return;
    await injectRecordingScripts(tabId, false).catch(error => {
      console.warn(`[Background] Injection after tab activation failed for tab ${tabId}:`, error.message);
    });
  });

  chrome.windows.onFocusChanged.addListener(async windowId => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [activeTab] = await chrome.tabs.query({ active: true, windowId });
    if (!activeTab || !(await scope.isInScope(activeTab.id))) return;
    await injectRecordingScripts(activeTab.id, false).catch(error => {
      console.warn(`[Background] Injection after window focus failed for tab ${activeTab.id}:`, error.message);
    });
  });
}

export { RECORDING_KEEPALIVE_PORT };
