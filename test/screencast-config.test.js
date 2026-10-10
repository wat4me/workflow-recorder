const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");

test("screenshots use pushed CDP screencast frames", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const screencast = fs.readFileSync(path.join(root, "background", "capture", "screencast.js"), "utf8");
  const screenshots = fs.readFileSync(path.join(root, "background", "capture", "screenshots.js"), "utf8");
  const settings = fs.readFileSync(path.join(root, "shared", "capture-settings.js"), "utf8");
  const sourceFiles = collectSources(["background", "content", "shared", "ui"]).join("\n");

  assert.ok(manifest.permissions.includes("debugger"));
  assert.match(screencast, /Page\.startScreencast/);
  assert.match(screencast, /Page\.screencastFrameAck/);
  assert.match(screencast, /Page\.stopScreencast/);
  assert.match(screencast, /chrome\.debugger\.detach/);
  // Native viewport resolution is the only mode now. The sharpness presets that
  // could ask for a ceiling are gone, so the screencast never passes maxWidth or
  // maxHeight and a large or high-DPI window is never silently downscaled.
  assert.match(settings, /DEFAULT_CAPTURE_SETTINGS = \{ screenshots: true \}/);
  assert.doesNotMatch(settings, /maxLongEdge|jpegQuality/);
  assert.doesNotMatch(screencast, /maxWidth:|maxHeight:/);
  assert.match(screencast, /const SCREENCAST_JPEG_QUALITY = 75/);
  assert.match(screencast, /quality: SCREENCAST_JPEG_QUALITY/);
  assert.match(screencast, /everyNthFrame: Number\.isInteger\(plan\.frameStride\) \? plan\.frameStride : 2/);
  assert.match(screenshots, /screencast\.getFrame/);
  assert.match(screenshots, /screencast\.getLatestFrame/);
  // The pull-based APIs are the ones this design exists to avoid.
  assert.doesNotMatch(sourceFiles, /captureVisibleTab|Page\.captureScreenshot/);
});

test("a recording with screenshots turned off never attaches the debugger", () => {
  const session = fs.readFileSync(path.join(root, "background", "recording", "session.js"), "utf8");
  const scope = fs.readFileSync(path.join(root, "background", "recording", "scope.js"), "utf8");
  const events = fs.readFileSync(path.join(root, "background", "browser-events.js"), "utf8");
  const actionLog = fs.readFileSync(path.join(root, "background", "recording", "action-log.js"), "utf8");

  // Three places open a screencast: the session's tabs, a child tab admitted
  // mid-recording, and a page that navigates. The stream is the whole cost of the
  // feature, so all three have to consult the same plan -- a missed one would keep
  // the memory (and Chrome's debugging banner) alive for recordings that opted out.
  assert.match(session, /if \(capturePlan\.screenshots\) await screencast\.start\(tab\.id, capturePlan\)/);
  assert.match(scope, /if \(!capturePlan\.screenshots\) return;/);
  assert.match(events, /capturePlan\.screenshots && !screencast\.has\(details\.tabId\)/);
  // Steps still record; they are marked as skipped so the UI can say why.
  assert.match(actionLog, /SCREENSHOT_SKIPPED_REASON\.captureDisabled/);
  assert.match(actionLog, /const willCapture = capturePlan\.screenshots && !payload\.screenshotSkippedReason;/);
});

/**
 * Recursively reads every .js file under the given source directories.
 * Recursion matters: the sources are nested now, and a non-recursive scan would
 * quietly stop asserting on most of them.
 */
function collectSources(directories) {
  return directories.flatMap(directory => walk(path.join(root, directory)))
    .filter(file => file.endsWith(".js"))
    .map(file => fs.readFileSync(file, "utf8"));
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
