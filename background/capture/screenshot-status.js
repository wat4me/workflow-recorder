/**
 * Per-step capture state, persisted on the action itself.
 *
 * The capture queue lives in the Service Worker's memory, so it is not something
 * the UI can be shown or that survives the worker being terminated. These four
 * values are the part that has to be durable: without them a step whose capture
 * was interrupted is indistinguishable from a step that was never going to get a
 * screenshot, and it would sit in "waiting" forever.
 *
 * The richer set of node states the UI renders is derived from these plus the
 * presence of `screenshotKey` -- "captured, re-capture in progress" is
 * `pending` with a key, "re-capture failed" is `failed` with a key. Deriving
 * rather than storing them keeps the states that can disagree down to zero.
 */
export const SCREENSHOT_STATUS = {
  pending: "pending",
  captured: "captured",
  skipped: "skipped",
  failed: "failed"
};

export const CAPTURE_INTENT = {
  automatic: "automatic",
  manual: "manual"
};

/**
 * Why a step was never going to get a screenshot.
 *
 * A stable code rather than a message: the step stores the code and the UI turns
 * it into wording at render time, so the reason survives a language switch.
 */
export const SCREENSHOT_SKIPPED_REASON = {
  /** The click opened a child page, which is captured on its own first frame. */
  opensChildPage: "opens-child-page",
  /** The recording was started with screenshots turned off. */
  captureDisabled: "capture-disabled"
};

/**
 * Why a screenshot ended up unavailable, as a stable code rather than a message.
 *
 * The code is what the step stores; the UI turns it into wording at render time,
 * so the reason stays correct after a language switch and there is one place that
 * decides how each cause reads. `screenshotError` still holds the underlying
 * message for the tooltip and for causes that have no dedicated code.
 */
export const SCREENSHOT_ERROR_REASON = {
  /** The recorded tab or window was closed before the frame could be taken. */
  pageClosed: "pageClosed",
  /** The worker was terminated mid-capture; the queue and CDP session went with it. */
  workerRestart: "workerRestart",
  /** Anything else: no frame was produced in time, the page never painted, etc. */
  captureFailed: "captureFailed"
};

/**
 * Fields marking a step as awaiting capture.
 *
 * Folded into the write that creates or changes the step rather than patched
 * separately: a recording session's storage writes were deliberately reduced to
 * one per step, and a second write per capture would give that back.
 */
export function pendingCaptureFields(intent = CAPTURE_INTENT.automatic) {
  return {
    screenshotStatus: SCREENSHOT_STATUS.pending,
    screenshotRequestedAt: Date.now(),
    screenshotIntent: intent
  };
}

export function skippedCaptureFields(reason) {
  return {
    screenshotStatus: SCREENSHOT_STATUS.skipped,
    screenshotSkippedReason: reason
  };
}

/**
 * Fields a successful capture must drop.
 *
 * A step can be re-captured after failing, or after having been skipped, so
 * leaving these behind would keep it rendering as failed or as needing no
 * screenshot while it is in fact showing one.
 */
export const CLEARED_BY_CAPTURE = [
  "screenshotError",
  "screenshotAttemptedAt",
  "screenshotSkippedReason"
];
