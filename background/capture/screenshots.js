import * as actionStore from "../store/actions.js";
import "../../shared/protocol.js";
import {
  CAPTURE_INTENT,
  CLEARED_BY_CAPTURE,
  SCREENSHOT_ERROR_REASON,
  SCREENSHOT_STATUS,
  pendingCaptureFields
} from "./screenshot-status.js";
import { base64JpegToBlob } from "./image-processing.js";
import { beforeScreenshotKey, nextScreenshotKey } from "./screenshot-keys.js";

export { mapHighlightRect } from "./image-processing.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;

/** Screenshot scheduling backed exclusively by pushed CDP screencast frames. */

// Lets the page finish reacting to the action before we look at it.
const SETTLE_DELAY_MS = 80;
// Background tabs can suspend the animation frames needed to answer the primer.
const PRIME_TIMEOUT_MS = 400;
// How long to wait for a screencast frame when the cache is still empty.
const FRAME_TIMEOUT_MS = 800;

// While a session is being torn down (see `flush`), every millisecond the pump
// spends waiting is a millisecond Chrome keeps its "started debugging this
// browser" infobar on screen after the user already stopped recording. The
// finishing path therefore never waits: it uses the frame it already has.

export function createScreenshotManager({ t, queueAction, screencast, mediaStore, deleteScreenshots, notifyStepsUpdated }) {
  let queue = [];
  let pumpPromise = null;
  let busy = false;
  let kind = null;
  let activeJob = null;
  let manualRequestPending = false;
  let finishing = false;
  let stateWriteTail = Promise.resolve();
  let lastStateUpdatedAt = Date.now();
  // Steps this worker has taken responsibility for. Startup recovery uses it to
  // tell a step stranded by a previous worker from one this worker just queued,
  // which it cannot do from storage alone: both are simply `pending` there.
  const claimedActionIds = new Set();

  function getState() {
    return {
      busy,
      kind,
      // Which step the spinner belongs to. Without it a panel can only say "a
      // capture is running", not which node is capturing. The queued ids are
      // deliberately not published: this state is written several times per job,
      // and a growing array on that path is exactly the kind of write the step
      // store was restructured to avoid. A queued step is already `pending` on
      // its own record, so the UI derives "waiting" from that.
      activeActionId: activeJob?.actionId || null,
      pendingCount: queue.length + (activeJob ? 1 : 0)
    };
  }

  /**
   * Publishes capture progress for extension UI surfaces.
   *
   * Suppressed while finishing: panels re-read state once stop completes, so
   * these storage writes would only delay debugger detach.
   * `flush` publishes the final state itself.
   */
  async function broadcastState(nextBusy, nextKind = null) {
    busy = nextBusy;
    kind = nextBusy ? nextKind : null;
    if (finishing) return;

    lastStateUpdatedAt = Math.max(Date.now(), lastStateUpdatedAt + 1);
    const state = { ...getState(), updatedAt: lastStateUpdatedAt };
    // Enqueue broadcasts are intentionally fire-and-forget in several hot paths.
    // Serialize the actual storage writes so an older "pending" snapshot cannot
    // finish after the final idle snapshot and leave the side panel disabled.
    const write = stateWriteTail.then(() => chrome.storage.local.set({ screenshotCaptureState: state }));
    stateWriteTail = write.catch(error => {
      console.warn("[Screenshots] Failed to publish capture state:", error.message);
    });
    await write;
  }

  function ensurePump() {
    if (pumpPromise) return;
    pumpPromise = runPump().finally(() => {
      activeJob = null;
      if (busy) broadcastState(false).catch(() => {});
      pumpPromise = null;
      if (queue.length > 0) ensurePump();
    });
  }

  function interruptWaitingAutomatic() {
    if (!activeJob || activeJob.manual || busy) return null;
    activeJob.cancelled = true;
    chrome.tabs.sendMessage(activeJob.tabId, { action: MESSAGE.cancelPageStableWait }, { frameId: 0 }).catch(() => {});
    return { ...activeJob, cancelled: false };
  }

  function enqueue(job) {
    if (activeJob?.actionId === job.actionId && !activeJob.manual && !busy) {
      activeJob.cancelled = true;
      queue = queue.filter(item => item.actionId !== job.actionId);
      queue.push(job);
      chrome.tabs.sendMessage(activeJob.tabId, { action: MESSAGE.cancelPageStableWait }, { frameId: 0 }).catch(() => {});
      broadcastState(busy, kind).catch(() => {});
      return;
    }
    const existingIndex = queue.findIndex(item => !item.manual && item.actionId === job.actionId);
    if (existingIndex >= 0) queue[existingIndex] = job;
    else queue.push(job);
    broadcastState(busy, kind).catch(() => {});
  }

  function schedule(actionId, senderTab, actionType = "") {
    if (!actionId || !senderTab?.id || !senderTab.windowId) return;
    // The `pending` marker itself was written with the step; see action-log.js.
    claimedActionIds.add(actionId);
    enqueue({
      actionId,
      actionType,
      tabId: senderTab.id,
      windowId: senderTab.windowId,
      requestedAt: Date.now(),
      stabilityAttempts: 0
    });
    ensurePump();
  }

  async function handleManual(target) {
    const tabId = Number.isInteger(target) ? target : target?.id;
    const senderTab = Number.isInteger(target?.id) && target.windowId
      ? target
      : Number.isInteger(tabId)
        ? await chrome.tabs.get(tabId).catch(() => null)
        : null;
    if (!senderTab?.id || !senderTab.windowId) {
      return { success: false, error: t("errorNoCurrentPage", [], "未找到当前网页") };
    }
    if (busy) return { success: false, busy: true, error: t("errorScreenshotBusy", [], "插件正在截图") };
    if (manualRequestPending) {
      return { success: false, error: t("errorManualScreenshotPending", [], "手动截图请求处理中") };
    }
    manualRequestPending = true;
    try {
      const data = await chrome.storage.local.get(["isRecording", "tabsMapping", "recordingTabIds"]);
      if (!data.isRecording || !(data.recordingTabIds || []).includes(senderTab.id)) {
        return { success: false, error: t("errorPageNotRecording", [], "当前网页未在录制") };
      }
      const pageName = (data.tabsMapping || {})[senderTab.id];
      if (!pageName) {
        return { success: false, error: t("errorNoStepForScreenshot", [], "当前页面没有可绑定截图的步骤") };
      }
      const actions = await actionStore.readActions();
      const action = [...actions].reverse().find(item => item.pageName === pageName);
      if (!action?.id) {
        return { success: false, error: t("errorNoStepForScreenshot", [], "当前页面没有可绑定截图的步骤") };
      }

      // The only place a `pending` marker is written on its own. A manual
      // capture targets a step that already exists -- possibly one that was
      // skipped, or already has a screenshot -- so there is no step write to
      // fold it into. The existing `screenshotKey` stays: the node keeps showing
      // the previous screenshot while the new one is taken, and keeps it if the
      // re-capture fails.
      await queueAction(() => actionStore.patchAction(
        action.id,
        pendingCaptureFields(CAPTURE_INTENT.manual)
      ));
      claimedActionIds.add(action.id);
      notifyStepsUpdated();

      const interrupted = interruptWaitingAutomatic();
      queue = queue.filter(item => item.actionId !== action.id);
      queue.unshift({
        actionId: action.id,
        actionType: action.type,
        tabId: senderTab.id,
        windowId: senderTab.windowId,
        requestedAt: Date.now(),
        stabilityAttempts: 0,
        manual: true
      });
      if (interrupted && interrupted.actionId !== action.id) queue.splice(1, 0, interrupted);
      broadcastState(busy, kind).catch(() => {});
      ensurePump();
      return { success: true, actionId: action.id, replacedAutomatic: !!activeJob };
    } finally {
      manualRequestPending = false;
    }
  }

  function markContextClosed(tabId, windowId = null) {
    const matches = job => job && (
      job.tabId === tabId ||
      (Number.isInteger(windowId) && job.windowId === windowId)
    );
    queue.forEach(job => {
      if (!matches(job)) return;
      job.originClosed = true;
      job.skipStability = true;
    });
    if (!matches(activeJob) || activeJob.originClosed) return;
    activeJob.originClosed = true;
    if (!activeJob.manual && !busy) {
      activeJob.cancelled = true;
      queue.unshift({ ...activeJob, cancelled: false, originClosed: true, skipStability: true });
      chrome.tabs.sendMessage(activeJob.tabId, { action: MESSAGE.cancelPageStableWait }, { frameId: 0 }).catch(() => {});
    }
    broadcastState(busy, kind).catch(() => {});
  }

  async function runPump() {
    await drainQueue();
  }

  async function drainQueue() {
    while (queue.length > 0) {
      const job = queue.shift();
      activeJob = job;
      await broadcastState(busy, kind);
      if (!job.manual && !finishing) await new Promise(resolve => setTimeout(resolve, SETTLE_DELAY_MS));
      if (job.cancelled) {
        activeJob = null;
        await broadcastState(busy, kind);
        continue;
      }

      // Skipped while finishing: a job still queued at that point has already
      // been waiting, and the user spent further time reaching for the stop
      // button, so the page has had its settle time. Asking for more only delays
      // the debugger detach.
      if (!job.manual && !job.skipStability && !finishing) {
        try {
          const hasBacklog = queue.length > 0;
          const isNavigation = job.actionType === "navigate" || job.actionType === "newPage";
          const isInput = job.actionType === "type";
          const stability = await chrome.tabs.sendMessage(
            job.tabId,
            {
              action: MESSAGE.waitForPageStable,
              options: hasBacklog
                ? { timeoutMs: 700, quietMs: 180 }
                : isNavigation
                  ? { timeoutMs: 2500, quietMs: 280 }
                  : isInput
                    ? { timeoutMs: 900, quietMs: 220 }
                    : { timeoutMs: 1500, quietMs: 280 }
            },
            { frameId: 0 }
          );
          if (
            !stability?.stable &&
            stability?.loadingIndicatorVisible &&
            job.stabilityAttempts < 1 &&
            queue.length === 0
          ) {
            queue.unshift({ ...job, cancelled: false, stabilityAttempts: job.stabilityAttempts + 1 });
            continue;
          }
        } catch (error) {
          console.warn("[Screenshots] Page stability check unavailable:", error.message);
        }
      }
      if (job.cancelled) continue;

      try {
        if (!screencast.has(job.tabId)) {
          throw new Error(t("errorNoCapturePage", [], "没有可用于截图的录制页面"));
        }

        await broadcastState(true, job.manual ? "manual" : "auto");
        let frame;
        try {
          if (finishing) {
            // And never block while finishing. A screencast only pushes on paint,
            // so a tab with no cached frame is backgrounded or was never painted
            // and will not produce one just because we wait on it -- that wait
            // would be spent holding the debugging infobar up, per pending step.
            frame = screencast.getLatestFrame(job.tabId);
            if (!frame) throw new Error(t("errorNoCapturePage", [], "没有可用于截图的录制页面"));
          } else {
            let afterAt = 0;
            // A screencast only pushes on paint, so a settled page emits nothing
            // and there may be no frame at all to read. Ask the page for one
            // deliberate repaint instead of waiting out the timeout and losing the
            // step's screenshot. Manual capture always primes a fresh frame because
            // it means "what the page looks like now", not the latest cached paint.
            if (job.manual || !screencast.getLatestFrame(job.tabId)) {
              afterAt = Date.now();
              let timer;
              try {
                await Promise.race([
                  chrome.tabs.sendMessage(
                    job.tabId,
                    { action: MESSAGE.primeScreencastFrame },
                    { frameId: 0 }
                  ).catch(() => {}),
                  new Promise(resolve => { timer = setTimeout(resolve, PRIME_TIMEOUT_MS); })
                ]);
              } finally {
                clearTimeout(timer);
              }
            }

            try {
              frame = await screencast.getFrame(job.tabId, afterAt, FRAME_TIMEOUT_MS);
            } catch (error) {
              frame = screencast.getLatestFrame(job.tabId);
              if (!frame) throw error;
            }
          }
          await persist(job, base64JpegToBlob(frame.data), job.manual ? "manual" : "automatic");
        } finally {
          await broadcastState(false);
        }
      } catch (error) {
        console.warn("[Screenshots] Step screenshot skipped:", error.message);
        if (busy) await broadcastState(false).catch(() => {});
        const attempts = job.captureAttempts || 0;
        // No re-queueing while finishing: a retry would hold the CDP session open
        // for another round trip, and the step is marked unavailable instead.
        // Manual jobs are never retried either: the user asked for the page as it
        // is now, and quietly capturing it a second later is not that.
        if (!job.manual && !job.originClosed && !finishing && attempts < 2) {
          queue.push({ ...job, cancelled: false, captureAttempts: attempts + 1, skipStability: true });
        } else {
          // Manual jobs also persist their failure on the step, otherwise its card
          // would remain waiting for a capture forever.
          //
          // A closed tab/window is the one cause worth naming: the generic
          // "no capture page" message is what a closed origin actually throws, but
          // "the page was closed" is what the user can act on.
          const message = job.originClosed
            ? t("errorScreenshotPageClosed", [], "录制页面已关闭，未能截图")
            : error.message;
          await markUnavailable(job, {
            reason: job.originClosed ? SCREENSHOT_ERROR_REASON.pageClosed : SCREENSHOT_ERROR_REASON.captureFailed,
            message
          });
        }
      } finally {
        if (activeJob === job) activeJob = null;
        await broadcastState(busy, kind).catch(() => {});
      }
    }
  }

  /**
   * Stores the frame and binds it to its step.
   *
   * Ordered so no state is ever wrong rather than merely stale: the blob is
   * written under a fresh key first, the step is pointed at it second, and only
   * then is the key it replaced offered for collection. The collection is
   * reference-aware, so a previous key that a saved case still uses survives --
   * that is what stops a re-capture in the workspace from blanking the screenshot
   * of the case those steps came from.
   */
  async function persist(job, blob, source) {
    const write = () => publish(job, blob, source);
    const { screenshotKey, previous } = await (mediaStore.withWriteLock
      ? mediaStore.withWriteLock(write)
      : write());
    if (!previous) {
      await deleteScreenshots([screenshotKey]);
      return;
    }
    notifyStepsUpdated();
    if (previous.screenshotKey && previous.screenshotKey !== screenshotKey) {
      await deleteScreenshots([previous.screenshotKey]);
    }
  }

  async function publish(job, blob, source) {
    const screenshotKey = nextScreenshotKey(job.actionId);
    await mediaStore.putBlob(screenshotKey, blob);

    // Only the patch is serialized. Reclaiming the replaced key needs the patch to
    // have landed, but it is a read of every step plus the saved-case media lists,
    // and doing that while holding the action queue delays everything waiting on it
    // -- including the injection a freshly opened tab needs before its first click
    // can be recorded.
    //
    // Patches one action record. This used to rewrite the whole step list, which is
    // what made a recording session's writes grow quadratically.
    const previous = await queueAction(() => actionStore.patchAction(
      job.actionId,
      {
        screenshotKey,
        screenshotStatus: SCREENSHOT_STATUS.captured,
        screenshotCapturedAt: Date.now(),
        screenshotSource: source,
        screenshotCapturedTabId: job.tabId
      },
      { remove: CLEARED_BY_CAPTURE }
    ));

    return { screenshotKey, previous };
  }

  /**
   * Records that a step's capture failed for good.
   *
   * Any existing `screenshotKey` is left alone: a failed re-capture should keep
   * showing the screenshot it has rather than replace it with an error.
   */
  async function markUnavailable(job, { reason, message } = {}) {
    await queueAction(async () => {
      const marked = await actionStore.patchAction(job.actionId, {
        screenshotStatus: SCREENSHOT_STATUS.failed,
        screenshotError: message || t("errorStepScreenshotUnavailable", [], "步骤截图不可用"),
        screenshotErrorReason: reason || SCREENSHOT_ERROR_REASON.captureFailed,
        screenshotAttemptedAt: Date.now()
      });
      if (marked) notifyStepsUpdated();
    });
  }

  /**
   * Resolves steps left `pending` by a worker that no longer exists.
   *
   * A Manifest V3 worker can be terminated at any point, and the queue and the
   * CDP screencast sessions it was holding go with it. Those steps therefore have
   * no capture coming and cannot be retried honestly: the page has moved on, and
   * binding whatever it looks like now to an older step would be worse than
   * having no screenshot. They are failed explicitly instead, which is the one
   * outcome the panel can explain, and the user can re-capture manually.
   *
   * Steps this worker has already claimed are skipped, so a capture queued while
   * this recovery was reading storage is not failed out from under itself.
   */
  async function recoverInterruptedJobs() {
    // Nothing can be in flight this early in a worker's life. The guard is here so
    // that a later caller cannot make the pump publish "idle" mid-capture, which
    // would drop the spinner off whichever node is actually capturing.
    if (!activeJob && queue.length === 0) await broadcastState(false);

    const actions = await actionStore.readActions();
    const stranded = actions.filter(action =>
      action?.screenshotStatus === SCREENSHOT_STATUS.pending && !claimedActionIds.has(action.id)
    );
    if (stranded.length === 0) return 0;

    const message = t("errorScreenshotInterrupted", [], "截图任务因后台重启中断");
    await queueAction(async () => {
      for (const action of stranded) {
        if (claimedActionIds.has(action.id)) continue;
        await actionStore.patchAction(action.id, {
          screenshotStatus: SCREENSHOT_STATUS.failed,
          screenshotError: message,
          screenshotErrorReason: SCREENSHOT_ERROR_REASON.workerRestart,
          screenshotAttemptedAt: Date.now()
        });
      }
    });
    notifyStepsUpdated();
    return stranded.length;
  }

  /**
   * Drains the queue at the end of a recording session.
   *
   * This runs while the CDP screencast is still attached, because the jobs need
   * frames from it, which means Chrome is still showing its debugging infobar on
   * every recorded tab. The `finishing` flag therefore switches the pump to
   * bounded waits: pending steps still get a screenshot, but the session tears
   * down in a few hundred milliseconds instead of several seconds.
   */
  async function flush() {
    finishing = true;
    // A job that was already in flight when the user pressed stop is sitting in
    // its normal-path stability wait, up to 2.5s for a navigation. The `finishing`
    // checks cannot help it -- it is already past them -- so cut that wait off at
    // the source. It still gets a screenshot, just from the frame we already have.
    if (activeJob && !activeJob.manual) {
      chrome.tabs.sendMessage(
        activeJob.tabId,
        { action: MESSAGE.cancelPageStableWait },
        { frameId: 0 }
      ).catch(() => {});
    }
    try {
      while (pumpPromise || queue.length > 0) {
        ensurePump();
        if (pumpPromise) await pumpPromise;
      }
    } finally {
      // Cleared first so the closing broadcast is actually published: the panel
      // would otherwise keep showing whatever "capturing" state it last saw.
      finishing = false;
      await broadcastState(false).catch(() => {});
    }
  }

  /**
   * The page's current frame straight from the live cache. Keep its metadata with
   * the base64 bytes so future coordinate conversions need not change this API.
   *
   * Synchronous on purpose: the caller grabs this the instant an action is
   * reported, before any navigation or tab close can clear the cache. Once it has
   * the string, the frame survives the page going away.
   */
  function snapshotFrameData(tabId) {
    const frame = screencast.getLatestFrame(tabId);
    if (!frame?.data) return null;
    return {
      at: frame.at,
      data: frame.data,
      metadata: frame.metadata || null
    };
  }

  function beforeKeyFor(actionId) {
    return beforeScreenshotKey(actionId);
  }

  /**
   * Writes a captured frame under a key. Used for the before-frame; failure is
   * non-fatal (the step just shows no before-image). The caller awaits this before
   * publishing the key, so the UI can never observe a reference to a blob that is
   * merely still on its way to IndexedDB.
   */
  async function storeFrameBlob(key, frameData, highlightBox = null) {
    if (!key || !frameData) return null;
    try {
      // Accept the former raw-string shape as well so interrupted/older callers
      // degrade gracefully across an extension service-worker update.
      const data = typeof frameData === "string" ? frameData : frameData.data;
      if (!data) return null;
      const cleanBlob = base64JpegToBlob(data);
      // Keep the original JPEG. Target geometry travels on the action; painting
      // belongs to previews and document export, never the recording hot path.
      await mediaStore.putBlob(key, cleanBlob);
      return key;
    } catch (error) {
      console.warn("[Screenshots] Failed to store before-frame:", error.message);
      return null;
    }
  }

  return {
    beforeKeyFor,
    flush,
    getState,
    handleManual,
    markContextClosed,
    recoverInterruptedJobs,
    schedule,
    snapshotFrameData,
    storeFrameBlob
  };
}
