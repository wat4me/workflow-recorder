/** Page-effect and loading-state detection used by click validation and screenshots. */
(function () {
  if (globalThis.RecorderPageStability) return;

  const knownLoadingSelectors = [
    'div[class*="loading_progress"]',
    "div.common_loading_progress_box",
    "div.ctpUiLoading div.loaderIcon",
    "div.menu-setting-loading",
    "div.loaderIcon",
    "div.ant-spin-nested-loading .ant-spin-dot",
    ".cap4-loading",
    "div.v-easy-table-loading",
    "div.gBlock",
    "div#nprogress"
  ];
  const framePrimerMarker = Symbol.for("workflow-recorder.screencast-frame-primer");

  function create() {
    let effectVersion = 0;
    let waitGeneration = 0;
    const debug = globalThis.WorkflowRecorderProtocol;
    const mutationHistory = [];
    let tracking = false;
    let lastChangeAt = Date.now();
    let visualMutationCount = 0;
    let clickSequence = 0;
    const clickEffects = globalThis.RecorderClickEffects.create({ onFinish: (observation, evidence) => {
      debug?.recordingDebug("click-dom-result", { clickId: observation.id, ...observation.result,
        baseline: observation.baseline, version: effectVersion, waitedMs: Date.now() - observation.startedAt,
        viewport: debug.debugViewport(), acceptedMutations: evidence.slice(0, 5).map(summarizeMutation),
        mutations: mutationEvidence(mutationHistory.filter(item => item.version > observation.baseline)),
        historyTruncated: mutationHistory.length > 0 && mutationHistory[0].version > observation.baseline + 1 });
    } });

    function styleSummary(value) {
      // CSS URLs and arbitrary custom properties are unnecessary here.
      const allowed = /^(?:zoom|width|height|min-width|min-height|max-width|max-height|top|left|right|bottom|display|visibility|opacity|transform|position|background-color|overflow(?:-x|-y)?)$/;
      return String(value || "").split(";").filter(item => allowed.test(item.split(":")[0].trim()))
        .join(";").slice(0, 240);
    }

    function summarizeMutation(record) {
      const summary = { type: record.type, target: debug.debugElement(record.target),
        parent: debug.debugElement(record.target?.parentElement) };
      if (record.type === "attributes") {
        summary.attribute = record.attributeName;
        if (record.attributeName === "style") {
          summary.before = styleSummary(record.oldValue);
          summary.after = styleSummary(record.target?.getAttribute?.("style"));
        } else if (["class", "hidden", "aria-hidden", "aria-expanded"].includes(record.attributeName)) {
          summary.before = String(record.oldValue ?? "").slice(0, 180);
          summary.after = String(record.target?.getAttribute?.(record.attributeName) ?? "").slice(0, 180);
        }
      } else if (record.type === "childList") {
        summary.addedCount = record.addedNodes.length;
        summary.removedCount = record.removedNodes.length;
        summary.added = Array.from(record.addedNodes).slice(0, 3).map(debug.debugElement);
        summary.removed = Array.from(record.removedNodes).slice(0, 3).map(debug.debugElement);
      }
      return summary;
    }

    function mutationEvidence(records) {
      const result = [];
      let budget = 6500;
      for (const record of records.slice(0, 8)) {
        const item = { ...record, samples: [] };
        for (const sample of record.samples) {
          const size = JSON.stringify(sample).length;
          if (size > budget) break;
          item.samples.push(sample);
          budget -= size;
        }
        result.push(item);
        if (budget < 500) break;
      }
      return result;
    }

    function applyRecords(records) {
      const meaningful = records.filter(record => !isFramePrimerMutation(record));
      if (!meaningful.length) return;
      // Keep the screenshot quiet clock across requests. Libraries often write
      // the same style/class on every timer tick; those writes do not repaint.
      const changed = meaningful.filter(record => record.type === "attributes"
        ? record.oldValue !== record.target?.getAttribute?.(record.attributeName)
        : record.type !== "characterData" || record.oldValue !== record.target?.data);
      if (changed.length) {
        lastChangeAt = Date.now();
        visualMutationCount += changed.length;
      }
      effectVersion++;
      if (debug?.RECORDING_DEBUG_ENABLED) {
        mutationHistory.push({ at: Date.now(), version: effectVersion, count: meaningful.length,
          samples: meaningful.slice(0, 5).map(summarizeMutation) });
        if (mutationHistory.length > 24) mutationHistory.shift();
      }
      clickEffects.observe(meaningful);
    }

    function isFramePrimerMutation(mutation) {
      const target = mutation.target;
      if (target?.host?.[framePrimerMarker] || target?.[framePrimerMarker]) return true;
      if (mutation.type !== "childList") return false;
      return [...mutation.addedNodes, ...mutation.removedNodes].every(node =>
        node?.[framePrimerMarker] || node?.parentNode?.host?.[framePrimerMarker]
      );
    }

    const effectObserver = new MutationObserver(applyRecords);

    // A full-subtree observer on every page and frame the user browses is far
    // more than this feature needs, so recording drives its lifetime.
    function startEffectTracking() {
      if (!document.documentElement) return;
      effectObserver.observe(document.documentElement, {
        attributes: true,
        attributeOldValue: true,
        childList: true,
        characterData: true,
        characterDataOldValue: true,
        subtree: true
      });
      if (!tracking) {
        tracking = true;
        lastChangeAt = Date.now();
        // The tracker also checks dimensions if DOM changes arrive first.
        window.addEventListener("resize", onResize, true);
        window.visualViewport?.addEventListener("resize", onVisualResize);
        window.addEventListener("pagehide", onPageHide);
        document.addEventListener("focusin", onFocus, true);
        document.addEventListener("focusout", onFocus, true);
        for (const name of ["click", "input", "change"]) document.addEventListener(name, onActivity, true);
        for (const name of ["pointerdown", "mousedown", "keydown", "beforeinput"]) {
          document.addEventListener(name, onInteraction, true);
        }
        debug?.recordingDebug("tracking-start", { viewport: debug.debugViewport() });
      }
    }

    function interruptClicks(reason) {
      applyRecords(effectObserver.takeRecords());
      clickEffects.interrupt(reason);
    }
    const onActivity = event => { if (event.isTrusted) lastChangeAt = Date.now(); };
    const onInteraction = event => {
      if (event.isTrusted) {
        lastChangeAt = Date.now();
        interruptClicks("next-interaction");
      }
    };
    const onResize = () => {
      lastChangeAt = Date.now();
      clickEffects.interrupt("viewport-resize");
      applyRecords(effectObserver.takeRecords());
      debug?.recordingDebug("viewport-resize", { viewport: debug.debugViewport() });
    };
    const onVisualResize = () => {
      lastChangeAt = Date.now();
      clickEffects.interrupt("viewport-resize");
      debug?.recordingDebug("visual-viewport-resize", { viewport: debug.debugViewport() });
    };
    const onPageHide = event => debug?.recordingDebug("pagehide", { persisted: event.persisted, viewport: debug.debugViewport() });
    const onFocus = event => debug?.recordingDebug(event.type, { target: debug.debugElement(event.target) });

    function stopEffectTracking() {
      waitGeneration++;
      effectObserver.disconnect();
      effectObserver.takeRecords();
      clickEffects.stop();
      if (tracking) {
        tracking = false;
        window.removeEventListener("resize", onResize, true);
        window.visualViewport?.removeEventListener("resize", onVisualResize);
        window.removeEventListener("pagehide", onPageHide);
        document.removeEventListener("focusin", onFocus, true);
        document.removeEventListener("focusout", onFocus, true);
        for (const name of ["click", "input", "change"]) document.removeEventListener(name, onActivity, true);
        for (const name of ["pointerdown", "mousedown", "keydown", "beforeinput"]) {
          document.removeEventListener(name, onInteraction, true);
        }
        debug?.recordingDebug("tracking-stop", {});
      }
    }

    function isVisible(element) {
      if (!element?.isConnected) return false;
      const style = window.getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function isIncompleteProgress(element) {
      if (element.tagName === "PROGRESS") {
        return !element.hasAttribute("value") || element.value < element.max;
      }
      const valueNow = Number(element.getAttribute("aria-valuenow"));
      const valueMax = Number(element.getAttribute("aria-valuemax"));
      return !Number.isFinite(valueNow) || !Number.isFinite(valueMax) || valueNow < valueMax;
    }

    function describe(element) {
      const tag = element.tagName?.toLowerCase() || "element";
      const id = element.id ? `#${element.id}` : "";
      const classes = Array.from(element.classList || []).slice(0, 3).map(name => `.${name}`).join("");
      return `${tag}${id}${classes}`;
    }

    function getLoadingIndicator() {
      const explicit = Array.from(document.querySelectorAll(
        '[aria-busy="true"], [data-loading="true"], [data-busy="true"]'
      )).find(isVisible);
      if (explicit) return { kind: "explicit", selector: describe(explicit) };

      const progress = Array.from(document.querySelectorAll('[role="progressbar"], progress'))
        .find(element => isVisible(element) && isIncompleteProgress(element));
      if (progress) return { kind: "progress", selector: describe(progress) };

      for (const selector of knownLoadingSelectors) {
        const element = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (element) return { kind: "known", selector };
      }
      return null;
    }

    async function waitForClickEffect(baseline, timeoutMs = 1200, clickId = null) {
      applyRecords(effectObserver.takeRecords());
      return clickEffects.wait(clickId);
    }

    async function waitForPageStable(options = {}) {
      // Recording normally owns the observer. Also support a direct stability
      // request without leaving an observer behind when recording is stopped.
      const temporaryTracking = !tracking;
      if (temporaryTracking) startEffectTracking();
      applyRecords(effectObserver.takeRecords());
      const generation = ++waitGeneration;
      const timeoutMs = Math.max(500, Math.min(Number(options.timeoutMs) || 3500, 8000));
      const quietMs = Math.max(150, Math.min(Number(options.quietMs) || 450, 1500));
      const startedAt = Date.now();
      const activityAt = Math.min(Number(options.activityAt) || 0, startedAt);
      const initialMutationCount = visualMutationCount;
      const result = fields => ({ ...fields, waitedMs: Date.now() - startedAt,
        mutationCount: visualMutationCount - initialMutationCount, lastChangeAt: Math.max(lastChangeAt, activityAt) });

      try {
        while (Date.now() - startedAt < timeoutMs) {
          if (generation !== waitGeneration) {
            return result({ stable: false, cancelled: true });
          }
          const loadingIndicator = getLoadingIndicator();
          const quietForMs = Date.now() - Math.max(lastChangeAt, activityAt);
          if (document.readyState !== "loading" && !loadingIndicator && quietForMs >= quietMs) {
            return result({ stable: true });
          }
          const remainingQuietMs = quietMs - quietForMs;
          await new Promise(resolve => setTimeout(resolve,
            Math.min(80, remainingQuietMs > 0 ? remainingQuietMs : 80, timeoutMs - (Date.now() - startedAt))));
        }
        const loadingIndicator = getLoadingIndicator();
        return result({
          stable: false,
          timedOut: true,
          loadingIndicator,
          loadingIndicatorVisible: !!loadingIndicator
        });
      } finally {
        if (temporaryTracking) stopEffectTracking();
      }
    }

    return {
      traceClick: (event, target, baseline) => {
        const clickId = `click-${Date.now()}-${++clickSequence}`;
        clickEffects.begin(clickId, target, baseline);
        debug?.recordingDebug("click-candidate", { clickId, baseline,
          hit: debug.debugElement(event.target), target: debug.debugElement(target),
          x: event.clientX, y: event.clientY, viewport: debug.debugViewport(),
          recentMutations: mutationEvidence(mutationHistory.filter(item => Date.now() - item.at <= 500).slice(-3)) });
        return clickId;
      },
      cancelWait: () => { waitGeneration++; },
      dispose: stopEffectTracking,
      /**
       * Drains records the observer has not delivered yet. MutationObserver
       * callbacks are queued as microtasks, so a click handler reading this
       * synchronously would otherwise capture a baseline that is about to be
       * bumped by mutations which happened *before* the click, making every
       * such click look like it had an effect.
       */
      getEffectVersion: () => {
        applyRecords(effectObserver.takeRecords());
        return effectVersion;
      },
      start: startEffectTracking,
      stop: stopEffectTracking,
      waitForClickEffect,
      waitForPageStable
    };
  }

  globalThis.RecorderPageStability = { create };
})();
