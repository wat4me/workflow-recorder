import { iconSvg } from "./icons.js";

/**
 * Full-size screenshot viewing.
 *
 * Opens screenshots in the current extension page so a side-panel preview does
 * not create another tab. The same overlay supports zooming and panning for
 * screenshots that are larger than the panel.
 */
(function () {
  if (globalThis.RecorderImagePreview) return;

  const { t } = globalThis.RecorderI18n;
  function openOverlay(blob, alt, options = {}) {
    let currentUrl = URL.createObjectURL(blob);
    let loadId = 0;
    let closed = false;
    const overlay = document.createElement("div");
    overlay.className = "image-preview-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", alt);

    const image = document.createElement("img");
    image.className = "image-preview-full";
    image.alt = alt;
    // Native image dragging cancels the pointer stream used to pan the preview.
    image.draggable = false;
    const highlight = globalThis.RecorderScreenshotMedia.createHighlightOverlay(image);
    highlight.update(options.highlight);

    const stage = document.createElement("div");
    stage.className = "image-preview-stage";
    const message = document.createElement("div");
    message.className = "image-preview-message";
    message.setAttribute("role", "status");
    message.hidden = true;
    const toolbar = document.createElement("div");
    toolbar.className = "image-preview-toolbar";
    const title = document.createElement("strong");
    title.className = "image-preview-title";
    title.textContent = alt;
    title.title = alt;
    const actions = document.createElement("div");
    actions.className = "image-preview-actions";

    const makeButton = (label, titleText) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "image-preview-tool";
      button.textContent = label;
      button.title = titleText;
      button.setAttribute("aria-label", titleText);
      return button;
    };
    const sequence = Array.isArray(options.sequence) ? options.sequence : [];
    let sequenceIndex = Number.isInteger(options.index) ? options.index : -1;
    const previous = makeButton("←", t("previousScreenshot", [], "上一张截图"));
    const next = makeButton("→", t("nextScreenshot", [], "下一张截图"));
    previous.dataset.action = "previous";
    next.dataset.action = "next";
    previous.hidden = next.hidden = sequence.length < 2;
    const zoomOut = makeButton("−", t("zoomOut", [], "缩小"));
    const zoomLabel = makeButton("100%", t("resetZoom", [], "点击恢复 100%"));
    const zoomIn = makeButton("+", t("zoomIn", [], "放大"));
    zoomOut.dataset.action = "zoom-out";
    zoomLabel.dataset.action = "reset-zoom";
    zoomIn.dataset.action = "zoom-in";
    actions.append(previous, next, zoomOut, zoomLabel, zoomIn);
    if (options.showFit !== false) {
      const fit = makeButton("⤢", t("fitWindow", [], "适应窗口"));
      fit.dataset.action = "fit";
      fit.addEventListener("click", () => fitImage());
      actions.append(fit);
    }
    toolbar.append(title, actions);

    let scale = 1;
    let x = 0;
    let y = 0;
    let drag = null;

    const updateSequenceButtons = () => {
      const hasSequence = sequence.length > 1 && sequenceIndex >= 0;
      previous.disabled = !hasSequence || sequenceIndex <= 0;
      next.disabled = !hasSequence || sequenceIndex >= sequence.length - 1;
    };

    const showItem = async index => {
      if (closed || index < 0 || index >= sequence.length) return;
      const requestId = ++loadId;
      const item = sequence[index];
      sequenceIndex = index;
      updateSequenceButtons();
      drag = null;
      stage.classList.remove("is-dragging");
      image.hidden = true;
      highlight.element.style.display = "none";
      image.removeAttribute("src");
      URL.revokeObjectURL(currentUrl);
      currentUrl = "";
      title.textContent = title.title = image.alt = item.alt;
      overlay.setAttribute("aria-label", item.alt);
      message.textContent = t("loadingScreenshot", [], "正在读取截图…");
      message.hidden = false;
      const nextBlob = await globalThis.RecorderBridge.getBlob(item.key);
      // A newer selection or a close wins over an earlier IndexedDB read.
      if (closed || requestId !== loadId) return;
      if (!nextBlob) {
        message.textContent = t("missingScreenshot", [], "截图不存在或已被清理");
        return;
      }
      currentUrl = URL.createObjectURL(nextBlob);
      highlight.update(item.highlight);
      image.src = currentUrl;
    };

    const render = () => {
      image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      Object.assign(highlight.element.style, {
        width: `${image.naturalWidth}px`, height: `${image.naturalHeight}px`,
        transform: image.style.transform
      });
      zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    };
    const fitImage = () => {
      if (!image.naturalWidth || !image.naturalHeight) return;
      const padding = 28;
      scale = Math.min(
        1,
        (stage.clientWidth - padding * 2) / image.naturalWidth,
        (stage.clientHeight - padding * 2) / image.naturalHeight
      );
      x = (stage.clientWidth - image.naturalWidth * scale) / 2;
      y = (stage.clientHeight - image.naturalHeight * scale) / 2;
      render();
    };
    const setZoom = nextScale => {
      if (image.hidden) return;
      const oldScale = scale;
      scale = Math.max(0.1, Math.min(8, nextScale));
      x += (stage.clientWidth / 2 - x) * (1 - scale / oldScale);
      y += (stage.clientHeight / 2 - y) * (1 - scale / oldScale);
      render();
    };

    image.addEventListener("load", () => {
      if (closed || !currentUrl || image.currentSrc !== currentUrl) return;
      image.hidden = false;
      message.hidden = true;
      fitImage();
    });
    image.addEventListener("error", () => {
      if (closed || !image.hasAttribute("src")) return;
      image.hidden = true;
      highlight.element.style.display = "none";
      message.textContent = t("missingScreenshot", [], "截图不存在或已被清理");
      message.hidden = false;
    });
    stage.addEventListener("wheel", event => {
      event.preventDefault();
      setZoom(scale * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    }, { passive: false });
    stage.addEventListener("pointerdown", event => {
      if (event.button !== 0 || image.hidden) return;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x, y };
      stage.setPointerCapture(event.pointerId);
      stage.classList.add("is-dragging");
    });
    stage.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      x = drag.x + event.clientX - drag.startX;
      y = drag.y + event.clientY - drag.startY;
      render();
    });
    const stopDrag = event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag = null;
      stage.classList.remove("is-dragging");
    };
    stage.addEventListener("pointerup", stopDrag);
    stage.addEventListener("pointercancel", stopDrag);
    stage.addEventListener("dblclick", fitImage);
    zoomOut.addEventListener("click", () => setZoom(scale / 1.2));
    zoomLabel.addEventListener("click", () => {
      if (image.hidden) return;
      scale = 1;
      x = (stage.clientWidth - image.naturalWidth) / 2;
      y = (stage.clientHeight - image.naturalHeight) / 2;
      render();
    });
    zoomIn.addEventListener("click", () => setZoom(scale * 1.2));
    previous.addEventListener("click", () => {
      if (sequenceIndex > 0) showItem(sequenceIndex - 1);
    });
    next.addEventListener("click", () => {
      if (sequenceIndex >= 0 && sequenceIndex < sequence.length - 1) showItem(sequenceIndex + 1);
    });

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "image-preview-close";
    closeButton.setAttribute("aria-label", t("closeScreenshotPreview", [], "关闭截图预览"));
    closeButton.title = t("closeEsc", [], "关闭（Esc）");
    closeButton.innerHTML = iconSvg("close", 18);

    const close = () => {
      closed = true;
      ++loadId;
      document.removeEventListener("keydown", onKeyDown);
      overlay.remove();
      URL.revokeObjectURL(currentUrl);
      window.removeEventListener("resize", fitImage);
    };
    const onKeyDown = event => {
      if (!["Escape", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") close();
      else if (sequenceIndex >= 0) showItem(sequenceIndex + (event.key === "ArrowLeft" ? -1 : 1));
    };

    overlay.addEventListener("click", event => {
      if (event.target === overlay) close();
    });
    closeButton.addEventListener("click", close);
    document.addEventListener("keydown", onKeyDown);
    stage.append(image, highlight.element, message);
    overlay.append(toolbar, stage, closeButton);
    document.body.appendChild(overlay);
    image.src = currentUrl;
    updateSequenceButtons();
    window.addEventListener("resize", fitImage);
    closeButton.focus();
  }

  function openImagePreview(blob, alt = t("stepScreenshots", [], "步骤截图"), options = {}) {
    if (!blob) return;
    openOverlay(blob, alt, options);
  }

  globalThis.RecorderImagePreview = { openImagePreview };
})();
