/**
 * Start/stop lifecycle for a recording session.
 *
 * Callers must serialize entry to `toggle` (see the recording queue in main.js):
 * a start and a stop that interleave would leave the scope half-bound and the
 * screencast attached to a tab nobody is recording.
 */
import * as actionStore from "../store/actions.js";
import { ORIGIN_KEY } from "../store/workspace-origin.js";
import { capturePlanFor, readCaptureSettings, SESSION_CAPTURE_SETTINGS_KEY } from "../../shared/capture-settings.js";
import { injectRecordingScripts } from "./injection.js";
import "../../shared/protocol.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;

export function createRecordingSession({ t, scope, cases, screencast, screenshots, drainActions }) {
  async function start(requestingTab, requestedRootTabId, recordingMode) {
    const initialTab = await scope.resolveInitialTab(requestedRootTabId, requestingTab);
    if (!initialTab) {
      return {
        success: false,
        error: t("errorNoRecordingPage", [], "未找到要录制的网页，请从目标标签页打开插件后再开始录制")
      };
    }

    const { nextPageNumber: storedNextPageNumber } = await chrome.storage.local.get("nextPageNumber");
    const existingActions = await actionStore.readActions();
    // "continue" appends to the steps already in the workspace; "restart" banks
    // them as a case first so they are not silently discarded.
    const continueHistory = existingActions.length > 0 && recordingMode === "continue";

    if (!continueHistory) {
      // Refuse to start rather than clear steps we could not bank. `autoSave`
      // returns null when there was nothing to save, so only a real failure --
      // a case store that is not writable -- stops the recording here.
      const banked = await cases.autoSave();
      if (banked && !banked.success) return banked;
      await actionStore.clearActions();
    }

    // A continued workspace already owns the handles of the pages it has steps
    // for, so its numbering resumes where it left off.
    const nextPageNumber = continueHistory ? storedNextPageNumber || 2 : 2;
    const pageName = continueHistory
      ? [...existingActions].reverse().find(action => action.pageName)?.pageName || "page1"
      : "page1";

    // Start and continue both snapshot the current preferences. Changes made
    // during recording apply only when the user starts or continues again.
    const settings = await readCaptureSettings();
    const capturePlan = capturePlanFor(settings);
    await chrome.storage.local.set({
      isRecording: true,
      [SESSION_CAPTURE_SETTINGS_KEY]: settings,
      nextPageNumber: continueHistory ? nextPageNumber : 1,
      activeCaseId: null,
      // A continued session keeps the case it was loaded from as its origin -- that
      // relationship is the whole point of continuing. Restarting discards the
      // steps, so it discards the origin with them; the steps themselves were
      // banked as their own case just above. Its scope is likewise left for the
      // resume below instead of being emptied here.
      ...(continueHistory ? {} : { tabsMapping: {}, recordingTabIds: [], [ORIGIN_KEY]: null })
    });

    try {
      // Continuing re-adopts the windows the paused session covered -- including
      // ones opened mid-recording, which no event would bring back on its own.
      const sessionTabs = continueHistory
        ? await scope.resumeTabs(initialTab, { fallbackPageName: pageName, nextPageNumber })
        : await scope.bindRootTab(initialTab, { pageName, nextPageNumber: 2 });
      // A continued session is already "on" this page; re-recording the navigation
      // would insert a duplicate lifecycle step.
      const recordNavigate = !continueHistory;

      for (const tab of sessionTabs) {
        try {
          await injectRecordingScripts(tab.id, recordNavigate);
          // Recordings that want no screenshots never attach the debugger, which
          // is what keeps their memory flat and Chrome's "debugging this browser"
          // banner off the screen.
          if (capturePlan.screenshots) await screencast.start(tab.id, capturePlan);
        } catch (error) {
          // Failing on the tab the user started from fails the session. A tab that
          // was only re-adopted is retried when it is next activated or navigates,
          // exactly like a child tab that was not ready when it opened.
          if (tab.id === initialTab.id) throw error;
          console.warn(`[Recording] Re-adopted tab ${tab.id} is not instrumented yet:`, error.message);
        }
      }
    } catch (error) {
      // Injection may have succeeded before CDP failed. Stop listeners and drain
      // their final writes as well as releasing any partially started sessions.
      try {
        await stop();
      } catch (cleanupError) {
        console.warn("[Recording] Failed-start cleanup failed:", cleanupError);
      } finally {
        await scope.clearScope();
      }
      throw error;
    }

    return { success: true };
  }

  async function stop() {
    const { recordingTabIds } = await scope.readScope();
    // In parallel: these are independent tabs, and doing them in sequence adds a
    // message round trip per tab to how long the debugging infobar stays up.
    // Rejections are ignored because a tab may already be closed.
    await Promise.all(recordingTabIds.map(tabId =>
      chrome.tabs.sendMessage(Number(tabId), { action: MESSAGE.stopRecording }).catch(() => {})
    ));

    // Order matters: let queued action writes land, then let pending screenshots
    // bind to them, and only then tear down the CDP sessions those need.
    //
    // This ordering is also why `flush` runs in a hurry. Chrome shows its
    // "started debugging this browser" infobar for as long as the screencast is
    // attached, so every millisecond spent here is a millisecond the user stares
    // at a debugging banner for a recording they already stopped.
    try {
      await drainActions();
      await screenshots.flush();
    } finally {
      try {
        await screencast.stopAll();
      } finally {
        await scope.clearScope();
      }
    }
    return { success: true };
  }

  async function toggle(shouldStart, requestingTab, requestedRootTabId, recordingMode = "restart") {
    const { isRecording } = await chrome.storage.local.get("isRecording");
    if (shouldStart === isRecording) return { success: true, unchanged: true };
    return shouldStart
      ? start(requestingTab, requestedRootTabId, recordingMode)
      : stop();
  }

  return { toggle };
}
