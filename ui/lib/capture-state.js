/**
 * Which capture state a step card should show.
 *
 * The worker persists four values on the step -- pending, captured, skipped,
 * failed -- plus one "which step is capturing right now" pointer in the shared
 * capture state. The eight states a card can be in are derived from those two
 * and whether the step currently has a screenshot, rather than stored, so there
 * is no second copy of the truth that can disagree with the first.
 *
 * Two precedence rules carry most of the weight:
 *
 *   A step that has a screenshot is never "unavailable". It may be re-capturing
 *   or have failed a re-capture, and in both cases the image it already has stays
 *   on screen. Reading the error flag first would blank a card that has a
 *   perfectly good screenshot, which is what happened before capture state was
 *   persisted at all.
 *
 *   "Waiting" and "capturing" are different states. The queue can hold a step for
 *   a while before it reaches the front, and a spinner that starts the moment a
 *   step is recorded says nothing about progress.
 */
(function () {
  if (globalThis.RecorderCaptureState) return;

  /**
   * The worker's code for "this recording had screenshots turned off". Declared
   * here because three views need it -- the step cards, their media slots and the
   * relationship canvas -- and they have to agree on the spelling.
   * See SCREENSHOT_SKIPPED_REASON in background/capture/screenshot-status.js.
   */
  const CAPTURE_DISABLED_REASON = "capture-disabled";

  /**
   * @param action  a stored step
   * @param capture the shared `screenshotCaptureState`: { busy, kind, activeActionId }
   * @returns one of the state names above, or "" for a step recorded before
   *          capture state was persisted -- saying nothing is more honest than
   *          guessing, and matches how those steps have always rendered.
   */
  function resolve(action, capture = {}) {
    if (!action) return "";
    const status = action.screenshotStatus;
    const isCapturing = !!capture.busy && capture.activeActionId === action.id;

    if (action.screenshotKey) {
      if (status === "pending") return isCapturing ? "recapturing" : "pending";
      if (status === "failed") return "recapture-failed";
      return "captured";
    }
    if (status === "skipped" || action.screenshotSkippedReason) return "skipped";
    if (status === "failed" || action.screenshotError) return "failed";
    if (status === "pending") {
      if (!isCapturing) return "pending";
      return capture.kind === "manual" ? "capturing-manual" : "capturing-auto";
    }
    return "";
  }

  globalThis.RecorderCaptureState = { CAPTURE_DISABLED_REASON, resolve };
})();
