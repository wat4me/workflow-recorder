/**
 * Turning raw content-script reports into stored steps.
 *
 * Three things happen here that the content script cannot decide on its own,
 * because each needs the cross-tab view the worker has:
 *   - page handles (`page1`, `page2`, ...) without turning later browser
 *     navigations into workflow steps
 *   - collapsing a run of keystrokes on one element into a single `type` step
 *   - deciding whether a click actually did anything worth recording
 */
import { pendingCaptureFields, skippedCaptureFields, SCREENSHOT_SKIPPED_REASON } from "../capture/screenshot-status.js";
import { CAPTURE_SETTINGS_KEY, SESSION_CAPTURE_SETTINGS_KEY, recordingCapturePlanFor } from "../../shared/capture-settings.js";
import * as actionStore from "../store/actions.js";
import { wait } from "../timing.js";
import { isInheritedStep, readOrigin } from "../store/workspace-origin.js";
import "../../shared/protocol.js";

const CLICK_EFFECT_TIMEOUT_MS = 1200;
const { MESSAGE, CLICK_SKIP_REASON, reportClickSkipped } = globalThis.WorkflowRecorderProtocol;

export function createActionLog({ t, scope, screenshots, mediaCleanup, notifyStepsUpdated }) {
  function generateActionId() {
    return `step_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * Assigns the page handle for a tab, creating one if it has not reported before.
   */
  async function resolvePageName(senderTab, tabsMapping, nextPageNumber) {
    const existing = tabsMapping[senderTab.id];
    if (existing) return existing;

    const pageName = `page${nextPageNumber}`;
    tabsMapping[senderTab.id] = pageName;
    await chrome.storage.local.set({ tabsMapping, nextPageNumber: nextPageNumber + 1 });
    console.log(`[Background] Assigned pageName "${pageName}" to tab ${senderTab.id}`);

    return pageName;
  }

  /**
   * Folds a `type` payload into the preceding step when it targets the same
   * element, so a typed word is one step instead of one step per keystroke.
   * Returns true when it was absorbed.
   */
  async function mergeIntoPrecedingType(payload, senderTab) {
    const order = await actionStore.readOrder();
    const lastAction = order.length > 0 ? await actionStore.readAction(order[order.length - 1]) : null;
    const sameTarget = lastAction?.type === "type"
      && lastAction.pageName === payload.pageName
      && lastAction.target
      && payload.target
      && lastAction.target.domPath === payload.target.domPath;
    if (!sameTarget) return false;

    const willCapture = !lastAction.screenshotSkippedReason;
    // The re-capture marker rides along with the value change rather than being
    // a second write. The step keeps whatever screenshot it already had until the
    // new one binds, so the card shows the old image with a progress state on it
    // instead of blanking while the user is still typing.
    const changes = {
      value: payload.value,
      timestamp: payload.timestamp,
      ...(willCapture ? pendingCaptureFields() : {})
    };

    const targetId = await applyStepChange(lastAction, changes);
    await chrome.storage.local.set({ activeCaseId: null });
    if (willCapture) screenshots.schedule(targetId, senderTab, lastAction.type);
    return true;
  }

  /**
   * Applies a semantic change to an existing step, copying it first if it is
   * still shared with the case it was loaded from.
   *
   * This is the only place a recorded step's meaning changes after the fact, and
   * an inherited step keeps its original action id -- that is what marks it as
   * shared. Editing it in place would leave two different steps claiming to be the
   * same one, so the workspace copy takes a fresh id and a back-reference to the
   * step it diverged from. The saved case is untouched either way; what this
   * protects is the ability to tell later which steps are genuinely still shared.
   *
   * Returns the id the change landed on, which the caller needs because it may no
   * longer be the id it passed in.
   */
  async function applyStepChange(action, changes) {
    const origin = await readOrigin();
    if (!isInheritedStep(origin, action.id)) {
      await actionStore.patchAction(action.id, changes);
      return action.id;
    }

    const copy = {
      ...action,
      ...changes,
      id: generateActionId(),
      // The step this one diverged from. Kept so a comparison view can still line
      // the two up even though the ids no longer match.
      originActionId: action.originActionId || action.id
    };
    // The screenshot key comes along, so the card keeps showing the image while the
    // re-capture runs. The re-capture writes a new key rather than overwriting it,
    // so the case this step came from keeps its own screenshot.
    const replaced = await actionStore.replaceActionId(action.id, copy);
    if (!replaced) {
      await actionStore.patchAction(action.id, changes);
      return action.id;
    }
    console.log(`[Background] Copied inherited step ${action.id} to ${copy.id} before editing it.`);
    return copy.id;
  }

  /** Only a fresh recording's first root-page navigation is a workflow step. */
  async function isOpeningLifecycleStep(payload) {
    if (payload.type !== "navigate" && payload.type !== "newPage") return false;
    const order = await actionStore.readOrder();
    return order.length === 0 && payload.pageName === "page1";
  }

  function log(payload, senderTab, options = {}) {
    const write = () => logUnlocked(payload, senderTab, options);
    return globalThis.RecorderMediaStore?.withWriteLock
      ? globalThis.RecorderMediaStore.withWriteLock(write)
      : write();
  }

  async function logUnlocked(payload, senderTab, { beforeFrameData = null } = {}) {
    if (!senderTab) return;
    payload.id = payload.id || generateActionId();

    const isLifecycle = payload.type === "navigate" || payload.type === "newPage";
    if (isLifecycle && (payload.url === "about:blank" || senderTab.url === "about:blank")) {
      console.log(`[Background] Filtering out about:blank action of type ${payload.type}`);
      return;
    }

    const data = await chrome.storage.local.get([
      "isRecording",
      "tabsMapping",
      "recordingTabIds",
      "nextPageNumber",
      // Read on the same round trip the step already pays for, so a recording
      // whose screenshots are turned off costs no extra storage traffic.
      CAPTURE_SETTINGS_KEY,
      SESSION_CAPTURE_SETTINGS_KEY
    ]);
    if (!data.isRecording || !(data.recordingTabIds || []).includes(senderTab.id)) {
      console.log(`[Background] Ignoring action from out-of-scope tab ${senderTab.id}`);
      return;
    }
    const capturePlan = recordingCapturePlanFor(data);

    payload.pageName = await resolvePageName(
      senderTab,
      data.tabsMapping || {},
      data.nextPageNumber || 1
    );

    if (payload.type === "type" && await mergeIntoPrecedingType(payload, senderTab)) return;
    if (isLifecycle && !(await isOpeningLifecycleStep(payload))) {
      console.log(`[Background] Filtering out non-opening ${payload.type} for ${payload.pageName}`);
      return;
    }

    // Capture state is part of the step's first write, not a follow-up patch: the
    // step store was restructured so that recording a step costs one write, and a
    // separate "now waiting for a screenshot" patch would double that again.
    // A session recorded without screenshots marks every step as deliberately
    // skipped, which is what the UI reads to say why there is no image.
    const willCapture = capturePlan.screenshots && !payload.screenshotSkippedReason;
    Object.assign(
      payload,
      willCapture
        ? pendingCaptureFields()
        : skippedCaptureFields(
          capturePlan.screenshots
            ? payload.screenshotSkippedReason
            : SCREENSHOT_SKIPPED_REASON.captureDisabled
        )
    );

    // The "before" frame: the page as it looked when the action happened, taken
    // from the live cache. For a click it was grabbed before the effect ran (see
    // logClick); for other actions we grab it now. Persist the blob before exposing
    // its key on the step. Otherwise the panel can race the IndexedDB write, decide
    // the image is missing, and keep that stale result because the key itself never
    // changes. A failed before-frame write simply leaves a valid single-frame step.
    const beforeData = willCapture ? beforeFrameData || screenshots.snapshotFrameData(senderTab.id) : null;
    const beforeCandidateKey = beforeData ? screenshots.beforeKeyFor(payload.id) : null;
    const highlightBox = (payload.type === "drag" ? payload.source : payload.target)?.boundingBox || null;
    const beforeKey = beforeCandidateKey
      ? await screenshots.storeFrameBlob(beforeCandidateKey, beforeData, highlightBox)
      : null;
    if (beforeKey) payload.screenshotBeforeKey = beforeKey;

    try {
      await actionStore.appendAction(payload);
    } catch (error) {
      // The blob landed but no step can reference it. Use the same reference-aware
      // cleanup path as deletion so a coincident saved-case write cannot lose media.
      if (beforeKey) await mediaCleanup.deleteUnreferenced([beforeKey]);
      throw error;
    }
    await chrome.storage.local.set({ activeCaseId: null });
    if (willCapture) screenshots.schedule(payload.id, senderTab, payload.type);
    console.log(`[Background] Action saved. Total actions: ${await actionStore.countActions()}`);
  }

  /**
   * Records a click only if something observable followed it: a DOM mutation, a
   * navigation, or a new tab/window. Without this, every stray click on inert
   * page chrome becomes a step.
   */
  async function logClick(request, sender) {
    const senderTab = sender.tab;
    if (!senderTab?.id) return { success: false, error: t("errorNoClickPage", [], "未找到点击所在网页") };

    // Grabbed now, before the effect-validation wait below and before any
    // navigation the click triggers -- this is the page as the user saw it when
    // they clicked. It stays valid even if the click closes the tab.
    const beforeFrameData = screenshots.snapshotFrameData(senderTab.id);
    const clickAt = Number(request.payload?.timestamp) || Date.now();
    let domChanged = false;
    let browserContextChange = null;
    let checkingNavigation = true;
    const sourceUrl = sender.frameId ? senderTab.url : request.payload?.url || senderTab.url;
    async function waitForNavigation() {
      const deadline = Date.now() + CLICK_EFFECT_TIMEOUT_MS;
      do {
        try {
          const currentTab = await chrome.tabs.get(senderTab.id);
          if (currentTab.url && currentTab.url !== sourceUrl) return { navigated: true };
        } catch (error) {
          return { navigated: true };
        }
        await wait(40);
      } while (checkingNavigation && Date.now() < deadline);
      throw new Error("No navigation observed");
    }

    if (!request.forceValid) {
      let effectTimer;
      try {
        // A destroyed frame or a negative DOM result is not evidence that the
        // click did nothing. Keep waiting for navigation or a new browser context.
        const evidence = Promise.any([
          chrome.tabs.sendMessage(
            senderTab.id,
            {
              action: MESSAGE.waitForClickEffect,
              baseline: request.effectBaseline,
              timeoutMs: CLICK_EFFECT_TIMEOUT_MS
            },
            { frameId: sender.frameId || 0 }
          ).then(result => {
            if (!result?.changed) throw new Error("No DOM change observed");
            return { domChanged: true };
          }),
          scope.waitForBrowserContextChange(senderTab.id, clickAt, CLICK_EFFECT_TIMEOUT_MS)
            .then(change => {
              if (!change) throw new Error("No browser context change observed");
              return { browserContextChange: change };
            }),
          waitForNavigation()
        ]);
        const outcome = await Promise.race([
          evidence,
          new Promise(resolve => {
            effectTimer = setTimeout(() => resolve({}), CLICK_EFFECT_TIMEOUT_MS);
          })
        ]);
        domChanged = !!outcome.domChanged;
        browserContextChange = outcome.browserContextChange || null;
      } catch (error) {
        // A navigation may destroy the originating frame before it responds.
      } finally {
        clearTimeout(effectTimer);
        checkingNavigation = false;
      }
    }

    let navigated = false;
    try {
      const currentTab = await chrome.tabs.get(senderTab.id);
      navigated = !!currentTab.url && currentTab.url !== sourceUrl;
    } catch (error) {
      navigated = true;
    }

    browserContextChange ||= scope.findBrowserContextChange(senderTab.id, clickAt);
    if (!request.forceValid && !domChanged && !navigated && !browserContextChange) {
      // The only gate that cannot be decided in the page, because it needs the
      // cross-tab view, and the one that hid a missing step best: the click looks
      // identical to a stray one. Report what was actually observed, so the next
      // occurrence says which signal failed to arrive instead of guessing.
      reportClickSkipped(CLICK_SKIP_REASON.noObservableEffect, {
        target: request.payload?.target?.tagName || null,
        url: sourceUrl,
        domChanged,
        navigated,
        waitedMs: CLICK_EFFECT_TIMEOUT_MS
      });
      return { success: true, ignored: true };
    }

    // The child page will be captured on its own first frame; screenshotting the
    // parent here would just race the tab switch. That reason is the capture
    // pipeline's to overwrite, though, and it does: a session running without
    // screenshots replaces it with `capture-disabled`, and a later successful
    // capture clears the field outright. That this click opened a page is a fact
    // about the flow rather than about a screenshot, so it gets its own field --
    // the exported document needs it to name the handle the next steps run on.
    if (browserContextChange) {
      request.payload.screenshotSkippedReason = SCREENSHOT_SKIPPED_REASON.opensChildPage;
      request.payload.openedChildPage = true;
    }

    await log(request.payload, senderTab, { beforeFrameData });
    notifyStepsUpdated();
    return { success: true };
  }

  async function deleteStep(index) {
    const removed = await actionStore.removeActionAt(index);
    if (!removed) return { success: false, error: t("errorStepNotFound", [], "步骤不存在") };

    await chrome.storage.local.set({ activeCaseId: null });
    // Runs after the step is out of the workspace, so the reference check sees
    // the list this deletion produced rather than the one before it. Both of the
    // step's frames are offered up.
    const cleanup = await mediaCleanup.deleteUnreferenced(
      [removed.screenshotKey, removed.screenshotBeforeKey].filter(Boolean)
    );
    notifyStepsUpdated();
    return { success: true, cleanupPending: !!cleanup.pending };
  }

  async function deleteSteps(actionIds) {
    const ids = [...new Set(Array.isArray(actionIds) ? actionIds.filter(id => typeof id === "string" && id) : [])];
    if (ids.length === 0) {
      return { success: false, error: t("errorNoStepsToDelete", [], "请选择要删除的步骤") };
    }
    const removed = await actionStore.removeActions(ids);
    if (removed.length === 0) {
      return { success: false, error: t("errorStepNotFound", [], "步骤不存在") };
    }

    await chrome.storage.local.set({ activeCaseId: null });
    const cleanup = await mediaCleanup.deleteUnreferenced(removed.flatMap(action => [
      action.screenshotKey,
      action.screenshotBeforeKey
    ]).filter(Boolean));
    notifyStepsUpdated();
    return {
      success: true,
      deletedCount: removed.length,
      cleanupPending: !!cleanup.pending
    };
  }

  return { deleteStep, deleteSteps, log, logClick };
}
