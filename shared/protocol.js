/**
 * Cross-context protocol shared by the Service Worker, extension pages and
 * programmatically injected content scripts.
 *
 * This file intentionally stays a plain script: chrome.scripting.executeScript
 * cannot inject an ES module. Extension-page module entry points import it for
 * its side effect, while content scripts receive it in the injection batch.
 */
(function () {
  if (globalThis.WorkflowRecorderProtocol) return;

  /** @typedef {{ action: string, [key: string]: unknown }} RuntimeMessage */

  const MESSAGE = Object.freeze({
    setSidePanelLayout: "setSidePanelLayout",
    prepareSidePanelForTab: "prepareSidePanelForTab",
    getActions: "getActions",
    getSchemaState: "getSchemaState",
    getLocaleMessages: "getLocaleMessages",
    manualScreenshot: "manualScreenshot",
    getScreenshotState: "getScreenshotState",
    toggleRecording: "toggleRecording",
    newCase: "newCase",
    clearSteps: "clearSteps",
    saveCase: "saveCase",
    loadCase: "loadCase",
    deleteCase: "deleteCase",
    deleteCases: "deleteCases",
    // Read-only: what a deletion would free, so the confirmation can say so before
    // anything has been removed.
    previewCaseDeletion: "previewCaseDeletion",
    listCases: "listCases",
    getCaseDetails: "getCaseDetails",
    importCases: "importCases",
    listCaseFolders: "listCaseFolders",
    createCaseFolder: "createCaseFolder",
    updateCaseFolder: "updateCaseFolder",
    deleteCaseFolder: "deleteCaseFolder",
    moveCasesToFolder: "moveCasesToFolder",
    deleteStep: "deleteStep",
    deleteSteps: "deleteSteps",
    cleanupScreenshots: "cleanupScreenshots",
    logAction: "logAction",
    logClickAction: "logClickAction",
    stepsUpdated: "stepsUpdated",

    pingRecorder: "pingRecorder",
    startRecording: "startRecording",
    stopRecording: "stopRecording",
    setPageFit: "setPageFit",
    waitForPageStable: "waitForPageStable",
    cancelPageStableWait: "cancelPageStableWait",
    waitForClickEffect: "waitForClickEffect",
    primeScreencastFrame: "primeScreencastFrame"
  });

  /**
   * Why a click produced no step.
   *
   * Dropping clicks is deliberate: most clicks on a page are not workflow steps,
   * and recording them all would bury the real ones. But every gate used to drop
   * them silently, so a click the user *did* mean to record left no trace at all
   * and "I clicked and nothing was recorded" had no answer anywhere. Each gate
   * now names its reason in this one vocabulary, which is what makes that
   * question answerable after the fact.
   *
   * Only some of these are decidable in the page: `noObservableEffect` needs the
   * cross-tab view and is reported by the worker.
   */
  const CLICK_SKIP_REASON = Object.freeze({
    /** The content script in this frame believes no recording is running. */
    notRecording: "not-recording",
    /** The browser marked the event as produced by page script, not by a person. */
    untrustedEvent: "untrusted-event",
    /** Nothing clickable was found, or the element carries no interaction signal. */
    meaninglessTarget: "meaningless-target",
    /** An input or editable field: typing records its committed value instead. */
    editableTarget: "editable-target",
    /** A drag just ended here, so this click is its tail rather than an intent. */
    dragSuppressed: "drag-suppressed",
    /** No DOM change, navigation or new page followed within the wait window. */
    noObservableEffect: "no-observable-effect"
  });

  /**
   * Says why an interaction produced no step.
   *
   * Debug level on purpose: a diagnostic recording is one console filter away,
   * while a normal one stays quiet despite every stray click passing through
   * here. The prefix is fixed so one filter finds every gate.
   */
  function reportClickSkipped(reason, detail = {}) {
    console.debug(`[Workflow Recorder] click not recorded: ${reason}`, detail);
  }

  globalThis.WorkflowRecorderProtocol = Object.freeze({
    MESSAGE,
    CLICK_SKIP_REASON,
    reportClickSkipped
  });
})();
