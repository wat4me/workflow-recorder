/** Lazy before/after screenshots and capture-state overlays for step cards. */
export function attachStepMedia(ctx) {
  const {
    t, getBlob, openImagePreview, stepsContainer, readOnly,
    objectUrls, pendingLoads, mediaUrls, CAPTURE_LABELS, CAPTURE_REASON_LABELS, SKIPPED_REASON_LABELS
  } = ctx;
  let observer = ctx.observer || null;

  function screenshotTitle(action, index, phase) {
    if (window.StepDocGenerator?.screenshotTitle) {
      return window.StepDocGenerator.screenshotTitle(action, index, phase);
    }
    const operation = ctx.describeStep(action).desc;
    return phase === "before"
      ? `步骤 ${index + 1} · ${operation} · 操作前`
      : `步骤 ${index + 1} · ${operation} · 操作后`;
  }
  function scrollToLatestIfAppended() {
    const distanceFromBottom = stepsContainer.scrollHeight - stepsContainer.scrollTop - stepsContainer.clientHeight;
    if (distanceFromBottom <= 120) ctx.scrollToLatest();
  }
  const loading = new WeakMap();
  const highlights = new WeakMap();
  function unloadScreenshot(media) {
    const url = mediaUrls.get(media);
    if (!url && !loading.has(media)) return;
    loading.delete(media);
    if (url) {
      media.style.minHeight = `${media.getBoundingClientRect().height}px`;
      URL.revokeObjectURL(url);
      objectUrls.delete(url);
      mediaUrls.delete(media);
    }
    media.disabled = true;
    media.className = "step-media is-loading";
    media.textContent = t("loadingStepScreenshot", [], "正在读取步骤截图…");
  }
  async function loadScreenshot(media, key) {
    if (loading.has(media) || mediaUrls.has(media)) return;
    const token = {};
    loading.set(media, token);
    try {
      const blob = await globalThis.RecorderScreenshotMedia.getThumbnail(key);
      if (loading.get(media) !== token || !media.isConnected) return;
      loading.delete(media);
      if (!blob) {
        media.className = "step-media is-missing";
        media.textContent = t("stepScreenshotUnavailable", [], "无截图");
        observer?.unobserve(media);
        pendingLoads.delete(media);
        return;
      }
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      mediaUrls.set(media, url);
      const image = document.createElement("img");
      image.className = "step-screenshot";
      image.src = url;
      image.alt = media.dataset.screenshotAlt;
      const surface = document.createElement("span");
      surface.className = "screenshot-surface";
      const highlight = globalThis.RecorderScreenshotMedia.createHighlightOverlay(image);
      highlight.update(highlights.get(media));
      surface.append(image, highlight.element);
      media.className = "step-media";
      media.disabled = false;
      media.title = t("clickToZoom", [], "点击放大截图");
      media.style.minHeight = "";
      media.replaceChildren(surface);
    } finally {
      if (loading.get(media) === token) loading.delete(media);
    }
  }
  function screenshotObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          unloadScreenshot(entry.target);
          continue;
        }
        pendingLoads.get(entry.target)?.();
      }
    }, { root: stepsContainer, rootMargin: "300px" });
    ctx.observer = observer;
    return observer;
  }
  function buildMedia(key, alt, highlight = null) {
    const media = document.createElement("button");
    media.type = "button";
    media.disabled = true;
    media.className = "step-media is-loading";
    media.dataset.screenshotKey = key;
    media.dataset.screenshotAlt = alt;
    highlights.set(media, highlight);
    media.textContent = t("loadingStepScreenshot", [], "正在读取步骤截图…");
    media.addEventListener("click", async () => {
      try {
        const blob = await getBlob(key);
        if (!blob || !media.isConnected) return;
        const mediaItems = ctx.mediaSequence();
        openImagePreview(blob, media.dataset.screenshotAlt, {
          sequence: mediaItems,
          index: mediaItems.findIndex(item => item.key === key && item.alt === media.dataset.screenshotAlt), showFit: readOnly,
          highlight: highlights.get(media)
        });
      } catch (error) { console.error("[StepView] Failed to open screenshot:", error); }
    });
    pendingLoads.set(media, () => {
      loadScreenshot(media, key).then(scrollToLatestIfAppended, error => {
        console.error("[StepView] Failed to show step screenshot:", error);
      });
    });
    screenshotObserver().observe(media);
    return media;
  }
  function buildMissingMedia() {
    const media = document.createElement("div");
    media.className = "step-media is-missing";
    media.textContent = t("stepNoScreenshot", [], "无截图");
    return media;
  }
  function releaseMedia(media) {
    if (!media) return;
    observer?.unobserve(media);
    pendingLoads.delete(media);
    unloadScreenshot(media);
    media.remove();
  }
  function isFailure(captureState) {
    return captureState === "failed" || captureState === "recapture-failed";
  }
  /**
   * The cause behind a skip or a failure, as wording, or "" when there is none.
   *
   * A deliberate skip is not an error, so its reason lives under the skip code
   * rather than the error code; both are read here so a card can say which
   * applies.
   */
  function captureReasonText(action, captureState) {
    if (captureState === "skipped") {
      return SKIPPED_REASON_LABELS[action.screenshotSkippedReason]?.() || "";
    }
    if (!isFailure(captureState)) return "";
    const code = action.screenshotErrorReason;
    if (code && CAPTURE_REASON_LABELS[code]) return CAPTURE_REASON_LABELS[code]();
    return action.screenshotError || "";
  }
  /**
   * Wording for a capture state, with its cause when there is one.
   *
   * "This step opened a child window and was never going to have a screenshot"
   * and "this step's window was closed before the frame arrived" both rendered as
   * a bare "no screenshot" -- which is the one distinction a reader needs. The
   * failure cause was already computed here and then only ever used to decide
   * whether to repaint, so it is part of the label now.
   */
  function captureStateLabel(action, captureState) {
    // The reason is the whole label here: it describes the session, not the step.
    if (captureState === "skipped"
      && action.screenshotSkippedReason === window.RecorderCaptureState.CAPTURE_DISABLED_REASON) {
      return t("screenshotReasonCaptureDisabled", [], "录制时未启用截图");
    }
    const base = CAPTURE_LABELS[captureState]?.() || "";
    const reason = captureReasonText(action, captureState);
    return reason ? `${base} · ${reason}` : base;
  }
  function syncCaptureState(entry, action, captureState) {
    const failure = captureReasonText(action, captureState);
    // With every step in the list skipped for the same reason, the note above the
    // list already says it: repeating it on each card is noise, not information.
    // The suppression rides along with the reason so flipping it repaints the tag.
    const suppressed = captureState === "skipped" && stepsContainer.classList.contains("screenshots-disabled");
    const reason = failure || (suppressed ? "capture-disabled" : "");
    if (entry.captureState === captureState && entry.captureReason === reason) return;
    entry.captureState = captureState;
    entry.captureReason = reason;
    const label = suppressed ? "" : captureStateLabel(action, captureState);
    entry.statusTag.hidden = !label;
    entry.statusTag.className = `step-status-tag ${captureState}`;
    entry.statusTag.textContent = label || "";
    entry.statusTag.title = label || "";
    if (entry.afterMedia) {
      entry.afterMedia.classList.toggle("is-recapturing", captureState === "recapturing");
      entry.afterMedia.classList.toggle("is-recapture-failed", captureState === "recapture-failed");
    }
  }
  function syncMedia(entry, action, index, captureState) {
    const beforeKey = action.screenshotBeforeKey || "";
    const expanded = ctx.isMediaExpanded?.(action, index) ?? true;
    if (entry.mediaToggle) {
      const count = Number(!!beforeKey) + Number(!!action.screenshotKey);
      entry.mediaToggle.hidden = count === 0;
      entry.mediaToggle.setAttribute("aria-expanded", String(expanded));
      entry.mediaToggle.textContent = expanded
        ? t("collapseStepScreenshots", [count], `收起截图（${count}）`)
        : t("expandStepScreenshots", [count], `展开截图（${count}）`);
    }
    entry.mediaRow.hidden = !expanded;
    if (!expanded) {
      releaseMedia(entry.beforeMedia);
      releaseMedia(entry.afterMedia);
      entry.beforeMedia = entry.afterMedia = null;
      entry.beforeKey = entry.afterKey = entry.afterRenderKey = undefined;
      return;
    }
    if (entry.beforeKey !== beforeKey) {
      releaseMedia(entry.beforeMedia);
      entry.beforeMedia = null;
      entry.beforeKey = beforeKey;
      entry.beforeWrap.classList.toggle("is-hidden", !beforeKey);
      if (beforeKey) {
        entry.beforeMedia = buildMedia(beforeKey, screenshotTitle(action, index, "before"), action.screenshotBeforeHighlight);
        entry.beforeWrap.appendChild(entry.beforeMedia);
      }
    }
    const afterKey = action.screenshotKey || "";
    const showMissingAfter = !afterKey && (captureState === "skipped" || captureState === "failed");
    const afterRenderKey = afterKey || (showMissingAfter ? "__missing__" : "");
    if (entry.afterRenderKey !== afterRenderKey) {
      releaseMedia(entry.afterMedia);
      entry.afterMedia = null;
      entry.afterKey = afterKey;
      entry.afterRenderKey = afterRenderKey;
      entry.captureState = undefined;
      entry.captureReason = undefined;
      entry.afterWrap.classList.toggle("is-hidden", !afterRenderKey);
      if (afterKey) {
        entry.afterMedia = buildMedia(afterKey, screenshotTitle(action, index, "after"));
        entry.afterWrap.appendChild(entry.afterMedia);
      } else if (showMissingAfter) {
        entry.afterMedia = buildMissingMedia();
        entry.afterWrap.appendChild(entry.afterMedia);
      }
    }
    for (const [media, phase] of [[entry.beforeMedia, "before"], [entry.afterMedia, "after"]]) {
      if (!media?.dataset.screenshotKey) continue;
      const alt = screenshotTitle(action, index, phase);
      media.dataset.screenshotAlt = alt;
      const image = media.querySelector(".step-screenshot");
      if (image) image.alt = alt;
    }
    const both = !!beforeKey && !!afterRenderKey;
    entry.mediaArrow.classList.toggle("is-hidden", !both);
    entry.beforeCaption.classList.toggle("is-hidden", !both);
    entry.afterCaption.classList.toggle("is-hidden", !both);
  }

  Object.assign(ctx, { screenshotTitle, loadScreenshot, buildMedia, releaseMedia, syncCaptureState, syncMedia,
    getObserver: () => observer, setObserver: value => { observer = value; ctx.observer = value; } });
}
