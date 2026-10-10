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

    function applyRecords(records) {
      if (records.some(record => !isFramePrimerMutation(record))) effectVersion++;
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
        childList: true,
        characterData: true,
        subtree: true
      });
    }

    function stopEffectTracking() {
      effectObserver.disconnect();
      effectObserver.takeRecords();
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

    async function waitForClickEffect(baseline, timeoutMs = 1200) {
      applyRecords(effectObserver.takeRecords());
      const initialVersion = Number.isFinite(Number(baseline)) ? Number(baseline) : effectVersion;
      const deadline = Date.now() + Math.max(200, Math.min(Number(timeoutMs) || 1200, 3000));
      while (Date.now() < deadline) {
        if (effectVersion > initialVersion) return { changed: true, version: effectVersion };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { changed: false, version: effectVersion };
    }

    async function waitForPageStable(options = {}) {
      const generation = ++waitGeneration;
      const timeoutMs = Math.max(500, Math.min(Number(options.timeoutMs) || 3500, 8000));
      const quietMs = Math.max(150, Math.min(Number(options.quietMs) || 450, 1500));
      const startedAt = Date.now();
      let lastMutationAt = startedAt;
      let mutationCount = 0;
      const observer = new MutationObserver(() => {
        lastMutationAt = Date.now();
        mutationCount++;
      });
      observer.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true
      });

      try {
        while (Date.now() - startedAt < timeoutMs) {
          if (generation !== waitGeneration) {
            return { stable: false, cancelled: true, waitedMs: Date.now() - startedAt, mutationCount };
          }
          const loadingIndicator = getLoadingIndicator();
          const quietForMs = Date.now() - lastMutationAt;
          if (document.readyState !== "loading" && !loadingIndicator && quietForMs >= quietMs) {
            return { stable: true, waitedMs: Date.now() - startedAt, mutationCount };
          }
          await new Promise(resolve => setTimeout(resolve, 80));
        }
        const loadingIndicator = getLoadingIndicator();
        return {
          stable: false,
          timedOut: true,
          waitedMs: Date.now() - startedAt,
          mutationCount,
          loadingIndicator,
          loadingIndicatorVisible: !!loadingIndicator
        };
      } finally {
        observer.disconnect();
      }
    }

    return {
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
