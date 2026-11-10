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
   * Resolves handles for the action and any page it opened in one mapping write.
   */
  async function resolvePageNames(tabIds, tabsMapping, nextPageNumber) {
    let changed = false;
    const names = tabIds.map(tabId => {
      if (tabsMapping[tabId]) return tabsMapping[tabId];
      changed = true;
      const name = `page${nextPageNumber++}`;
      tabsMapping[tabId] = name;
      return name;
    });
    if (changed) await chrome.storage.local.set({ tabsMapping, nextPageNumber });
    return names;
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
      && typeof payload.target.domPath === "string" && payload.target.domPath.length > 0
      && (lastAction.frameId ?? 0) === payload.frameId
      && (lastAction.documentId ?? null) === payload.documentId
      && lastAction.url === payload.url
      && lastAction.target.domPath === payload.target.domPath;
    if (!sameTarget) return false;

    const willCapture = !lastAction.screenshotSkippedReason;
    // The re-capture marker rides along with the value change rather than being
    // a second write. The step keeps whatever screenshot it already had until the
    // new one binds, so the card shows the old image with a progress state on it
    // instead of blanking while the user is still typing.
    const changes = {
      value: payload.value,
      ...(payload.accessibility ? { accessibility: payload.accessibility } : {}),
      timestamp: payload.timestamp,
      ...(willCapture ? pendingCaptureFields() : {})
    };

    const targetId = await applyStepChange(lastAction, changes, { activeCaseId: null });
    if (willCapture) screenshots.schedule(targetId, senderTab, lastAction.type, payload.frameId ? payload.timestamp : 0);
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
  async function applyStepChange(action, changes, extraWrites = {}) {
    const origin = await readOrigin();
    if (!isInheritedStep(origin, action.id)) {
      await actionStore.patchAction(action.id, changes, { extraWrites });
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
    const replaced = await actionStore.replaceActionId(action.id, copy, extraWrites);
    if (!replaced) {
      await actionStore.patchAction(action.id, changes, { extraWrites });
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

  async function logUnlocked(payload, senderTab, { beforeFrameData = null, frameId = 0, documentId = null,
    beforeActionId, openedTab } = {}) {
    if (!senderTab) return;
    // Browser-provided identity prevents identical paths in different documents
    // from being folded together. Do not trust identity supplied by the page.
    payload.frameId = frameId;
    payload.documentId = documentId;
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

    const tabIds = openedTab ? [senderTab.id, openedTab.tabId] : [senderTab.id];
    const [pageName, openedPageName] = await resolvePageNames(tabIds, data.tabsMapping || {}, data.nextPageNumber || 1);
    payload.pageName = pageName;
    if (openedPageName) {
      payload.openedPageName = openedPageName;
      if (Number.isInteger(openedTab.windowId) && Number.isInteger(senderTab.windowId)) {
        payload.openedPageKind = openedTab.windowId === senderTab.windowId ? "tab" : "window";
      }
      if (/^(https?|file):/i.test(openedTab.url || "")) payload.openedPageUrl = openedTab.url;
    }

    if (payload.type === "type" && await mergeIntoPrecedingType(payload, senderTab)) return;
    if (isLifecycle && !(await isOpeningLifecycleStep(payload))) {
      console.log(`[Background] Filtering out non-opening ${payload.type} for ${payload.pageName}`);
      return;
    }
    if (payload.type === "pressKey") {
      const change = scope.findBrowserContextChange?.(senderTab.id, payload.timestamp);
      if (change?.type === "javascript-dialog") beforeActionId = change.actionId;
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
    if (beforeKey) {
      payload.screenshotBeforeKey = beforeKey;
      // Only this explicit field opts a frame into an overlay. Legacy images
      // already contain their highlight and must not be highlighted twice.
      if (highlightBox?.coordinateSpace === "top-viewport") {
        payload.screenshotBeforeHighlight = { ...highlightBox };
      }
    }

    try {
      // Clearing the saved-case baseline rides along with the step write: an
      // action change invalidates it, and a second write per step was the only
      // thing keeping the two apart.
      await actionStore.appendAction(payload, { activeCaseId: null }, { beforeActionId });
    } catch (error) {
      // The blob landed but no step can reference it. Use the same reference-aware
      // cleanup path as deletion so a coincident saved-case write cannot lose media.
      if (beforeKey) await mediaCleanup.deleteUnreferenced([beforeKey]);
      throw error;
    }
    // Top-document observers cannot see input/click events inside an iframe.
    // Keep a quiet boundary for those actions even if the outer page is idle.
    if (willCapture) screenshots.schedule(payload.id, senderTab, payload.type, frameId ? payload.timestamp : 0);
    console.debug("[Background] Action saved:", payload.type);
  }

  /**
   * Records a click only if something observable followed it: a DOM mutation, a
   * navigation, or a new tab/window. Without this, every stray click on inert
   * page chrome becomes a step.
   */
  async function logClick(request, sender, options = {}) {
    const senderTab = sender.tab;
    if (!senderTab?.id) return { success: false, error: t("errorNoClickPage", [], "未找到点击所在网页") };

    // Grabbed now, before the effect-validation wait below and before any
    // navigation the click triggers -- this is the page as the user saw it when
    // they clicked. It stays valid even if the click closes the tab.
    const beforeFrameData = options.beforeFrameData ?? screenshots.snapshotFrameData(senderTab.id);
    const clickAt = Number(request.payload?.timestamp) || Date.now();
    const validationStartedAt = Date.now();
    const validationDeadline = Math.min(clickAt, validationStartedAt) + CLICK_EFFECT_TIMEOUT_MS;
    const timeRemaining = () => Math.max(0, validationDeadline - Date.now());
    const debugDecision = (decision, evidence) => globalThis.WorkflowRecorderProtocol.recordingDebug("click-decision", {
      clickId: request.debugClickId, tabId: senderTab.id, frameId: sender.frameId || 0,
      target: request.payload?.target?.tagName, decision, evidence,
      queuedMs: Math.max(0, validationStartedAt - clickAt),
      validationMs: Date.now() - validationStartedAt
    });
    let domChanged = false;
    let sourceFrameChange = null;
    let browserContextChange = null;
    let interrupted = false;
    let observedNavigation = false;
    let checkingNavigation = true;
    const sourceUrl = sender.frameId ? senderTab.url : request.payload?.url || senderTab.url;
    const expired = timeRemaining() === 0;
    async function detectSourceFrameChange() {
      if (!sender.frameId || !chrome.webNavigation?.getAllFrames) return null;
      try {
        const frames = await chrome.webNavigation.getAllFrames({ tabId: senderTab.id });
        // A failed/incomplete frame query is not proof that a dialog closed.
        if (!Array.isArray(frames) || !frames.some(frame => frame.frameId === 0)) return null;
        const frame = frames.find(item => item.frameId === sender.frameId);
        if (!frame) return "removed";
        if (sender.documentId && frame.documentId && frame.documentId !== sender.documentId) return "navigated";
      } catch { /* Preserve DOM/navigation evidence if the browser query fails. */ }
      return null;
    }
    async function waitForSourceFrameChange() {
      if (!sender.frameId || !chrome.webNavigation?.getAllFrames) throw new Error("No source frame to observe");
      const deadline = validationDeadline;
      do {
        const change = await detectSourceFrameChange();
        if (change) return { sourceFrameChange: change };
        await wait(40);
      } while (checkingNavigation && Date.now() < deadline);
      throw new Error("No source frame change observed");
    }
    async function waitForNavigation() {
      const deadline = validationDeadline;
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
              debugClickId: request.debugClickId,
              timeoutMs: timeRemaining()
            },
            sender.documentId ? { documentId: sender.documentId } : { frameId: sender.frameId || 0 }
          ).then(result => {
            if (result?.interrupted) return { interrupted: true };
            // A delayed worker may read an already-completed page observation,
            // but can never start a fresh DOM window for that old click.
            if (expired && (!Number.isFinite(result?.observedAt) || result.observedAt < clickAt - 50 || result.observedAt > validationDeadline)) {
              throw new Error("No in-window cached effect");
            }
            if (!result?.changed) throw new Error("No DOM change observed");
            return { domChanged: true };
          }),
          (expired ? Promise.resolve(null) : scope.waitForBrowserContextChange(senderTab.id, clickAt, timeRemaining()))
            .then(change => {
              if (!change || (Number.isFinite(change.time) && change.time > validationDeadline)) throw new Error("No browser context change observed");
              return { browserContextChange: change };
            }),
          expired ? Promise.reject(new Error("Navigation window expired")) : waitForNavigation(),
          expired ? Promise.reject(new Error("Frame window expired")) : waitForSourceFrameChange()
        ]);
        const outcome = await Promise.race([
          evidence,
          new Promise(resolve => {
            effectTimer = setTimeout(() => resolve({}), expired ? 100 : timeRemaining());
          })
        ]);
        domChanged = !!outcome.domChanged;
        sourceFrameChange = outcome.sourceFrameChange || null;
        browserContextChange = outcome.browserContextChange || null;
        interrupted = !!outcome.interrupted;
        observedNavigation = !!outcome.navigated;
      } catch (error) {
        // A navigation may destroy the originating frame before it responds.
      } finally {
        clearTimeout(effectTimer);
        checkingNavigation = false;
      }
    }

    let navigated = observedNavigation;
    try {
      if (!interrupted && timeRemaining() > 0) {
        const currentTab = await chrome.tabs.get(senderTab.id);
        navigated ||= !!currentTab.url && currentTab.url !== sourceUrl;
      }
    } catch (error) {
      navigated = !interrupted;
    }

    if (!interrupted) browserContextChange ||= scope.findBrowserContextChange(senderTab.id, clickAt);
    if (!interrupted && request.expectNewPage && !browserContextChange && timeRemaining() > 0) {
      browserContextChange = await scope.waitForBrowserContextChange(senderTab.id, clickAt, Math.min(timeRemaining(), 200));
    }
    if (Number.isFinite(browserContextChange?.time) && browserContextChange.time > validationDeadline) browserContextChange = null;
    // A final snapshot can annotate a frame close when DOM evidence won the
    // race. Keep this browser query bounded too, including for forced clicks.
    const remaining = Math.max(0, validationDeadline - Date.now());
    if (!interrupted && !sourceFrameChange && sender.frameId && remaining) {
      let frameTimer;
      try {
        sourceFrameChange = await Promise.race([detectSourceFrameChange(), new Promise(resolve => {
          frameTimer = setTimeout(() => resolve(null), Math.min(remaining, 100));
        })]);
      } finally { clearTimeout(frameTimer); }
    }
    if (!request.forceValid && !domChanged && !navigated && !browserContextChange && !sourceFrameChange) {
      // The only gate that cannot be decided in the page, because it needs the
      // cross-tab view, and the one that hid a missing step best: the click looks
      // identical to a stray one. Report what was actually observed, so the next
      // occurrence says which signal failed to arrive instead of guessing.
      reportClickSkipped(CLICK_SKIP_REASON.noObservableEffect, {
        clickId: request.debugClickId,
        target: request.payload?.target?.tagName || null,
        url: sourceUrl,
        domChanged,
        navigated,
        waitedMs: CLICK_EFFECT_TIMEOUT_MS
      });
      debugDecision("filtered", { domChanged, navigated, browserContextChange: !!browserContextChange, sourceFrameChange, interrupted });
      return { success: true, ignored: true };
    }

    // The child page will be captured on its own first frame; screenshotting the
    // parent here would just race the tab switch. That reason is the capture
    // pipeline's to overwrite, though, and it does: a session running without
    // screenshots replaces it with `capture-disabled`, and a later successful
    // capture clears the field outright. That this click opened a page is a fact
    // about the flow rather than about a screenshot, so it gets its own field --
    // the exported document needs it to name the handle the next steps run on.
    const commit = async (payload = request.payload) => {
      if (browserContextChange && browserContextChange.type !== "javascript-dialog") {
        payload.screenshotSkippedReason = SCREENSHOT_SKIPPED_REASON.opensChildPage;
        payload.openedChildPage = true;
      }
      if (sourceFrameChange === "removed") payload.frameClosedAfterClick = true;
      if (sourceFrameChange === "navigated") payload.frameNavigatedAfterClick = true;
      // CDP can deliver the dialog event before the content-script message.
      const beforeActionId = browserContextChange?.type === "javascript-dialog" ? browserContextChange.actionId : undefined;
      let openedTab;
      if (browserContextChange?.type === "tab-created" && Number.isInteger(browserContextChange.tabId)) {
        const { tabId, windowId, url } = browserContextChange;
        const openedUrl = /^(https?|file):/i.test(url || "") ? url : null;
        const tab = Number.isInteger(windowId) && openedUrl ? null : await chrome.tabs.get(tabId).catch(() => null);
        openedTab = { tabId, windowId: windowId ?? tab?.windowId, url: openedUrl || tab?.pendingUrl || tab?.url };
      }
      await log(payload, senderTab, { beforeFrameData, frameId: sender.frameId, documentId: sender.documentId,
        beforeActionId, openedTab });
      debugDecision("recorded", { domChanged, navigated, browserContextChange: !!browserContextChange, sourceFrameChange,
        forced: !!request.forceValid, forcedReason: request.forceValid
          ? (payload.target?.tagName === "canvas" ? "canvas" : payload.target?.tagName === "a" ? "hyperlink" : "file-input-or-explicit-handler") : null });
      notifyStepsUpdated();
      return { success: true };
    };
    return options.deferCommit ? { success: true, commit } : commit();
  }

  async function setDialogResult(actionId, dialogResult, input) {
    const changes = { dialogResult };
    if (typeof input === "string") changes.dialogInput = input;
    if (await actionStore.patchAction(actionId, changes, { extraWrites: { activeCaseId: null } })) notifyStepsUpdated();
  }

  async function renameClickTarget(actionId, name) {
    if (typeof name !== "string" || name.length > 120) {
      return { success: false, error: t("invalidClickTargetName", [], "名称最多可输入 120 个字符") };
    }
    const action = typeof actionId === "string" ? await actionStore.readAction(actionId) : null;
    if (action?.type !== "click") {
      return { success: false, error: t("errorStepNotFound", [], "步骤不存在") };
    }

    const customTargetName = name.replace(/\s+/g, " ").trim();
    if (customTargetName === (action.customTargetName || "")) return { success: true };

    // This label annotates the recorded click. Keep its id so a screenshot
    // already queued for this step can still attach to it.
    const previous = await actionStore.patchAction(actionId, customTargetName ? { customTargetName } : {}, {
      remove: customTargetName ? [] : ["customTargetName"],
      extraWrites: { activeCaseId: null }
    });
    if (!previous) return { success: false, error: t("errorStepNotFound", [], "步骤不存在") };
    notifyStepsUpdated();
    return { success: true };
  }

  async function editInputValue(actionId, value) {
    const action = typeof actionId === "string" ? await actionStore.readAction(actionId) : null;
    if (action?.type !== "type" || typeof value !== "string") {
      return { success: false, error: t("errorStepNotFound", [], "步骤不存在") };
    }
    if (action.value === value) return { success: true };
    await applyStepChange(action, { value }, { activeCaseId: null });
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

  return { renameClickTarget, editInputValue, deleteStep, deleteSteps, log, logClick, setDialogResult };
}
