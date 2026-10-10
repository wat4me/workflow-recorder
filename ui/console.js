/** Fullscreen library for saved recordings and read-only step previews. */
import { createConsoleImagePreview } from "./app/console-image-preview.js";
import { createConsolePreview } from "./app/console-preview.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;

document.addEventListener("DOMContentLoaded", async () => {
  await window.RecorderI18n.ready;
  window.RecorderI18n.applyI18n();
  window.RecorderI18n.bindLanguageToggle(document.getElementById("language-btn"));
  const { t } = window.RecorderI18n;
  const { getBlob, sendRuntimeMessage } = window.RecorderBridge;
  const { notify, reportError } = window.RecorderDialogs;

  document.getElementById("capture-settings-btn").addEventListener("click", async () => {
    if (await window.RecorderSettingsDialog.openCaptureSettings()) {
      notify(t("captureSettingsSaved", [], "录制设置已保存，下次开始录制时生效"));
    }
  });

  const params = new URLSearchParams(window.location.search);
  params.delete("view");
  params.delete("caseTab");
  params.delete("jobId");
  const cleanedUrl = new URL(window.location.href);
  cleanedUrl.search = params.toString();
  history.replaceState(null, "", cleanedUrl.href);

  const libraryPanel = document.getElementById("case-library-panel");
  const previewPanel = document.getElementById("preview-panel");
  let currentView = "library";
  let preview;

  function setView(next) {
    if (currentView === next) return;
    if (currentView === "preview") preview.disposePreview();
    currentView = next;
    libraryPanel.hidden = next !== "library";
    previewPanel.hidden = next !== "preview";
    const url = new URL(window.location.href);
    if (next !== "preview") url.searchParams.delete("caseId");
    history.replaceState(null, "", url.href);
  }

  const imagePreview = createConsoleImagePreview({ t, getBlob, sendRuntimeMessage, MESSAGE });
  preview = createConsolePreview({ t, sendRuntimeMessage, MESSAGE, notify, reportError, setView });
  const workbench = window.RecorderCaseWorkbench.create({
    list: document.getElementById("case-library-list"),
    emptyState: document.getElementById("case-library-empty"),
    countBadge: document.getElementById("case-library-count"),
    allCasesButton: document.getElementById("all-cases-btn"),
    locationTitle: document.getElementById("library-location-title"),
    locationMeta: document.getElementById("library-location-meta"),
    actionbar: document.querySelector(".library-actionbar"),
    selectionLabel: document.getElementById("case-selection-count"),
    searchInput: document.getElementById("case-search-input"),
    searchScope: document.getElementById("case-search-scope"),
    selectAll: document.getElementById("case-library-select-all"),
    folderList: document.getElementById("case-folder-list"),
    createFolderButton: document.getElementById("create-case-folder-btn"),
    moveToFolderButton: document.getElementById("move-cases-folder-btn"),
    importButton: document.getElementById("import-case-package-btn"),
    exportPackageButton: document.getElementById("export-case-package-btn"),
    exportDocumentsButton: document.getElementById("batch-export-cases-btn"),
    deleteCasesButton: document.getElementById("batch-delete-cases-btn"),
    fileInput: document.getElementById("case-package-file-input"),
    onOpenCase: summary => preview.showCasePreview(summary).catch(error => reportError(error.message))
  });

  window.addEventListener("unload", () => {
    imagePreview.dispose();
    workbench.dispose();
    preview.previewStepView.dispose();
  });

  await workbench.refresh().catch(error => reportError(error.message));
  if (params.get("caseId")) {
    await preview.showCasePreview({ id: params.get("caseId") }).catch(error => reportError(error.message));
  }
  if (params.get("previewKey")) {
    const previewKey = params.get("previewKey");
    await imagePreview.loadPreviewSequence(previewKey);
    await imagePreview.showConsoleImagePreview(
      previewKey,
      params.get("previewAlt") || t("stepScreenshots", [], "步骤截图")
    );
  }
});
