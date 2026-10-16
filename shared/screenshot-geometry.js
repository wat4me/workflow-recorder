(function () {
/** Converts a target rectangle in top-level CSS pixels to screenshot pixels. */
function mapHighlightRect(box, imageWidth, imageHeight) {
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


  globalThis.RecorderScreenshotGeometry = { mapHighlightRect };
})();
