/** Converts a target rectangle in top-level CSS pixels to screenshot pixels. */
export function mapHighlightRect(box, imageWidth, imageHeight) {
  if (!box || box.coordinateSpace !== "top-viewport") return null;

  const values = [
    box.x,
    box.y,
    box.width,
    box.height,
    box.viewportWidth,
    box.viewportHeight,
    imageWidth,
    imageHeight
  ].map(Number);
  if (values.some(value => !Number.isFinite(value))) return null;

  const [x, y, width, height, viewportWidth, viewportHeight, bitmapWidth, bitmapHeight] = values;
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0 || bitmapWidth <= 0 || bitmapHeight <= 0) {
    return null;
  }

  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(viewportWidth, x + width);
  const bottom = Math.min(viewportHeight, y + height);
  if (right <= left || bottom <= top) return null;

  const scaleX = bitmapWidth / viewportWidth;
  const scaleY = bitmapHeight / viewportHeight;
  const padding = 6;
  const paddedLeft = Math.max(0, left - padding);
  const paddedTop = Math.max(0, top - padding);
  const paddedRight = Math.min(viewportWidth, right + padding);
  const paddedBottom = Math.min(viewportHeight, bottom + padding);

  return {
    x: paddedLeft * scaleX,
    y: paddedTop * scaleY,
    width: (paddedRight - paddedLeft) * scaleX,
    height: (paddedBottom - paddedTop) * scaleY,
    scaleX,
    scaleY
  };
}

export async function addTargetHighlight(blob, box) {
  if (!box || typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") return blob;

  let bitmap = null;
  try {
    bitmap = await createImageBitmap(blob);
    const highlight = mapHighlightRect(box, bitmap.width, bitmap.height);
    if (!highlight) return blob;

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
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
  }
}

export function base64JpegToBlob(data) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: "image/jpeg" });
}
