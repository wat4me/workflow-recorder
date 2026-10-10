/**
 * How a step card words a missing screenshot.
 *
 * Two different situations used to render as the same bare "no screenshot": a
 * step that opened a child window, which was never going to have a frame of its
 * own, and a step whose page was closed before the frame could be taken. The
 * card is the only place a user can tell them apart.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { pathToFileURL } = require("node:url");

async function loadMedia({ screenshotNoteVisible = false } = {}) {
  // A fresh query string per load: the module keeps no state, but Node caches by
  // specifier, and each test wants its own ctx object back.
  const href = pathToFileURL(path.join(__dirname, "..", "ui", "app", "step-media.js")).href;
  const module = await import(`${href}?t=${Math.random()}`);
  const ctx = {
    t: (key, substitutions, fallback) => fallback,
    stepsContainer: {
      classList: { contains: className => screenshotNoteVisible && className === "screenshots-disabled" }
    },
    CAPTURE_LABELS: {
      pending: () => "等待截图",
      skipped: () => "无需截图",
      failed: () => "无截图",
      "recapture-failed": () => "重拍失败，仍显示上次截图"
    },
    CAPTURE_REASON_LABELS: {
      pageClosed: () => "页面已关闭",
      workerRestart: () => "后台重启中断"
    },
    SKIPPED_REASON_LABELS: {
      "opens-child-page": () => "点击打开了新页面"
    }
  };
  globalThis.window = { RecorderCaptureState: { CAPTURE_DISABLED_REASON: "capture-disabled" } };
  module.attachStepMedia(ctx);
  return ctx;
}

/** Renders one step's status tag and returns its wording. */
function labelFor(ctx, action, captureState) {
  const entry = { statusTag: {} };
  ctx.syncCaptureState(entry, action, captureState);
  return entry.statusTag.textContent;
}

test("a step that opened a child page says the frame was never expected", async () => {
  const ctx = await loadMedia();
  const label = labelFor(ctx, { screenshotSkippedReason: "opens-child-page" }, "skipped");
  assert.equal(label, "无需截图 · 点击打开了新页面");
});

test("a step whose page was closed shows the cause, not a bare failure", async () => {
  const ctx = await loadMedia();
  const label = labelFor(ctx, { screenshotErrorReason: "pageClosed" }, "failed");
  assert.equal(label, "无截图 · 页面已关闭");
});

test("the cause is the reason code rather than the raw pipeline message", async () => {
  const ctx = await loadMedia();
  // markUnavailable also stores a longer message; the stable code wins so the
  // wording survives a language switch.
  const label = labelFor(ctx, {
    screenshotErrorReason: "workerRestart",
    screenshotError: "message port closed before a response was received"
  }, "failed");
  assert.equal(label, "无截图 · 后台重启中断");
});

test("an unrecognised cause falls back to the stored message", async () => {
  const ctx = await loadMedia();
  const label = labelFor(ctx, { screenshotError: "步骤截图不可用" }, "failed");
  assert.equal(label, "无截图 · 步骤截图不可用");
});

test("a failure with no cause stays a plain failure", async () => {
  const ctx = await loadMedia();
  assert.equal(labelFor(ctx, {}, "failed"), "无截图");
});

test("a session recorded without screenshots names that, not the step", async () => {
  const ctx = await loadMedia();
  // Suppressed on the card because the panel already says it above the list.
  const suppressed = labelFor(ctx, { screenshotSkippedReason: "capture-disabled" }, "skipped");
  assert.equal(suppressed, "录制时未启用截图");
});

test("a captured step carries no capture wording at all", async () => {
  const ctx = await loadMedia();
  const entry = { statusTag: {} };
  // A step with a screenshot is never reported as missing one, whatever flags it
  // still carries from an earlier failed or skipped attempt.
  ctx.syncCaptureState(entry, { screenshotKey: "screenshot:1", screenshotErrorReason: "pageClosed" }, "captured");
  assert.equal(entry.statusTag.textContent, "");
  assert.equal(entry.statusTag.hidden, true);
});
