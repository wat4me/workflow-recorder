/** Debounces editable fields and records their committed values. */
(function () {
  if (globalThis.RecorderInputRecorder) return;

  function create({ recordAction }) {
    const { getEditableTarget, getEditableValue } = globalThis.RecorderTargeting;
    const activeTimers = new Map();
    let lastKnownValues = new WeakMap();
    let userTouchedInputs = new WeakSet();
    const committedTimers = new Set();
    let lastUserTouchedInput = null;
    let clickClear = null;

    function inputValue(editable) {
      const value = getEditableValue(editable);
      // Editors use zero-width fillers to keep an empty paragraph editable.
      // Normalize only filler-only values, never characters inside real text
      // (including joiners in emoji/languages) or deliberate ordinary spaces.
      return /[\u200B\uFEFF]/.test(value) && !value.replace(/[\u200B\uFEFF]/g, "").trim() ? "" : value;
    }

    function markUserTouched(element, beforeChange = true) {
      const editable = getEditableTarget(element);
      if (!editable) return;
      if (beforeChange && !lastKnownValues.has(editable)) lastKnownValues.set(editable, inputValue(editable));
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
      const value = inputValue(editable);
      if (value === "" && clickClear?.target === editable && clickClear.confirm()) {
        // The click already accounts for this clear. Update the baseline so
        // later blur and commit checks do not emit a second step.
        clickClear = null;
        lastKnownValues.set(editable, value);
        return;
      }
      const previous = lastKnownValues.get(editable);
      if (previous === value) return;
      lastKnownValues.set(editable, value);
      if (previous === undefined && value === "") return;
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

    function scheduleCommittedCheck(confirmClickClear) {
      if (confirmClickClear) flushClickClear();
      const target = lastTouchedInput();
      if (!target) return;
      let observedClick = null;
      if (confirmClickClear) {
        if (activeTimers.has(target)) flushTarget(target);
        if (inputValue(target) !== "") {
          observedClick = clickClear = { target, confirm: confirmClickClear };
        }
      }
      [0, 150].forEach(delay => {
        const timer = setTimeout(() => {
          committedTimers.delete(timer);
          flushTarget(target);
          if (delay === 150 && clickClear === observedClick) clickClear = null;
        }, delay);
        committedTimers.add(timer);
      });
    }

    function flush() {
      flushClickClear();
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
      lastKnownValues = new WeakMap();
      userTouchedInputs = new WeakSet();
      lastUserTouchedInput = null;
      clickClear = null;
    }

    function handleBeforeInput(event) {
      if (!event.isTrusted) return;
      if (clickClear?.target === getEditableTarget(event.target)) flushClickClear();
      markUserTouched(event.target);
    }

    function flushClickClear() {
      if (!clickClear) return;
      flushTarget(clickClear.target);
      clickClear = null;
    }

    function handleFocus(event) {
      const target = getEditableTarget(event.target);
      if (clickClear?.target === target && inputValue(target) === "") recordValue(target);
      // Focus captures the old value without treating script-driven focus as
      // user input. Do not overwrite a value still awaiting its typing commit.
      if (target && !activeTimers.has(target)) lastKnownValues.set(target, inputValue(target));
    }

    function handleInput(event) {
      // Composition events carry intermediate text; the input event after
      // compositionend commits the value the user actually produced.
      if (!event.isTrusted || event.isComposing) return;
      const target = getEditableTarget(event.target);
      if (!target) return;
      // A trusted input event is a separate edit, including native clears.
      if (clickClear?.target === target) clickClear = null;
      markUserTouched(target, false);
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
        // A cascading form control updates its neighbouring selects from script;
        // only the user's own choice may become a step.
        if (!event.isTrusted) return;
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
        if (!event.isTrusted) return;
        markUserTouched(target, false);
        flushTarget(target);
      }
    }

    return {
      flush,
      flushClickClear,
      reset,
      handleBeforeInput,
      handleFocus,
      handleBlur,
      handleChange,
      handleInput,
      markUserTouched,
      scheduleCommittedCheck
    };
  }

  globalThis.RecorderInputRecorder = { create };
})();
