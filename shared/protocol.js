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
    getDraftState: "getDraftState",
    selectDraft: "selectDraft",
    getSchemaState: "getSchemaState",
    getLocaleMessages: "getLocaleMessages",
    manualScreenshot: "manualScreenshot",
    getScreenshotState: "getScreenshotState",
    toggleRecording: "toggleRecording",
    newCase: "newCase",
    clearSteps: "clearSteps",
    saveCase: "saveCase",
    loadCase: "loadCase",
    renameCase: "renameCase",
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
    recordingDebugEvent: "recordingDebugEvent",
    exportRecordingDebug: "exportRecordingDebug",
    clearRecordingDebug: "clearRecordingDebug",
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
    /** No element was hit, or the target is a body/html page root. */
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
    recordingDebug("click-skipped", { reason, ...detail });
  }

  // Temporary diagnostics for the unreleased build. One switch removes the
  // instrumentation and its settings controls when this investigation is over.
  const RECORDING_DEBUG_ENABLED = false;
  let debugSink = null;
  const debugDocumentId = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  function debugElement(element) {
    if (!element) return null;
    const tag = element.tagName?.toLowerCase() || (element.nodeType === 3 ? "#text" : "node");
    const id = element.id ? `#${element.id}` : "";
    const classes = Array.from(element.classList || []).slice(0, 3).map(name => `.${name}`).join("");
    return `${tag}${id}${classes}`.slice(0, 180);
  }

  function debugViewport() {
    const root = globalThis.document?.documentElement;
    return {
      width: globalThis.innerWidth, height: globalThis.innerHeight,
      clientWidth: root?.clientWidth, clientHeight: root?.clientHeight,
      scrollWidth: root?.scrollWidth, zoom: root?.style?.getPropertyValue?.("zoom") || "",
      visualWidth: globalThis.visualViewport?.width, visualHeight: globalThis.visualViewport?.height
    };
  }

  function recordingDebug(event, detail = {}) {
    if (!RECORDING_DEBUG_ENABLED) return;
    const entry = { event, at: Date.now(), document: debugDocumentId, detail: { ...detail } };
    // Exclude URL parameters and fragments; never read input values or DOM text.
    try {
      const url = new URL(globalThis.location?.href);
      entry.page = `${url.origin}${url.pathname}`;
    } catch { /* A worker or test may not have a document URL. */ }
    if (entry.detail.url) {
      try {
        const url = new URL(entry.detail.url);
        entry.detail.url = `${url.origin}${url.pathname}`;
      } catch { delete entry.detail.url; }
    }
    try {
      if (debugSink) Promise.resolve(debugSink(entry)).catch(() => {});
      else if (globalThis.chrome?.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ action: MESSAGE.recordingDebugEvent, entry }, () => {
          void chrome.runtime.lastError;
        });
      }
    } catch { /* Diagnostics must never interrupt recording or page teardown. */ }
  }

  globalThis.WorkflowRecorderProtocol = Object.freeze({
    MESSAGE,
    CLICK_SKIP_REASON,
    reportClickSkipped,
    RECORDING_DEBUG_ENABLED,
    recordingDebug,
    debugElement,
    debugViewport,
    setRecordingDebugSink: sink => { debugSink = sink; }
  });
})();
