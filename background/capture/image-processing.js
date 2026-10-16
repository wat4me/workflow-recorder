import "../../shared/screenshot-geometry.js";
const { mapHighlightRect } = globalThis.RecorderScreenshotGeometry;
export { mapHighlightRect };

export async function addTargetHighlight(blob, box) {
  if (!box || typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return blob;

  let bitmap = null;
  let canvas = null;
  try {
    bitmap = await createImageBitmap(blob);
    const highlight = mapHighlightRect(box, bitmap.width, bitmap.height);
    if (!highlight) return blob;

    canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0);

    const lineWidth = Math.max(3, Math.min(7, 4 * Math.max(highlight.scaleX, highlight.scaleY)));
    const inset = lineWidth / 2;
    const drawWidth = Math.max(1, highlight.width - lineWidth);
    const drawHeight = Math.max(1, highlight.height - lineWidth);
    context.fillStyle = "rgba(239, 68, 68, 0.10)";
    context.fillRect(highlight.x, highlight.y, highlight.width, highlight.height);
    context.strokeStyle = "rgba(255, 255, 255, 0.95)";
    context.lineWidth = lineWidth + 3;
    context.strokeRect(highlight.x + inset, highlight.y + inset, drawWidth, drawHeight);
    context.strokeStyle = "#ef4444";
    context.lineWidth = lineWidth;
    context.strokeRect(highlight.x + inset, highlight.y + inset, drawWidth, drawHeight);
    return await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
  } catch (error) {
    console.warn("[Screenshots] Failed to add target highlight:", error.message);
    return blob;
  } finally {
    bitmap?.close?.();
    if (canvas) canvas.width = canvas.height = 1;
  }
}

export function base64JpegToBlob(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}
