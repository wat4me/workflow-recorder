/** Side-panel preferences, independent of recording and saved-case data. */
(function () {
  if (globalThis.RecorderStepDisplaySettings) return;
  const STEP_DISPLAY_SETTINGS_KEY = "stepDisplaySettings";
  const normalize = value => ({ screenshotsExpanded: value?.screenshotsExpanded !== false });
  globalThis.RecorderStepDisplaySettings = { STEP_DISPLAY_SETTINGS_KEY, normalize };
})();
