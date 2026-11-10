/** Element targeting helpers shared by click, input and drag recorders. */
(function () {
  if (globalThis.RecorderTargeting) return;

  function getDragSourceElement(element) {
    if (!(element instanceof Element)) return null;
    return element.closest([
      ".drag-item",
      '[draggable="true"]',
      'input[type="range"]',
      '[role="slider"]',
      '[aria-grabbed="true"]'
    ].join(",")) || element;
  }

  function getDragTargetElement(element) {
    if (!(element instanceof Element)) return null;
    const transient = element.closest([
      ".widget-drag-placeholder",
      ".sort-position-indicator",
      ".sort-item-indicator",
      ".drop-hint"
    ].join(","));
    return transient?.parentElement || element;
  }

  function makePointerPoint(event, element) {
    const rect = element?.getBoundingClientRect();
    return {
      x: Math.round(event.clientX),
      y: Math.round(event.clientY),
      pageX: Math.round(event.pageX),
      pageY: Math.round(event.pageY),
      offsetX: rect ? Math.round(event.clientX - rect.left) : null,
      offsetY: rect ? Math.round(event.clientY - rect.top) : null
    };
  }

  function makeTopViewportPointer(event, element, boundingBox) {
    const point = makePointerPoint(event, element);
    if (boundingBox?.coordinateSpace !== "top-viewport") return point;

    const localRect = element?.getBoundingClientRect();
    if (!localRect || localRect.width <= 0 || localRect.height <= 0) return point;
    const scaleX = boundingBox.width / localRect.width;
    const scaleY = boundingBox.height / localRect.height;
    return {
      ...point,
      viewportX: Math.round(boundingBox.x + (event.clientX - localRect.x) * scaleX),
      viewportY: Math.round(boundingBox.y + (event.clientY - localRect.y) * scaleY),
      viewportWidth: boundingBox.viewportWidth,
      viewportHeight: boundingBox.viewportHeight,
      coordinateSpace: boundingBox.coordinateSpace
    };
  }

  function getInteractableTarget(element) {
    if (!(element instanceof Element)) return null;
    let current = element;
    let pointerTarget = null;
    while (current && current !== document.body && current !== document.documentElement) {
      const tag = current.tagName.toUpperCase();
      const role = (current.getAttribute("role") || "").trim().toLowerCase();
      if (
        ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "OPTION", "SUMMARY", "LABEL", "CANVAS"].includes(tag) ||
        ["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "slider"].includes(role) ||
        current.hasAttribute("onclick") ||
        current.isContentEditable
      ) return current;
      // Cursor is inherited by icons and labels. Keep it as a fallback while
      // looking for an explicit control; prefer the root of a pointer subtree.
      if (window.getComputedStyle(current).cursor === "pointer") {
        if (!pointerTarget || window.getComputedStyle(current.parentElement || current).cursor !== "pointer") {
          pointerTarget = current;
        }
      }
      current = current.parentElement;
    }
    return pointerTarget || element;
  }

  function isMeaningfulClickTarget(element) {
    // JS-bound controls can have no role, inline handler or pointer cursor.
    // Admit the element as a candidate; the worker still requires an observed
    // effect before it stores the click. Page roots remain excluded.
    return element instanceof Element && element !== document.body && element !== document.documentElement;
  }

  function hasClickSemantics(element) {
    if (!(element instanceof Element)) return false;
    const role = (element.getAttribute("role") || "").trim().toLowerCase();
    return ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT", "OPTION", "SUMMARY", "LABEL", "CANVAS"].includes(element.tagName.toUpperCase()) ||
      ["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "switch", "slider"].includes(role) ||
      element.hasAttribute("onclick") || element.isContentEditable ||
      window.getComputedStyle(element).cursor === "pointer" ||
      (element.hasAttribute("tabindex") && Number(element.getAttribute("tabindex")) >= 0);
  }

  function isRecordableTextInput(element) {
    if (!element) return false;
    const tagName = element.tagName && element.tagName.toUpperCase();
    if (tagName === "TEXTAREA") return true;
    if (tagName !== "INPUT") return false;
    const type = (element.getAttribute("type") || "text").toLowerCase();
    // Date and time pickers commit through their value like a text field; their
    // clicks produce no DOM evidence, so without this their whole interaction
    // was invisible in the recording.
    return ["text", "password", "email", "url", "tel", "number", "search",
      "date", "time", "month", "week", "datetime-local"].includes(type);
  }

  function getEditableTarget(element) {
    if (!(element instanceof Element)) return null;
    if (isRecordableTextInput(element)) return element;
    // isContentEditable covers the bare `contenteditable` attribute and value
    // case variants that an exact attribute selector misses.
    for (let current = element; current instanceof Element && current !== document.documentElement; current = current.parentElement) {
      if (current.isContentEditable) return current;
    }
    return null;
  }

  function getEditableValue(element) {
    if (!element) return "";
    if (isRecordableTextInput(element)) return element.value;
    return (element.innerText || element.textContent || "").replace(/\r\n?/g, "\n").trim();
  }

  globalThis.RecorderTargeting = {
    getDragSourceElement,
    getDragTargetElement,
    getEditableTarget,
    getEditableValue,
    getInteractableTarget,
    isMeaningfulClickTarget,
    hasClickSemantics,
    makePointerPoint,
    makeTopViewportPointer
  };
})();
