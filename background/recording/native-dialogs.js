import { SCREENSHOT_SKIPPED_REASON } from "../capture/screenshot-status.js";

const DIALOG_TYPES = new Set(["alert", "confirm", "prompt", "beforeunload"]);

/** Records JavaScript dialogs on attached tabs without interacting with them. */
export function createNativeDialogRecorder({ screencast, scope, queueAction, actionLog, notifyStepsUpdated }) {
  const openDialogs = new Map();
  const stopWaiters = new Map();

  function enqueue(write) {
    queueAction(write).catch(error => console.warn("[Native dialog] Step write failed:", error.message));
  }

  chrome.debugger.onEvent.addListener(({ tabId }, method, params) => {
    if (method === "Page.javascriptDialogOpening" && screencast.has(tabId) && DIALOG_TYPES.has(params.type)) {
      const dialog = {
        id: `dialog_${crypto.randomUUID()}`,
        type: "browserDialog",
        timestamp: Date.now(),
        url: params.url,
        dialogType: params.type,
        dialogMessage: params.message,
        screenshotSkippedReason: SCREENSHOT_SKIPPED_REASON.browserDialog
      };
      openDialogs.set(tabId, dialog);
      scope.noteBrowserChange({ type: "javascript-dialog", tabId, time: dialog.timestamp, actionId: dialog.id });
      enqueue(async () => {
        await actionLog.log(dialog, { id: tabId, url: dialog.url });
        notifyStepsUpdated();
      });
      stopWaiters.get(tabId)?.();
    } else if (method === "Page.javascriptDialogClosed") {
      const dialog = openDialogs.get(tabId);
      if (!dialog) return;
      openDialogs.delete(tabId);
      const result = params.result ? "accepted" : "dismissed";
      const input = dialog.dialogType === "prompt" && params.result ? params.userInput : undefined;
      enqueue(() => actionLog.setDialogResult(dialog.id, result, input));
    }
  });
  chrome.debugger.onDetach.addListener(({ tabId }) => openDialogs.delete(tabId));

  // The renderer cannot reply to content-script messages while a dialog holds
  // it. Let stop proceed to debugger detach if the tab is already blocked or
  // a dialog opens while we wait for the frames.
  async function stopUntilDialogOpens(tabId, stopPage) {
    if (openDialogs.has(tabId)) return;
    const dialogOpened = new Promise(resolve => stopWaiters.set(tabId, resolve));
    try {
      await Promise.race([dialogOpened, stopPage()]);
    } finally {
      stopWaiters.delete(tabId);
    }
  }

  return { stopUntilDialogOpens };
}
