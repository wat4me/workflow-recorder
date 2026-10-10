/** Fullscreen workbench screenshot overlay and keyboard navigation. */
export function createConsoleImagePreview({ t, getBlob, sendRuntimeMessage, MESSAGE }) {
  const imagePreview = document.getElementById("console-image-preview");
  const previewStage = document.getElementById("console-preview-stage");
  const previewImage = document.getElementById("console-preview-image");
  const previewLoading = document.getElementById("console-preview-loading");
  const previewTitle = document.getElementById("console-preview-title");
  const previewZoomLabel = document.getElementById("console-zoom-label");
  const previewPreviousButton = document.getElementById("console-prev-image");
  const previewNextButton = document.getElementById("console-next-image");
  const PREVIEW_SEQUENCE_KEY = "recorderImagePreviewSequence";

  let previewObjectUrl = "";
  let previewScale = 1;
  let previewX = 0;
  let previewY = 0;
  let previewDrag = null;
  let previewSequence = [];
  let previewIndex = -1;
  let previewLoadId = 0;

  function renderPreviewTransform() {
    previewImage.style.transform = `translate(${previewX}px, ${previewY}px) scale(${previewScale})`;
    previewZoomLabel.textContent = `${Math.round(previewScale * 100)}%`;
  }

  function fitPreviewImage() {
    if (!previewImage.naturalWidth || !previewImage.naturalHeight) return;
    const padding = 32;
    previewScale = Math.min(
      1,
      (previewStage.clientWidth - padding * 2) / previewImage.naturalWidth,
      (previewStage.clientHeight - padding * 2) / previewImage.naturalHeight
    );
    previewX = (previewStage.clientWidth - previewImage.naturalWidth * previewScale) / 2;
    previewY = (previewStage.clientHeight - previewImage.naturalHeight * previewScale) / 2;
    renderPreviewTransform();
  }

  function setPreviewZoom(nextScale, clientX = previewStage.clientWidth / 2, clientY = previewStage.clientHeight / 2) {
    nextScale = Math.max(0.1, Math.min(8, nextScale));
    const rect = previewStage.getBoundingClientRect();
    const pointX = clientX - rect.left;
    const pointY = clientY - rect.top;
    const imageX = (pointX - previewX) / previewScale;
    const imageY = (pointY - previewY) / previewScale;
    previewScale = nextScale;
    previewX = pointX - imageX * previewScale;
    previewY = pointY - imageY * previewScale;
    renderPreviewTransform();
  }

  async function showConsoleImagePreview(screenshotKey, alt) {
    const loadId = ++previewLoadId;
    imagePreview.hidden = false;
    previewTitle.textContent = alt;
    previewImage.alt = alt;
    previewLoading.textContent = t("loadingScreenshot", [], "正在读取截图…");
    previewLoading.style.display = "flex";
    previewImage.style.display = "none";

    const blob = await getBlob(screenshotKey);
    if (loadId !== previewLoadId) return;
    if (!blob) {
      previewLoading.textContent = t("missingScreenshot", [], "截图不存在或已被清理");
      return;
    }
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = URL.createObjectURL(blob);
    previewImage.onload = () => {
      previewLoading.style.display = "none";
      previewImage.style.display = "block";
      fitPreviewImage();
    };
    previewImage.src = previewObjectUrl;
  }

  function updatePreviewNavigation() {
    previewPreviousButton.disabled = previewIndex <= 0;
    previewNextButton.disabled = previewIndex < 0 || previewIndex >= previewSequence.length - 1;
  }

  function setPreviewSequence(items, screenshotKey) {
    const seen = new Set();
    previewSequence = (Array.isArray(items) ? items : []).filter(item => {
      if (typeof item?.key !== "string" || !item.key || seen.has(item.key)) return false;
      seen.add(item.key);
      return true;
    });
    previewIndex = previewSequence.findIndex(item => item.key === screenshotKey);
    updatePreviewNavigation();
  }

  async function loadPreviewSequence(screenshotKey) {
    const stored = await chrome.storage.session.get(PREVIEW_SEQUENCE_KEY).catch(() => ({}));
    const items = stored[PREVIEW_SEQUENCE_KEY]?.items;
    setPreviewSequence(items, screenshotKey);
    if (previewIndex >= 0) return;

    const response = await sendRuntimeMessage({ action: MESSAGE.getActions }).catch(() => null);
    const fallback = (response?.actions || []).flatMap((action, index) => [
      action.screenshotBeforeKey
        ? { key: action.screenshotBeforeKey, alt: window.StepDocGenerator.screenshotTitle(action, index, "before") }
        : null,
      action.screenshotKey
        ? { key: action.screenshotKey, alt: window.StepDocGenerator.screenshotTitle(action, index, "after") }
        : null
    ]).filter(Boolean);
    setPreviewSequence(fallback, screenshotKey);
  }

  function navigatePreview(direction) {
    const nextIndex = previewIndex + direction;
    if (imagePreview.hidden || nextIndex < 0 || nextIndex >= previewSequence.length) return false;

    previewIndex = nextIndex;
    updatePreviewNavigation();
    const item = previewSequence[previewIndex];
    const url = new URL(window.location.href);
    url.searchParams.set("previewKey", item.key);
    url.searchParams.set("previewAlt", item.alt);
    history.replaceState(null, "", url.href);
    showConsoleImagePreview(item.key, item.alt);
    return true;
  }

  function closeConsoleImagePreview() {
    imagePreview.hidden = true;
    previewDrag = null;
    previewStage.classList.remove("is-dragging");
    const url = new URL(window.location.href);
    url.searchParams.delete("previewKey");
    url.searchParams.delete("previewAlt");
    history.replaceState(null, "", url.href);
  }

  previewStage.addEventListener("wheel", event => {
    event.preventDefault();
    setPreviewZoom(previewScale * (event.deltaY < 0 ? 1.12 : 1 / 1.12), event.clientX, event.clientY);
  }, { passive: false });
  previewStage.addEventListener("pointerdown", event => {
    if (event.button !== 0 || previewImage.style.display === "none") return;
    previewDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: previewX, y: previewY };
    previewStage.setPointerCapture(event.pointerId);
    previewStage.classList.add("is-dragging");
  });
  previewStage.addEventListener("pointermove", event => {
    if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
    previewX = previewDrag.x + event.clientX - previewDrag.startX;
    previewY = previewDrag.y + event.clientY - previewDrag.startY;
    renderPreviewTransform();
  });
  const stopPreviewDrag = event => {
    if (!previewDrag || event.pointerId !== previewDrag.pointerId) return;
    previewDrag = null;
    previewStage.classList.remove("is-dragging");
  };
  previewStage.addEventListener("pointerup", stopPreviewDrag);
  previewStage.addEventListener("pointercancel", stopPreviewDrag);
  previewStage.addEventListener("dblclick", fitPreviewImage);
  document.getElementById("console-zoom-out").addEventListener("click", () => setPreviewZoom(previewScale / 1.2));
  document.getElementById("console-zoom-in").addEventListener("click", () => setPreviewZoom(previewScale * 1.2));
  previewZoomLabel.addEventListener("click", () => {
    previewScale = 1;
    previewX = (previewStage.clientWidth - previewImage.naturalWidth) / 2;
    previewY = (previewStage.clientHeight - previewImage.naturalHeight) / 2;
    renderPreviewTransform();
  });
  document.getElementById("console-fit-image").addEventListener("click", fitPreviewImage);
  previewPreviousButton.addEventListener("click", () => navigatePreview(-1));
  previewNextButton.addEventListener("click", () => navigatePreview(1));
  document.getElementById("console-close-preview").addEventListener("click", closeConsoleImagePreview);
  window.addEventListener("keydown", event => {
    if (imagePreview.hidden) return;
    if (event.key === "Escape") {
      closeConsoleImagePreview();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      navigatePreview(event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  window.addEventListener("resize", () => {
    if (!imagePreview.hidden) fitPreviewImage();
  });

  return {
    loadPreviewSequence,
    showConsoleImagePreview,
    dispose() {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
    }
  };
}
