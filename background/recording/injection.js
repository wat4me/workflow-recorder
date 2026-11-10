/**
 * Content script injection.
 *
 * Nothing is declared in manifest.content_scripts on purpose: pages are only
 * instrumented after the user explicitly invokes the extension, so injection is
 * always programmatic.
 */
import { wait } from "../timing.js";
import "../../shared/protocol.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;
let recordingEnabled = true;
let recordingGeneration = 0;

export function beginRecordingInjection() {
  recordingEnabled = true;
  recordingGeneration++;
}

export function stopRecordingInjection() {
  recordingEnabled = false;
  recordingGeneration++;
}

/**
 * Injected in order, one executeScript call per batch. The analyzer goes in
 * first and alone because the recorder reads it synchronously the moment its
 * own listeners fire.
 *
 * scripts/package.js parses this list and fails the build if any entry is not
 * packaged, so a moved file breaks `npm run package` instead of breaking
 * silently at record time.
 */
export const INJECTION_BATCHES = [
  ["content/analyzer.js"],
  [
    "shared/protocol.js",
    "content/click-effects.js",
    "content/stability.js",
    "content/page-fit.js",
    "content/screencast-frame-primer.js",
    "content/targeting.js",
    "content/drag-recorder.js",
    "content/input-recorder.js",
    "content/main.js"
  ]
];

/** Side-panel layout must not instrument every iframe before recording starts. */
export async function ensurePageFitScript(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ["shared/protocol.js", "content/page-fit.js"]
  });
}

export async function injectRecordingScripts(tabId, recordNavigate = false, maxAttempts = 5) {
  const generation = recordingGeneration;
  const isCurrent = () => recordingEnabled && generation === recordingGeneration;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) await wait(100 * attempt);
      if (!isCurrent()) return false;
      let frames = [];
      for (const files of INJECTION_BATCHES) {
        frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files });
      }
      if (!isCurrent()) return false;
      // A popup can navigate between ping and start. Target the document we
      // injected and retry the full handshake if that document disappears.
      const topFrame = frames?.find(frame => frame.frameId === 0);
      const topTarget = frameTarget(topFrame || { frameId: 0 });
      await chrome.tabs.sendMessage(tabId, { action: MESSAGE.pingRecorder }, topTarget);
      if (!isCurrent()) return false;
      const start = { action: MESSAGE.startRecording, recordNavigate };
      await chrome.tabs.sendMessage(tabId, start, topTarget);
      if (!isCurrent()) return false;
      // A departing iframe cannot invalidate the top page. New frame
      // documents are picked up by webNavigation's frame injection.
      await Promise.allSettled((frames || []).filter(frame => frame.frameId !== 0)
        .map(frame => chrome.tabs.sendMessage(tabId, start, frameTarget(frame))));
      console.log(`[Background] Recording started in tab ${tabId}`);
      return true;
    } catch (error) {
      lastError = error;
      console.warn(`[Background] Injection attempt ${attempt}/${maxAttempts} failed for tab ${tabId}:`, error.message);
    }
  }
  throw lastError || new Error(`Unable to inject recording scripts into tab ${tabId}`);
}

function frameTarget(frame) {
  return frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId };
}

/**
 * Instruments a single subframe that loaded its own document.
 *
 * The tab-level injection uses `allFrames`, so a frame that already existed when
 * the top page loaded is covered. This is for the frame that loads or reloads on
 * its own afterwards -- an iframe whose src is set late, or a form rendered inside
 * an iframe -- where the recorder would otherwise be absent and typing there would
 * reach nothing.
 *
 * Never records a navigation: a subframe is page content, not a page the user
 * opened, so `recordNavigate` is false. Re-running is safe: the content script's
 * injection guard makes a second `executeScript` a no-op, and `startRecording`
 * only re-attaches listeners, which dedupe because they are stable references.
 */
export async function injectRecordingScriptsIntoFrame(tabId, frameId, maxAttempts = 3) {
  const generation = recordingGeneration;
  if (!recordingEnabled) return false;
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt > 1) await wait(100 * attempt);
      for (const files of INJECTION_BATCHES) {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files });
      }
      if (!recordingEnabled || generation !== recordingGeneration) return false;
      await chrome.tabs.sendMessage(
        tabId,
        { action: MESSAGE.startRecording, recordNavigate: false },
        { frameId }
      );
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error(`Unable to inject into frame ${frameId} of tab ${tabId}`);
}
