/** Keeps wide pages usable while the extension side panel is open. */
(function () {
  if (globalThis.RecorderPageFit) return;

  function create() {
    let enabled = false;
    let timer = null;
    let observer = null;
    let fittedViewportWidth = null;
    let originalZoom = null;

    function remember() {
      if (originalZoom !== null) return;
      const style = document.documentElement.style;
      originalZoom = { value: style.getPropertyValue("zoom"), priority: style.getPropertyPriority("zoom") };
    }

    function restore() {
      if (originalZoom === null) return;
      const style = document.documentElement.style;
      originalZoom.value
        ? style.setProperty("zoom", originalZoom.value, originalZoom.priority)
        : style.removeProperty("zoom");
    }

    function measureWidth() {
      restore();
      const root = document.documentElement;
      const body = document.body;
      return Math.max(
        root.scrollWidth,
        root.getBoundingClientRect().width,
        body?.scrollWidth || 0,
        body?.getBoundingClientRect().width || 0
      );
    }

    function fit() {
      if (!enabled || !document.documentElement) return;
      const debug = globalThis.WorkflowRecorderProtocol;
      const before = debug?.debugViewport();
      remember();
      const viewportWidth = window.innerWidth;
      const pageWidth = measureWidth();
      fittedViewportWidth = viewportWidth;
      if (pageWidth - viewportWidth <= 2 || viewportWidth <= 0) {
        debug?.recordingDebug("page-fit", { before, after: debug.debugViewport(), pageWidth, applied: false });
        return;
      }
      // Scaling alone brings the layout inside the viewport. Forcing
      // overflow-x:hidden on top of it used to override the site's own overflow
      // handling and could clip content whenever the scale under-corrected.
      document.documentElement.style.setProperty(
        "zoom",
        String(Math.min(1, viewportWidth / pageWidth)),
        "important"
      );
      debug?.recordingDebug("page-fit", { before, after: debug.debugViewport(), pageWidth, applied: true });
    }

    function schedule(delay = 0) {
      clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fit(); }, delay);
    }

    function setEnabled(nextEnabled) {
      if (enabled === nextEnabled) {
        return;
      }
      enabled = nextEnabled;
      globalThis.WorkflowRecorderProtocol?.recordingDebug("page-fit-enabled", { enabled: nextEnabled,
        viewport: globalThis.WorkflowRecorderProtocol.debugViewport() });
      if (!enabled) {
        clearTimeout(timer);
        timer = null;
        window.removeEventListener("resize", onResize);
        observer?.disconnect();
        observer = null;
        restore();
        originalZoom = null;
        fittedViewportWidth = null;
        return;
      }
      remember();
      window.addEventListener("resize", onResize);
      observer = new ResizeObserver(() => {
        if (timer !== null) return;
        // Our own zoom resizes the root/body too. A time-based suppression
        // breaks on expensive pages whose layout takes longer than that window,
        // feeding restore -> measure -> zoom back into itself indefinitely.
        // Height-only updates and our fitted layout need no further zoom pass.
        const root = document.documentElement;
        if (window.innerWidth === fittedViewportWidth && root.scrollWidth <= root.clientWidth + 2) return;
        schedule(60);
      });
      observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
      schedule();
    }

    function onResize() {
      schedule(60);
    }

    return { dispose: () => setEnabled(false), setEnabled };
  }

  globalThis.RecorderPageFit = { create };
  // Opening the panel only needs this top-frame layout controller. Recording
  // installs its heavier all-frame listeners separately when the user starts.
  if (window.top === window && globalThis.chrome?.runtime?.onMessage) {
    const controller = create();
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action !== globalThis.WorkflowRecorderProtocol.MESSAGE.setPageFit) return;
      controller.setEnabled(!!request.enabled);
      sendResponse({ status: request.enabled ? "fitting" : "restored" });
    });
  }
})();
