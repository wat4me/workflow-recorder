const assert = require("node:assert/strict");
const test = require("node:test");

async function loadMapper() {
  const module = await import(`../background/capture/screenshots.js?t=${Math.random()}`);
  return module.mapHighlightRect;
}

test("maps a top-viewport target into a higher-resolution screenshot", async () => {
  const mapHighlightRect = await loadMapper();
  const result = mapHighlightRect({
    x: 100,
    y: 50,
    width: 200,
    height: 40,
    viewportWidth: 1000,
    viewportHeight: 500,
    coordinateSpace: "top-viewport"
  }, 2000, 1000);

  assert.deepEqual(result, {
    x: 188,
    y: 88,
    width: 424,
    height: 104,
    scaleX: 2,
    scaleY: 2
  });
});

test("clips partially visible targets and skips unsafe frame-local coordinates", async () => {
  const mapHighlightRect = await loadMapper();
  assert.deepEqual(mapHighlightRect({
    x: -20,
    y: 90,
    width: 50,
    height: 30,
    viewportWidth: 100,
    viewportHeight: 100,
    coordinateSpace: "top-viewport"
  }, 300, 200), {
    x: 0,
    y: 168,
    width: 108,
    height: 32,
    scaleX: 3,
    scaleY: 2
  });

  assert.equal(mapHighlightRect({
    x: 10,
    y: 10,
    width: 20,
    height: 20,
    viewportWidth: 100,
    viewportHeight: 100,
    coordinateSpace: "frame-viewport"
  }, 100, 100), null);
});

test("recording a before frame preserves JPEG bytes without decoding or painting", async () => {
  const { createScreenshotManager } = await import("../background/capture/screenshots.js");
  const previous = globalThis.createImageBitmap;
  globalThis.createImageBitmap = () => assert.fail("recording must not decode a before frame");
  let stored;
  try {
    const manager = createScreenshotManager({ mediaStore: { putBlob: async (_, blob) => { stored = blob; } } });
    const input = Buffer.from([255, 216, 1, 2, 255, 217]);
    await manager.storeFrameBlob("raw", { data: input.toString("base64") }, {
      coordinateSpace: "top-viewport", x: 10, y: 20, width: 30, height: 40, viewportWidth: 100, viewportHeight: 100
    });
    assert.deepEqual(Buffer.from(await stored.arrayBuffer()), input);
  } finally { globalThis.createImageBitmap = previous; }
});
