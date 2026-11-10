import "../../shared/screenshot-geometry.js";
import { addTargetHighlight } from "../../background/capture/image-processing.js";

const { mapHighlightRect } = globalThis.RecorderScreenshotGeometry;
const MAX_THUMBNAIL_JOBS = 2;
let activeThumbnails = 0;
const thumbnailWaiters = [];
const pending = new Map();

// Two resize jobs at a time, like the screenshot capture queue: one leaves the
// main thread for the other, so a fast scroll no longer queues thumbnails up
// behind each other one by one. Finished thumbnails live on disk, not in a
// growing in-memory cache; the caller owns the short-lived Blob/object URL.
function acquireThumbnailSlot() {
  return new Promise(resolve => {
    const grant = () => {
      activeThumbnails++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        activeThumbnails--;
        thumbnailWaiters.shift()?.();
      });
    };
    if (activeThumbnails < MAX_THUMBNAIL_JOBS) grant();
    else thumbnailWaiters.push(grant);
  });
}

async function getThumbnail(key) {
  const store = globalThis.RecorderMediaStore;
  const cached = await store.getThumbnail(key);
  if (cached) return cached;
  if (pending.has(key)) return pending.get(key);
  const task = (async () => {
    const release = await acquireThumbnailSlot();
    try {
      const retried = await store.getThumbnail(key);
      if (retried) return retried;
      const source = await store.getBlob(key);
      if (!source) return null;
      let bitmap;
      let canvas;
      try {
        bitmap = await createImageBitmap(source, { resizeWidth: 320, resizeQuality: "high" });
        const scale = Math.min(1, 320 / bitmap.width, 320 / bitmap.height);
        canvas = new OffscreenCanvas(Math.max(1, Math.round(bitmap.width * scale)),
          Math.max(1, Math.round(bitmap.height * scale)));
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        const thumbnail = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
        // Cleanup cannot delete the source between this check and publication.
        await store.withWriteLock(async () => {
          if (await store.getBlob(key)) await store.putThumbnail(key, thumbnail);
        });
        return thumbnail;
      } catch (error) {
        console.warn("[Thumbnails] Resize failed:", error.message);
        return source;
      } finally {
        bitmap?.close();
        if (canvas) canvas.width = canvas.height = 1;
      }
    } finally {
      release();
    }
  })();
  pending.set(key, task);
  try { return await task; }
  finally { if (pending.get(key) === task) pending.delete(key); }
}

// Match the image's object-fit area, including letterboxing. The same SVG can
// accompany a thumbnail or share the original image's zoom/pan transform.
function createHighlightOverlay(image) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("screenshot-highlight");
  svg.setAttribute("aria-hidden", "true");
  const rect = document.createElementNS(svg.namespaceURI, "rect");
  svg.append(rect);
  let box = null;
  function update(next) {
    box = next || null;
    const width = image.naturalWidth, height = image.naturalHeight;
    const mapped = mapHighlightRect(box, width, height);
    svg.hidden = !mapped;
    svg.style.display = mapped ? "block" : "none";
    if (!mapped) return;
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("preserveAspectRatio", "xMinYMin meet");
    const line = Math.max(3, Math.min(7, 4 * Math.max(mapped.scaleX, mapped.scaleY)));
    rect.setAttribute("x", mapped.x + line / 2);
    rect.setAttribute("y", mapped.y + line / 2);
    rect.setAttribute("width", Math.max(1, mapped.width - line));
    rect.setAttribute("height", Math.max(1, mapped.height - line));
    rect.setAttribute("fill", "rgba(239,68,68,0.10)");
    rect.setAttribute("stroke", "#ef4444");
    rect.setAttribute("stroke-width", line);
  }
  image.addEventListener("load", () => update(box));
  return { element: svg, update };
}

globalThis.RecorderScreenshotMedia = { getThumbnail, createHighlightOverlay, addTargetHighlight };
