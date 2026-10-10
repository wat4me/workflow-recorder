/** Forces one clean page paint when a static page has not produced a frame. */
(function () {
  if (globalThis.RecorderScreencastFramePrimer) return;
  const hostMarker = Symbol.for("workflow-recorder.screencast-frame-primer");

  function create() {
    let host = null;
    let shadow = null;
    const isTopFrame = () => window.top === window;

    function mount() {
      if (!isTopFrame() || host?.isConnected) return host;
      host = document.createElement("div");
      host[hostMarker] = true;
      host.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;overflow:hidden;pointer-events:none;";
      shadow = host.attachShadow({ mode: "closed" });
      document.documentElement.appendChild(host);
      return host;
    }

    function afterPaint(run) {
      requestAnimationFrame(() => requestAnimationFrame(run));
    }

    function primeFrame() {
      const mounted = mount();
      return new Promise(resolve => {
        if (!shadow) return resolve(false);
        const dot = document.createElement("div");
        dot.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;"
          + "background:rgba(0,0,0,0.01);pointer-events:none;";
        shadow.appendChild(dot);
        afterPaint(() => {
          dot.remove();
          afterPaint(() => {
            mounted.remove();
            if (host === mounted) host = null;
            shadow = null;
            resolve(true);
          });
        });
      });
    }

    function dispose() {
      host?.remove();
      host = null;
      shadow = null;
    }

    return { dispose, primeFrame };
  }

  globalThis.RecorderScreencastFramePrimer = { create };
})();
