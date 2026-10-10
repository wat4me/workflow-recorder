/** Keeps wide pages usable while the extension side panel is open. */
(function () {
  if (globalThis.RecorderPageFit) return;

  function create() {
    let enabled = false;
    let timer = null;
    let observer = null;
    let settlingUntil = 0;
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
      remember();
      const viewportWidth = window.innerWidth;
      const pageWidth = measureWidth();
      if (pageWidth - viewportWidth <= 2 || viewportWidth <= 0) return;
      // Scaling alone brings the layout inside the viewport. Forcing
      // overflow-x:hidden on top of it used to override the site's own overflow
      // handling and could clip content whenever the scale under-corrected.
      document.documentElement.style.setProperty(
        "zoom",
        String(Math.min(1, viewportWidth / pageWidth)),
        "important"
      );
      settlingUntil = Date.now() + 120;
    }

    function schedule(delay = 0) {
      clearTimeout(timer);
      timer = setTimeout(fit, delay);
    }

    function setEnabled(nextEnabled) {
      if (enabled === nextEnabled) {
        if (enabled) schedule();
        return;
      }
      enabled = nextEnabled;
      if (!enabled) {
        clearTimeout(timer);
        window.removeEventListener("resize", onResize);
        observer?.disconnect();
        observer = null;
        restore();
        originalZoom = null;
        return;
      }
      remember();
      window.addEventListener("resize", onResize);
      observer = new ResizeObserver(() => {
        if (Date.now() >= settlingUntil) schedule(60);
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
})();
