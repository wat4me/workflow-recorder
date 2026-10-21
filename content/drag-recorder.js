/** Pointer, mouse and native HTML5 drag state machine. */
(function () {
  if (globalThis.RecorderDragRecorder) return;

  const DRAG_THRESHOLD_PX = 8;
  const MAX_DRAG_PATH_POINTS = 24;

  function create({ isRecording, recordAction, getInteractableTarget }) {
    const {
      getDragSourceElement,
      getDragTargetElement,
      makePointerPoint
    } = globalThis.RecorderTargeting;
    let activeDrag = null;
    let mouseDrag = null;
    let nativeDrag = null;
    let suppressClickUntil = 0;

    function dragEvidence(element) {
      const control = element.closest('[draggable="true"],.drag-item,input[type="range"],[role="slider"],[aria-grabbed="true"],canvas');
      const cursor = window.getComputedStyle(element).cursor;
      return !!control || /^(?:grab|grabbing|move|(?:[nesw]{1,2}|col|row|ew|ns|nesw|nwse)-resize)$/.test(cursor);
    }

    function beginDrag(event) {
      const sourceElement = getDragSourceElement(event.target);
      return {
        sourceElement,
        draggableControl: dragEvidence(sourceElement),
        rect: sourceElement.getBoundingClientRect(),
        parent: sourceElement.parentNode,
        nextSibling: sourceElement.nextSibling,
        viewport: { width: window.innerWidth, height: window.innerHeight, x: window.scrollX, y: window.scrollY },
        startTime: Date.now(),
        start: makePointerPoint(event, sourceElement),
        path: [makePointerPoint(event, sourceElement)],
        dragging: false,
        lastSampleAt: 0
      };
    }

    function handlePointerDown(event) {
      if (!isRecording() || event.button !== 0 || event.pointerType === "touch") return;
      if (!(event.target instanceof Element)) return;
      if (event.target === document.documentElement || event.target === document.body) return;
      suppressClickUntil = 0;
      activeDrag = { ...beginDrag(event), pointerId: event.pointerId };
    }

    function handlePointerMove(event) {
      if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
      updateDragState(activeDrag, event);
    }

    function handlePointerUp(event) {
      if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
      const drag = activeDrag;
      activeDrag = null;
      mouseDrag = null;
      completePointerDrag(drag, event);
    }

    function handlePointerCancel(event) {
      if (activeDrag?.pointerId !== event.pointerId) return;
      if (!mouseDrag) mouseDrag = activeDrag;
      activeDrag = null;
    }

    function handleMouseDown(event) {
      if (!isRecording() || event.button !== 0 || !(event.target instanceof Element)) return;
      if (event.target === document.documentElement || event.target === document.body) return;
      suppressClickUntil = 0;
      mouseDrag = beginDrag(event);
    }

    function handleMouseMove(event) {
      updateDragState(mouseDrag, event);
    }

    function handleMouseUp(event) {
      if (!mouseDrag || event.button !== 0) return;
      const drag = mouseDrag;
      mouseDrag = null;
      activeDrag = null;
      completePointerDrag(drag, event);
    }

    function updateDragState(drag, event) {
      if (!drag) return;
      const distance = Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y);
      if (!drag.dragging && distance >= DRAG_THRESHOLD_PX) drag.dragging = true;
      if (!drag.dragging || drag.path.length >= MAX_DRAG_PATH_POINTS) return;
      const now = Date.now();
      if (now - drag.lastSampleAt < 30) return;
      drag.lastSampleAt = now;
      drag.path.push(makePointerPoint(event, drag.sourceElement));
    }

    function completePointerDrag(drag, event) {
      if (!drag?.dragging || !window.SemanticElementAnalyzer) return;
      const selection = window.getSelection();
      const isDraggableControl = drag.sourceElement.closest([
        '[draggable="true"]',
        ".drag-item",
        'input[type="range"]',
        '[role="slider"]'
      ].join(","));
      if (selection && !selection.isCollapsed && !isDraggableControl) {
        suppressClickUntil = Date.now() + 300;
        return;
      }
      const rawDropElement = document.elementFromPoint(event.clientX, event.clientY) || event.target;
      recordCompletedDrag(drag, event, rawDropElement);
    }

    function handleNativeDragStart(event) {
      if (!isRecording() || !(event.target instanceof Element)) return;
      nativeDrag = { ...beginDrag(event), dragging: true, native: true };
      activeDrag = null;
      mouseDrag = null;
    }

    function handleNativeDragOver(event) {
      if (!nativeDrag || nativeDrag.path.length >= MAX_DRAG_PATH_POINTS) return;
      const now = Date.now();
      if (now - nativeDrag.lastSampleAt < 30) return;
      nativeDrag.lastSampleAt = now;
      nativeDrag.path.push(makePointerPoint(event, nativeDrag.sourceElement));
    }

    function handleNativeDrop(event) {
      if (!nativeDrag) return;
      const drag = nativeDrag;
      nativeDrag = null;
      recordCompletedDrag(drag, event, event.target);
    }

    function handleNativeDragEnd(event) {
      if (!nativeDrag) return;
      const drag = nativeDrag;
      nativeDrag = null;
      const target = document.elementFromPoint(event.clientX, event.clientY) || event.target;
      recordCompletedDrag(drag, event, target);
    }

    function recordCompletedDrag(drag, event, rawTarget) {
      if (!window.SemanticElementAnalyzer) return;
      const sourceElement = getDragSourceElement(drag.sourceElement) || drag.sourceElement;
      const rect = sourceElement.getBoundingClientRect();
      const sameViewport = drag.viewport.width === window.innerWidth && drag.viewport.height === window.innerHeight &&
        drag.viewport.x === window.scrollX && drag.viewport.y === window.scrollY;
      const moved = !sourceElement.isConnected || sourceElement.parentNode !== drag.parent || sourceElement.nextSibling !== drag.nextSibling ||
        (sameViewport && Math.hypot(rect.x - drag.rect.x, rect.y - drag.rect.y) >= 2);
      suppressClickUntil = Date.now() + 500;
      if (!drag.native && !drag.draggableControl && !moved) {
        globalThis.WorkflowRecorderProtocol?.recordingDebug("drag-filtered", {
          source: globalThis.WorkflowRecorderProtocol.debugElement(sourceElement), reason: "no-drag-evidence",
          distance: Math.round(Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y))
        });
        return;
      }
      const stableRawTarget = getDragTargetElement(rawTarget) || rawTarget;
      const targetElement = getInteractableTarget(stableRawTarget) || stableRawTarget;
      const end = makePointerPoint(event, targetElement);
      drag.path.push(end);
      suppressClickUntil = Date.now() + 500;
      globalThis.WorkflowRecorderProtocol?.recordingDebug("drag-recorded", {
        source: globalThis.WorkflowRecorderProtocol.debugElement(sourceElement),
        target: globalThis.WorkflowRecorderProtocol.debugElement(targetElement),
        distance: Math.round(Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y)),
        threshold: DRAG_THRESHOLD_PX,
        draggableControl: drag.draggableControl, moved, native: !!drag.native
      });
      recordAction({
        type: "drag",
        source: window.SemanticElementAnalyzer.analyze(sourceElement),
        target: window.SemanticElementAnalyzer.analyze(targetElement),
        start: drag.start,
        end,
        duration: Date.now() - drag.startTime,
        path: drag.path
      });
    }

    function reset() {
      activeDrag = null;
      mouseDrag = null;
      nativeDrag = null;
    }

    return {
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      handleNativeDragEnd,
      handleNativeDragOver,
      handleNativeDragStart,
      handleNativeDrop,
      handlePointerCancel,
      handlePointerDown,
      handlePointerMove,
      handlePointerUp,
      reset,
      shouldSuppressClick: () => Date.now() < suppressClickUntil
    };
  }

  globalThis.RecorderDragRecorder = { create };
})();
