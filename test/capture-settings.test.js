const assert = require("node:assert/strict");
const test = require("node:test");

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    local: {
      get: async keys => {
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(list.filter(key => key in data).map(key => [key, data[key]]));
      },
      set: async values => { Object.assign(data, values); }
    }
  };
}

async function loadModule(storage) {
  globalThis.chrome = { storage: { local: storage.local } };
  return import(`../shared/capture-settings.js?t=${Math.random()}`);
}

test("the default plan captures, and asks for no scaling", async () => {
  const settings = await loadModule(createStorage());

  const plan = settings.capturePlanFor(undefined);
  assert.equal(plan.screenshots, true);
  assert.equal(plan.frameStride, settings.CAPTURE_FRAME_STRIDE);
  // Native resolution is the only mode left. A scaling ceiling used to come from a
  // sharpness preset, and asking for one is exactly what those presets could not
  // justify: measured against itself, a preset varied by more than the gap between
  // presets.
  assert.equal("maxLongEdge" in plan, false);
  assert.equal("jpegQuality" in plan, false);
});

test("turning screenshots off opens no screencast at all", async () => {
  const settings = await loadModule(createStorage());

  assert.equal(settings.capturePlanFor({ screenshots: false }).screenshots, false);
});

test("a sharpness preset written by an earlier build is ignored", async () => {
  const settings = await loadModule(createStorage());

  // Profiles in the wild still hold one. There is nothing left for it to mean, and
  // carrying it forward would keep writing a field nothing reads.
  assert.deepEqual(
    settings.normalizeCaptureSettings({ screenshots: true, quality: "low" }),
    { screenshots: true }
  );
  // Only an explicit `false` disables screenshots, so a missing or corrupt record
  // keeps the feature the user already had.
  assert.equal(settings.normalizeCaptureSettings({}).screenshots, true);
  assert.equal(settings.normalizeCaptureSettings({ screenshots: "no" }).screenshots, true);
  assert.equal(settings.capturePlanFor({ quality: "ultra" }).screenshots, true);
});

test("settings round-trip through storage", async () => {
  const storage = createStorage();
  const settings = await loadModule(storage);

  await settings.writeCaptureSettings({ screenshots: false, quality: "low" });
  assert.deepEqual(storage.data[settings.CAPTURE_SETTINGS_KEY], { screenshots: false });
  assert.deepEqual(await settings.readCaptureSettings(), { screenshots: false });
  assert.equal(settings.capturePlanFor(await settings.readCaptureSettings()).screenshots, false);
});

test("an active recording keeps its capture policy until start or continue", async () => {
  const storage = createStorage({
    isRecording: true,
    captureSettings: { screenshots: true },
    recordingCaptureSettings: { screenshots: false }
  });
  const settings = await loadModule(storage);
  assert.equal((await settings.readRecordingCapturePlan()).screenshots, false);
  await settings.writeCaptureSettings({ screenshots: false });
  storage.data.recordingCaptureSettings = { screenshots: true };
  assert.equal((await settings.readRecordingCapturePlan()).screenshots, true);
  storage.data.isRecording = false;
  assert.equal((await settings.readRecordingCapturePlan()).screenshots, false);
});
