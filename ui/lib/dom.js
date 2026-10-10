/**
 * DOM leaf helpers. No dependencies, by design: everything else in ui/lib may
 * use this, so it must not be able to form a cycle.
 */
(function () {
  if (globalThis.RecorderDom) return;

  /**
   * Escapes text for interpolation into an innerHTML template. Uses the parser
   * rather than a regex table so it cannot miss a case.
   */
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text == null ? "" : String(text);
    return div.innerHTML;
  }

  globalThis.RecorderDom = { escapeHtml };
})();
