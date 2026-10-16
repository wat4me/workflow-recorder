import "../../shared/screenshot-geometry.js";
import { addTargetHighlight } from "../../background/capture/image-processing.js";

const { mapHighlightRect } = globalThis.RecorderScreenshotGeometry;
let thumbnailTail = Promise.resolve();
const pending = new Map();

// Only one resize runs at a time. Finished thumbnails live on disk, not in a
// growing in-memory cache; the caller owns the short-lived Blob/object URL.
async function getThumbnail(key) {
  const store = globalThis.RecorderMediaStore;
  const cached = await store.getThumbnail(key);
  if (cached) return cached;
  if (pending.has(key)) return pending.get(key);
  const task = thumbnailTail.then(async () => {
    const cached = await store.getThumbnail(key);
    if (cached) return cached;
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
  });
  pending.set(key, task);
  thumbnailTail = task.catch(() => {});
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
