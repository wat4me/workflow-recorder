/** Debounces editable fields and records their committed values. */
(function () {
  if (globalThis.RecorderInputRecorder) return;

  function create({ recordAction }) {
    const { getEditableTarget, getEditableValue } = globalThis.RecorderTargeting;
    const activeTimers = new Map();
    let lastRecordedValues = new WeakMap();
    let userTouchedInputs = new WeakSet();
    const committedTimers = new Set();
    let lastUserTouchedInput = null;

    function markUserTouched(element) {
      const editable = getEditableTarget(element);
      if (!editable) return;
      userTouchedInputs.add(editable);
      lastUserTouchedInput = editable;
    }

    function lastTouchedInput() {
      if (lastUserTouchedInput?.isConnected) return lastUserTouchedInput;
      const activeElement = getEditableTarget(document.activeElement);
      if (activeElement && userTouchedInputs.has(activeElement)) {
        lastUserTouchedInput = activeElement;
        return activeElement;
      }
      return null;
    }

    function recordValue(target) {
      const editable = getEditableTarget(target);
      if (!editable || !userTouchedInputs.has(editable)) return;
      const value = getEditableValue(editable);
      if (lastRecordedValues.get(editable) === value) return;
      lastRecordedValues.set(editable, value);
      if (!window.SemanticElementAnalyzer) return;
      recordAction({
        type: "type",
        target: window.SemanticElementAnalyzer.analyze(editable),
        value,
        inputKind: editable.isContentEditable ? "contenteditable" : "text"
      });
    }

    function flushTarget(target) {
      const editable = getEditableTarget(target);
      if (!editable || !userTouchedInputs.has(editable)) return;
      if (activeTimers.has(editable)) {
        clearTimeout(activeTimers.get(editable));
        activeTimers.delete(editable);
      }
      recordValue(editable);
    }

    function scheduleCommittedCheck() {
      const target = lastTouchedInput();
      if (!target) return;
      [0, 150].forEach(delay => {
        const timer = setTimeout(() => {
          committedTimers.delete(timer);
          flushTarget(target);
        }, delay);
        committedTimers.add(timer);
      });
    }

    function flush() {
      for (const [target, timer] of activeTimers.entries()) {
        clearTimeout(timer);
        recordValue(target);
      }
      activeTimers.clear();
    }

    function reset() {
      for (const timer of activeTimers.values()) clearTimeout(timer);
      for (const timer of committedTimers) clearTimeout(timer);
      activeTimers.clear();
      committedTimers.clear();
      lastRecordedValues = new WeakMap();
      userTouchedInputs = new WeakSet();
      lastUserTouchedInput = null;
    }

    function handleBeforeInput(event) {
      markUserTouched(event.target);
    }

    function handleInput(event) {
      const target = getEditableTarget(event.target);
      if (!target) return;
      if (event.isTrusted) markUserTouched(target);
      if (!userTouchedInputs.has(target)) return;
      if (activeTimers.has(target)) clearTimeout(activeTimers.get(target));
      activeTimers.set(target, setTimeout(() => {
        activeTimers.delete(target);
        recordValue(target);
      }, 700));
    }

    function handleBlur(event) {
      flushTarget(event.target);
    }

    function handleChange(event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const tagName = target.tagName.toUpperCase();
      if (tagName === "SELECT") {
        if (!window.SemanticElementAnalyzer) return;
        const selectedOption = target.options[target.selectedIndex];
        recordAction({
          type: "select",
          target: window.SemanticElementAnalyzer.analyze(target),
          value: target.value,
          label: selectedOption ? selectedOption.text.trim() : ""
        });
        return;
      }
      if (tagName === "INPUT" || tagName === "TEXTAREA") {
        if (event.isTrusted) markUserTouched(target);
        flushTarget(target);
      }
    }

    return {
      flush,
      reset,
      handleBeforeInput,
      handleBlur,
      handleChange,
      handleInput,
      markUserTouched,
      scheduleCommittedCheck
    };
  }

  globalThis.RecorderInputRecorder = { create };
})();
