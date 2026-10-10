/**
 * How much work a recording does for step screenshots.
 *
 * The only thing left to choose is whether to capture at all. Sharpness presets
 * used to live here, and measurement is what removed them: run three times each,
 * the high and medium presets came out 3% apart -- less than the 300 MB spread of
 * a single preset measured against itself -- and not by the ratio their pixel
 * counts predict. What they did trade reliably was stored file size, which is not
 * worth a setting a user would reasonably pick expecting to save memory.
 *
 * The measurement did show where the cost actually is. It follows the number of
 * steps (roughly 15-20 MB each, mostly the decode-and-canvas work of drawing the
 * target highlight and re-encoding), not the size of a frame, and not how long a
 * recording runs: a real portal recorded idle for 25 seconds cost 12 MB, while
 * forty steps on a form cost 887 MB. Turning screenshots off is the whole
 * decision, which is why it is the only control the settings dialog offers.
 *
 * Frames are therefore always taken at the tab's native viewport resolution.
 */

export const CAPTURE_SETTINGS_KEY = "captureSettings";
export const SESSION_CAPTURE_SETTINGS_KEY = "recordingCaptureSettings";

export const DEFAULT_CAPTURE_SETTINGS = { screenshots: true };

/**
 * Frames the screencast is allowed to deliver. Higher means fewer frames: the
 * before-frame of an action is at most one step staler, which is tens of
 * milliseconds, and it costs proportionally less CPU and CDP traffic. Measured
 * memory is flat across 2/4/6, so this is deliberately not a user-facing choice.
 */
export const CAPTURE_FRAME_STRIDE = 4;

export function normalizeCaptureSettings(raw) {
  const settings = raw && typeof raw === "object" ? raw : {};
  // A `quality` field written by an earlier build is dropped rather than carried
  // forward: there is nothing left for it to mean. Only an explicit `false`
  // disables capture, so a missing or corrupt record keeps the feature the user
  // already had.
  return { screenshots: settings.screenshots !== false };
}

/**
 * What the capture pipeline should do for a session.
 *
 * `screenshots: false` means no CDP attach at all rather than "capture and throw
 * the frames away": the screencast stream is the entire cost of the feature, so
 * a session that does not want screenshots must not open one. That is also what
 * removes Chrome's "debugging this browser" banner from recordings that do not
 * use it.
 */
export function capturePlanFor(raw) {
  return {
    screenshots: normalizeCaptureSettings(raw).screenshots,
    frameStride: CAPTURE_FRAME_STRIDE
  };
}

export async function readCaptureSettings() {
  const stored = await chrome.storage.local.get(CAPTURE_SETTINGS_KEY);
  return normalizeCaptureSettings(stored[CAPTURE_SETTINGS_KEY]);
}

export function recordingCapturePlanFor(stored) {
  return capturePlanFor(stored.isRecording && stored[SESSION_CAPTURE_SETTINGS_KEY]
    ? stored[SESSION_CAPTURE_SETTINGS_KEY]
    : stored[CAPTURE_SETTINGS_KEY]);
}

export async function readRecordingCapturePlan() {
  return recordingCapturePlanFor(await chrome.storage.local.get([
    "isRecording", SESSION_CAPTURE_SETTINGS_KEY, CAPTURE_SETTINGS_KEY
  ]));
}

export async function writeCaptureSettings(settings) {
  const normalized = normalizeCaptureSettings(settings);
  await chrome.storage.local.set({ [CAPTURE_SETTINGS_KEY]: normalized });
  return normalized;
}

// The UI's plain scripts read this the way they read protocol.js: one global
// rather than a second import path for the same values.
globalThis.RecorderCaptureSettings = {
  CAPTURE_SETTINGS_KEY,
  SESSION_CAPTURE_SETTINGS_KEY,
  DEFAULT_CAPTURE_SETTINGS,
  capturePlanFor,
  normalizeCaptureSettings,
  readCaptureSettings,
  recordingCapturePlanFor,
  readRecordingCapturePlan,
  writeCaptureSettings
};
