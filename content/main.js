/**
 * Workflow Recorder Content Script
 * Captures clicks, keystrokes, selections, and page loading events,
 * and communicates them to background.js.
 */

(function () {
  // Prevent duplicate injections
  if (window.hasPlaywrightRecorderInjected) return;
  window.hasPlaywrightRecorderInjected = true;

  const { MESSAGE, CLICK_SKIP_REASON, reportClickSkipped } = globalThis.WorkflowRecorderProtocol;
  const {
    getEditableTarget,
    getInteractableTarget,
    isMeaningfulClickTarget,
    makeTopViewportPointer
  } = globalThis.RecorderTargeting;

  /**
   * A short, plain description of an element for the skip diagnostics.
   *
   * Deliberately not an analyzer snapshot: the point is to identify the element
   * that was passed over in a console line, and a full analysis of every stray
   * click would cost more than the recording it is meant to explain.
   */
  function describeTarget(element) {
    if (!(element instanceof Element)) return String(element ?? "");
    const id = element.id ? `#${element.id}` : "";
    const classes = element.classList?.length
      ? `.${Array.from(element.classList).slice(0, 2).join(".")}`
      : "";
    return `${element.tagName.toLowerCase()}${id}${classes}`;
  }

  let isRecording = false;
  let hasRecordedNavigation = false;
  const pageStability = globalThis.RecorderPageStability.create();
  const pageFit = globalThis.RecorderPageFit.create();
  const framePrimer = globalThis.RecorderScreencastFramePrimer.create();
  const dragRecorder = globalThis.RecorderDragRecorder.create({
    isRecording: () => isRecording,
    recordAction,
    getInteractableTarget
  });
  const inputRecorder = globalThis.RecorderInputRecorder.create({ recordAction });

  // Hover tracking states
  let lastHoveredElement = null;
  let lastHoveredElementRecorded = null;

  // Initialize session state
  chrome.storage.local.get(["isRecording"], result => {
    isRecording = !!result.isRecording;
    if (isRecording) {
      attachEventListeners();
      // Re-injection into a page of an ongoing recording: the previous document's
      // port went with it. Navigation recording is controlled only by the explicit
      // startRecording message, so redirects and reloads cannot become user steps.
      openKeepalive();
    }
  });

  /**
   * Keeps the Service Worker alive for the length of a recording.
   *
   * A Manifest V3 worker is terminated after 30 seconds without events, and a
   * screencast only pushes frames on paint -- so a user who clicks once and then
   * spends half a minute reading the result produces no events at all. Losing the
   * worker there loses the capture queue and every CDP session with it, and the
   * steps that were waiting get failed on the next start. An open port is the
   * documented way to say "not yet".
   *
   * Top frame only: one port per tab, not one per iframe.
   */
  let keepalivePort = null;

  function openKeepalive() {
    if (window.top !== window || keepalivePort) return;
    try {
      keepalivePort = chrome.runtime.connect({ name: "recording-keepalive" });
    } catch (error) {
      // The extension was reloaded or removed. Nothing schedules a retry from
      // here, so this stops rather than spinning.
      keepalivePort = null;
      return;
    }
    keepalivePort.onDisconnect.addListener(() => {
      keepalivePort = null;
      // The worker went away despite the port -- older Chrome caps port-held
      // workers at five minutes. Reconnecting wakes it and re-establishes the
      // hold; if the extension itself is gone, the connect above throws and the
      // retries end there.
      if (isRecording) setTimeout(openKeepalive, 1000);
    });
  }

  function closeKeepalive() {
    if (!keepalivePort) return;
    const port = keepalivePort;
    keepalivePort = null;
    try {
      port.disconnect();
    } catch (error) {
      // Already gone with the worker.
    }
  }

  // Listen to messages from popup or background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === MESSAGE.pingRecorder) {
      sendResponse({ status: "ready" });
    } else if (request.action === MESSAGE.startRecording) {
      isRecording = true;
      attachEventListeners();
      if (request.recordNavigate) {
        recordCurrentNavigationOnce();
      } else {
        // A continued session deliberately has no opening step: it resumes a
        // workspace that already has one. Latch it as done, because the
        // re-injection paths (DOM load, tab activation, window focus) always ask
        // for the navigation and would otherwise add one behind the session's back.
        hasRecordedNavigation = true;
      }
      openKeepalive();
      sendResponse({ status: "started" });
    } else if (request.action === MESSAGE.stopRecording) {
      // Commit pending input while recordAction can still send it. The worker
      // drains those messages before releasing the capture sessions.
      inputRecorder.flush();
      isRecording = false;
      inputRecorder.reset();
      lastHoveredElement = null;
      lastHoveredElementRecorded = null;
      closeKeepalive();
      // Scoped to the session, not to the document: the next fresh recording
      // started on this same page needs its own opening step.
      hasRecordedNavigation = false;
      framePrimer.dispose();
      removeEventListeners();
      sendResponse({ status: "stopped" });
    } else if (request.action === MESSAGE.setPageFit && window.top === window) {
      pageFit.setEnabled(!!request.enabled);
      sendResponse({ status: request.enabled ? "fitting" : "restored" });
    } else if (request.action === MESSAGE.waitForPageStable && window.top === window) {
      pageStability.waitForPageStable(request.options).then(sendResponse);
      return true;
    } else if (request.action === MESSAGE.cancelPageStableWait && window.top === window) {
      pageStability.cancelWait();
      sendResponse({ status: "cancelled" });
    } else if (request.action === MESSAGE.waitForClickEffect) {
      pageStability.waitForClickEffect(request.baseline, request.timeoutMs).then(sendResponse);
      return true;
    } else if (request.action === MESSAGE.primeScreencastFrame && window.top === window) {
      framePrimer.primeFrame().then(primed => sendResponse({ status: "primed", primed }));
      return true;
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || window.top !== window) return;
    if (changes.isRecording) {
      isRecording = !!changes.isRecording.newValue;
      // Also the fallback for releasing the hold: a backgrounded tab may never get
      // the stopRecording message, and a port left open would keep the worker alive
      // for a recording that already ended.
      if (isRecording) openKeepalive();
      else closeKeepalive();
    }
  });

  function attachEventListeners() {
    pageStability.start();
    document.addEventListener("click", handleClickEvent, true); // Use capture phase
    document.addEventListener("beforeinput", inputRecorder.handleBeforeInput, true);
    document.addEventListener("input", inputRecorder.handleInput, true);
    document.addEventListener("change", inputRecorder.handleChange, true);
    document.addEventListener("keydown", handleKeyDownEvent, true);
    document.addEventListener("blur", inputRecorder.handleBlur, true);
    document.addEventListener("mousemove", handleMouseMoveEvent, true);
    document.addEventListener("pointerdown", dragRecorder.handlePointerDown, true);
    document.addEventListener("pointermove", dragRecorder.handlePointerMove, true);
    document.addEventListener("pointerup", dragRecorder.handlePointerUp, true);
    document.addEventListener("pointercancel", dragRecorder.handlePointerCancel, true);
    document.addEventListener("mousedown", dragRecorder.handleMouseDown, true);
    document.addEventListener("mouseup", dragRecorder.handleMouseUp, true);
    document.addEventListener("dragstart", dragRecorder.handleNativeDragStart, true);
    document.addEventListener("dragover", dragRecorder.handleNativeDragOver, true);
    document.addEventListener("drop", dragRecorder.handleNativeDrop, true);
    document.addEventListener("dragend", dragRecorder.handleNativeDragEnd, true);
    console.log("[Workflow Recorder] Event listeners attached to tab.");
  }

  /**
   * Emits the one opening page step requested by a fresh recording session.
   * Redirects, reloads, child pages and focus re-injection all start with
   * `recordNavigate: false`, so they never become standalone workflow steps.
   */
  function recordCurrentNavigationOnce() {
    if (
      window.top !== window ||
      hasRecordedNavigation ||
      !window.location.href ||
      window.location.href === "about:blank"
    ) {
      return;
    }

    hasRecordedNavigation = true;
    recordAction({
      type: "navigate",
      url: window.location.href,
      title: document.title
    });
  }

  function removeEventListeners() {
    document.removeEventListener("click", handleClickEvent, true);
    document.removeEventListener("beforeinput", inputRecorder.handleBeforeInput, true);
    document.removeEventListener("input", inputRecorder.handleInput, true);
    document.removeEventListener("change", inputRecorder.handleChange, true);
    document.removeEventListener("keydown", handleKeyDownEvent, true);
    document.removeEventListener("blur", inputRecorder.handleBlur, true);
    document.removeEventListener("mousemove", handleMouseMoveEvent, true);
    document.removeEventListener("pointerdown", dragRecorder.handlePointerDown, true);
    document.removeEventListener("pointermove", dragRecorder.handlePointerMove, true);
    document.removeEventListener("pointerup", dragRecorder.handlePointerUp, true);
    document.removeEventListener("pointercancel", dragRecorder.handlePointerCancel, true);
    document.removeEventListener("mousedown", dragRecorder.handleMouseDown, true);
    document.removeEventListener("mouseup", dragRecorder.handleMouseUp, true);
    document.removeEventListener("dragstart", dragRecorder.handleNativeDragStart, true);
    document.removeEventListener("dragover", dragRecorder.handleNativeDragOver, true);
    document.removeEventListener("drop", dragRecorder.handleNativeDrop, true);
    document.removeEventListener("dragend", dragRecorder.handleNativeDragEnd, true);
    dragRecorder.reset();
    pageStability.stop();
    console.log("[Workflow Recorder] Event listeners removed.");
  }

  function handleMouseMoveEvent(event) {
    lastHoveredElement = event.target;
    dragRecorder.handleMouseMove(event);
  }

  /**
   * Standardized Event Dispatcher to Background script
   */
  function recordAction(actionDetails, messageAction = MESSAGE.logAction, messageDetails = {}) {
    if (!isRecording) {
      reportClickSkipped(CLICK_SKIP_REASON.notRecording, { action: actionDetails?.type || null });
      return;
    }

    const payload = {
      timestamp: Date.now(),
      url: window.location.href,
      title: document.title,
      ...actionDetails
    };

    console.log("[Workflow Recorder] Sending action to background:", payload.type);
    chrome.runtime.sendMessage({
      action: messageAction,
      payload: payload,
      ...messageDetails
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error("[Workflow Recorder] sendMessage error:", chrome.runtime.lastError.message);
      } else if (response && !response.success) {
        console.error("[Workflow Recorder] Background returned error:", response.error);
      }
    });
  }

  /**
   * Automatically walk up DOM to locate hover/dropdown trigger siblings if clicked inside dynamic dropdown/popovers
   */
  function detectAndPrependHover(clickedElement) {
    if (!clickedElement) return;

    let current = clickedElement;
    let menuContainer = null;

    // Traverse up to find a container representing a hover/dropdown menu
    while (current && current !== document.body && current.parentElement) {
      const className = (current.className || "").toString().toLowerCase();
      const id = (current.id || "").toString().toLowerCase();
      const role = (current.getAttribute("role") || "").toLowerCase();

      if (
        className.includes("dropdown-menu") ||
        className.includes("dropdown-content") ||
        className.includes("popover") ||
        className.includes("hover-menu") ||
        className.includes("submenu") ||
        className.includes("menu-panel") ||
        className.includes("popup-menu") ||
        className.includes("el-dropdown-menu") ||
        className.includes("ant-dropdown") ||
        className.includes("select-dropdown") ||
        role === "menu" ||
        role === "listbox"
      ) {
        menuContainer = current;
        break;
      }
      current = current.parentElement;
    }

    if (!menuContainer) return;

    // Now try to find the trigger element that opens this menu
    let triggerElement = null;

    // 1. Check aria-controls/aria-owns
    if (menuContainer.id) {
      triggerElement = document.querySelector(
        `[aria-controls="${menuContainer.id}"], [aria-owns="${menuContainer.id}"]`
      );
    }

    // 2. Check previous sibling of the menu container
    if (!triggerElement && menuContainer.previousElementSibling) {
      triggerElement = getInteractableTarget(menuContainer.previousElementSibling) || menuContainer.previousElementSibling;
    }

    // 3. Check siblings inside parent element
    if (!triggerElement && menuContainer.parentElement) {
      const parent = menuContainer.parentElement;
      const siblings = Array.from(parent.children);
      for (const sib of siblings) {
        if (sib === menuContainer) continue;
        const sibTag = sib.tagName.toUpperCase();
        const sibRole = sib.getAttribute("role");
        const sibClass = (sib.className || "").toString().toLowerCase();
        if (
          sibTag === "BUTTON" ||
          sibTag === "A" ||
          sibRole === "button" ||
          sibClass.includes("toggle") ||
          sibClass.includes("trigger") ||
          sib.getAttribute("aria-haspopup") === "true"
        ) {
          triggerElement = sib;
          break;
        }
      }
    }

    // If we found a trigger, verify it is different from the clicked element
    if (triggerElement && triggerElement !== clickedElement) {
      // Avoid double-hovering the same trigger if we just hovered it
      if (lastHoveredElementRecorded === triggerElement) return;

      if (window.SemanticElementAnalyzer) {
        const analysis = window.SemanticElementAnalyzer.analyze(triggerElement);
        recordAction({
          type: "hover",
          target: analysis
        });
        lastHoveredElementRecorded = triggerElement;
        console.log("[Workflow Recorder] Auto-prepended hover step for:", triggerElement);
      }
    }
  }

  /**
   * Handle Clink/Click actions
   */
  function handleClickEvent(event) {
    // Each gate below drops the click on purpose. They say so through
    // reportClickSkipped, because a click the user meant to record and a stray
    // one are indistinguishable after the fact -- which is exactly how a missing
    // step became unexplainable.
    if (dragRecorder.shouldSuppressClick()) {
      reportClickSkipped(CLICK_SKIP_REASON.dragSuppressed, { target: describeTarget(event.target) });
      return;
    }
    // Page code can call element.click() or dispatch a synthetic MouseEvent while
    // handling one real login click. Those events bubble like user clicks but are
    // explicitly marked untrusted by the browser; recording them produces the
    // characteristic duplicate where the second target is often an unnamed helper
    // button. Keyboard activation performed by the user still emits a trusted click.
    if (!event.isTrusted) return reportClickSkipped(
      CLICK_SKIP_REASON.untrustedEvent,
      { target: describeTarget(event.target) }
    );
    const rawTarget = event.target;
    const target = getInteractableTarget(rawTarget);
    if (!target || !isMeaningfulClickTarget(target)) {
      reportClickSkipped(CLICK_SKIP_REASON.meaninglessTarget, { target: describeTarget(rawTarget) });
      return;
    }
    // Skip clicks on text inputs and textareas; typing records their final value.
    const editableTarget = getEditableTarget(target);
    if (editableTarget) {
      reportClickSkipped(CLICK_SKIP_REASON.editableTarget, { target: describeTarget(editableTarget) });
      inputRecorder.markUserTouched(editableTarget);
      return;
    }

    // Trigger auto-hover detection on dynamic popovers/dropdowns before recording click
    detectAndPrependHover(target);

    // Analyze target
    if (window.SemanticElementAnalyzer) {
      const analysis = window.SemanticElementAnalyzer.analyze(target);
      console.log("[Workflow Recorder] Click captured:", analysis);
      recordAction({
        type: "click",
        target: analysis,
        pointer: makeTopViewportPointer(event, target, analysis.boundingBox)
      }, MESSAGE.logClickAction, {
        effectBaseline: pageStability.getEffectVersion(),
        // Inline business handlers can update another frame or close a legacy
        // dialog without mutating this frame's DOM. The click itself is the only
        // reliable effect signal in that case.
        forceValid: target.tagName === "CANVAS" ||
          target.matches('input[type="file"], a[href^="javascript:"]') ||
          target.hasAttribute("onclick")
      });
    } else {
      console.warn("[Workflow Recorder] SemanticElementAnalyzer not available");
    }

    inputRecorder.scheduleCommittedCheck();
  }

  /**
   * Handle custom keypresses like Enter/Tab/Escape, and manual hover shortcut (Alt + H)
   */
  function handleKeyDownEvent(event) {
    const target = event.target;
    const key = typeof event.key === "string" ? event.key : "";
    if (!key) return;

    inputRecorder.markUserTouched(target);

    // Keydown can be dispatched at the document when nothing is focused, and the
    // analyzer only understands elements.
    const elementTarget = target instanceof Element ? target : null;

    // Manual Hover Shortcut: Alt + H
    if (event.altKey && key.toLowerCase() === "h") {
      const hoverTarget = lastHoveredElement || elementTarget;
      const interactableHoverTarget = hoverTarget
        ? getInteractableTarget(hoverTarget) || hoverTarget
        : null;
      // Only swallow the chord when a hover step is actually produced, so pages
      // that bind Alt+H keep working whenever the recorder has nothing to log.
      if (!interactableHoverTarget || !window.SemanticElementAnalyzer) return;

      event.preventDefault();
      event.stopPropagation();
      recordAction({
        type: "hover",
        target: window.SemanticElementAnalyzer.analyze(interactableHoverTarget)
      });
      lastHoveredElementRecorded = interactableHoverTarget;
      console.log("[Workflow Recorder] Manually recorded hover step for:", interactableHoverTarget);
      return;
    }

    if (key === "Enter" || key === "Tab" || key === "Escape") {
      // Flush active typing before capturing standard hotkeys.
      inputRecorder.flush();

      if (!elementTarget || !window.SemanticElementAnalyzer) return;
      recordAction({
        type: "pressKey",
        target: window.SemanticElementAnalyzer.analyze(elementTarget),
        key: key
      });

      inputRecorder.scheduleCommittedCheck();
    }
  }

  // Force clean up debounce timers on window unload
  window.addEventListener("beforeunload", () => {
    inputRecorder.flush();
  });

})();
