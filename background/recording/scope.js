/**
 * Recording scope: which tabs belong to the current recording, and the
 * short-lived log of browser changes used to attribute them.
 *
 * A recording is scoped to one root tab plus the recursive chain of tabs or
 * popup windows it opens. Chrome preserves openerTabId while the parent exists,
 * which is what lets grandchildren inherit the scope. Membership lives in
 * storage (`recordingTabIds`) because the Service Worker can be suspended at any
 * point; only the browser-change log is in-memory, and it is deliberately
 * disposable since it is just a 5-second correlation window.
 *
 * A stopped session leaves its tabs behind under `resumableScope` rather than
 * dropping them. Pausing and continuing is meant to come back to the same
 * windows, and a tab opened earlier in the recording has no event left that
 * would ever bring it back into scope on its own.
 */
import { readRecordingCapturePlan } from "../../shared/capture-settings.js";
import { injectRecordingScripts } from "./injection.js";
import { wait } from "../timing.js";

const CHANGE_RETENTION_MS = 5000;
const RESUMABLE_KEY = "resumableScope";

export function createRecordingScope({ screencast }) {
  const recentBrowserChanges = [];

  /** A tab is recordable when we can actually read and instrument it. */
  function isRecordableTab(tab) {
    if (!tab?.id || !tab.url) return false;
    const extensionRoot = chrome.runtime.getURL("");
    return !tab.url.startsWith(extensionRoot) && /^(https?|file):/i.test(tab.url);
  }

  function noteBrowserChange(change) {
    recentBrowserChanges.push({ time: Date.now(), ...change });
    const cutoff = Date.now() - CHANGE_RETENTION_MS;
    while (recentBrowserChanges[0]?.time < cutoff) recentBrowserChanges.shift();
  }

  /**
   * Correlates a click with a tab or window that appeared right after it.
   * Prefers a tab opened by this exact tab, then falls back to any new window,
   * because a popup opened via window.open carries no openerTabId.
   */
  function findBrowserContextChange(openerTabId, clickAt) {
    const recentChanges = recentBrowserChanges.filter(change => change.time >= clickAt - 50);
    return [...recentChanges].reverse().find(change => change.openerTabId === openerTabId)
      || [...recentChanges].reverse().find(change => change.type === "window-created")
      || null;
  }

  async function waitForBrowserContextChange(openerTabId, clickAt, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    let windowChange = null;
    while (Date.now() < deadline) {
      const change = findBrowserContextChange(openerTabId, clickAt);
      if (change?.openerTabId === openerTabId) return change;
      if (change) windowChange = change;
      if (windowChange && Date.now() - startedAt >= 160) return windowChange;
      await wait(40);
    }
    return windowChange;
  }

  async function readScope() {
    const { isRecording, recordingTabIds = [] } = await chrome.storage.local.get([
      "isRecording",
      "recordingTabIds"
    ]);
    return { isRecording: !!isRecording, recordingTabIds };
  }

  async function isInScope(tabId) {
    const { isRecording, recordingTabIds } = await readScope();
    return isRecording && recordingTabIds.includes(tabId);
  }

  /**
   * Resolves the tab a new recording should attach to. The explicitly requested
   * tab wins, then the tab that asked, then the focused tab.
   */
  async function resolveInitialTab(requestedRootTabId, requestingTab) {
    if (Number.isInteger(requestedRootTabId)) {
      try {
        const requestedTab = await chrome.tabs.get(requestedRootTabId);
        if (isRecordableTab(requestedTab)) return requestedTab;
      } catch (error) {
        console.warn("[Background] Requested root tab is no longer available:", error.message);
      }
    }

    if (isRecordableTab(requestingTab)) return requestingTab;

    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return isRecordableTab(activeTab) ? activeTab : null;
  }

  async function bindRootTab(tab, { pageName = "page1", nextPageNumber = 2 } = {}) {
    // A fresh session decides its own tabs; the paused one's are no longer a
    // candidate for a continuation, so its snapshot goes with them.
    await chrome.storage.local.remove(RESUMABLE_KEY);
    await chrome.storage.local.set({
      tabsMapping: { [tab.id]: pageName },
      recordingTabIds: [tab.id],
      nextPageNumber
    });
    return [tab];
  }

  /**
   * Ends the session in a single write. Splitting it would leave a window where
   * `isRecording` is already false while tabs are still listed as in scope.
   *
   * The released tabs are kept as the resumable snapshot instead of being
   * forgotten. An already empty scope keeps whatever snapshot is there, so the
   * cleanup that follows a failed start cannot erase the session the user
   * actually paused.
   */
  async function clearScope() {
    const { recordingTabIds = [], tabsMapping = {} } = await chrome.storage.local.get([
      "recordingTabIds",
      "tabsMapping"
    ]);
    await chrome.storage.local.set({
      isRecording: false,
      recordingTabIds: [],
      tabsMapping: {},
      ...(recordingTabIds.length > 0 ? { [RESUMABLE_KEY]: { tabIds: recordingTabIds, tabsMapping } } : {})
    });
  }

  /** The paused session's tabs that are still open and still instrumentable. */
  async function readResumableTabs() {
    const { [RESUMABLE_KEY]: snapshot } = await chrome.storage.local.get(RESUMABLE_KEY);
    const tabs = [];
    for (const tabId of snapshot?.tabIds || []) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (isRecordableTab(tab)) tabs.push(tab);
      } catch (error) {
        console.log(`[Background] Tab ${tabId} was closed while recording was paused.`);
      }
    }
    return { tabs, tabsMapping: snapshot?.tabsMapping || {} };
  }

  /**
   * Re-adopts a paused session: the requested tab plus every tab the previous
   * session covered, each with the page handle it already had.
   *
   * Handles are restored rather than reassigned because the steps still in the
   * workspace name those pages; a re-adopted tab that received a new `pageN`
   * would split one page of the workflow into two. A tab the previous session
   * never tracked keeps the requested tab's handle only while no live tab claims
   * it, and otherwise takes a fresh number -- two tabs must never share one.
   */
  async function resumeTabs(rootTab, { fallbackPageName = null, nextPageNumber = 2 } = {}) {
    const { tabs: previousTabs, tabsMapping: previousMapping } = await readResumableTabs();
    const tabs = [rootTab, ...previousTabs.filter(tab => tab.id !== rootTab.id)];

    const tabsMapping = {};
    for (const tab of tabs) {
      if (previousMapping[tab.id]) tabsMapping[tab.id] = previousMapping[tab.id];
    }

    let pageNumber = Number(nextPageNumber) || 2;
    for (const tab of tabs) {
      if (tabsMapping[tab.id]) continue;
      const reuse = tab.id === rootTab.id && fallbackPageName
        && !Object.values(tabsMapping).includes(fallbackPageName);
      tabsMapping[tab.id] = reuse ? fallbackPageName : `page${pageNumber++}`;
    }

    await chrome.storage.local.set({
      recordingTabIds: tabs.map(tab => tab.id),
      tabsMapping,
      nextPageNumber: pageNumber
    });
    console.log(`[Background] Resumed the paused recording in ${tabs.length} tab(s)`);
    return tabs;
  }

  /** Admits a tab opened by an already-tracked tab, then instruments it. */
  async function registerDescendantTab(tab) {
    if (!tab?.id || !Number.isInteger(tab.openerTabId)) return;

    const { isRecording, recordingTabIds } = await readScope();
    if (!isRecording || !recordingTabIds.includes(tab.openerTabId) || recordingTabIds.includes(tab.id)) {
      return;
    }

    await chrome.storage.local.set({ recordingTabIds: [...recordingTabIds, tab.id] });
    console.log(`[Background] Tracking child tab ${tab.id} opened by ${tab.openerTabId}`);

    if (!isRecordableTab(tab)) return;
    await injectRecordingScripts(tab.id, false).catch(error => {
      console.warn(`[Background] Child tab ${tab.id} will be retried after navigation:`, error.message);
    });
    // Share the session transport for AX; image streaming still follows the plan.
    const capturePlan = await readRecordingCapturePlan();
    screencast.start(tab.id, capturePlan).catch(error => {
      console.warn(`[Screencast] Failed to start for child tab ${tab.id}:`, error.message);
    });
  }

  /** Drops a closed tab from the scope. No-ops when it was never tracked. */
  async function forgetTab(tabId) {
    const data = await chrome.storage.local.get(["recordingTabIds", "tabsMapping"]);
    const previousIds = data.recordingTabIds || [];
    const recordingTabIds = previousIds.filter(id => id !== tabId);
    const tabsMapping = { ...(data.tabsMapping || {}) };
    const hadPageMapping = Object.hasOwn(tabsMapping, tabId);
    delete tabsMapping[tabId];

    if (recordingTabIds.length !== previousIds.length || hadPageMapping) {
      await chrome.storage.local.set({ recordingTabIds, tabsMapping });
    }
  }

  return {
    bindRootTab,
    clearScope,
    findBrowserContextChange,
    forgetTab,
    isInScope,
    isRecordableTab,
    noteBrowserChange,
    readScope,
    registerDescendantTab,
    resolveInitialTab,
    resumeTabs,
    waitForBrowserContextChange
  };
}
