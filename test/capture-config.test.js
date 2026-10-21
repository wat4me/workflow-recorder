const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.join(__dirname, "..");

function read(...segments) {
  return fs.readFileSync(path.join(projectRoot, ...segments), "utf8");
}

test("extension requests the minimum viable permission set", () => {
  const manifest = JSON.parse(read("manifest.json"));

  assert.ok(manifest.permissions.includes("debugger"));
  assert.ok(!manifest.permissions.includes("desktopCapture"));
  assert.ok(!manifest.permissions.includes("offscreen"));
  assert.ok(!manifest.permissions.includes("downloads"));
  // Redundant with the <all_urls> host permission, which already covers
  // injection and page reads. Chrome asks for the minimum viable permission set.
  assert.ok(!manifest.permissions.includes("activeTab"));
});

test("extension exposes screenshot capture without screen recording capabilities", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const install = read("background", "install.js");
  const workerSources = collectSources(["background"]).join("\n");

  assert.equal(manifest.web_accessible_resources, undefined);
  assert.equal(manifest.content_scripts, undefined);
  assert.doesNotMatch(workerSources, /desktopCapture|chooseDesktopMedia|MediaRecorder|OFFSCREEN_DOCUMENT/);
  assert.doesNotMatch(workerSources, /resetScreenshotFallback/);
  assert.match(install, /chrome\.storage\.local\.get\(\["nextPageNumber", "activeCaseId"\]/);
  assert.match(install, /RETIRED_KEYS\s*=\s*\[[\s\S]*"captureMode"[\s\S]*"lastRecordedVideoUrl"/);
  assert.equal(fs.existsSync(path.join(projectRoot, "offscreen")), false);
  assert.equal(fs.existsSync(path.join(projectRoot, "icons", "semantic-recorder.svg")), false);
});

test("manual screenshots are triggered from the side panel, not the recorded page", () => {
  const popup = read("ui", "popup.html");
  const panel = read("ui", "app", "recorder-panel.js");
  const content = collectSources(["content"]).join("\n");
  const routes = read("background", "routes.js");

  assert.match(popup, /id="manual-screenshot-btn"[\s\S]*?data-i18n-aria-label="manualScreenshot"/);
  assert.match(panel, /MESSAGE\.manualScreenshot[\s\S]*?tabId: await resolveCaptureTabId\(\)/);
  assert.match(routes, /MESSAGE\.manualScreenshot[\s\S]*?handleManual\(request\.tabId\)/);
  assert.doesNotMatch(content, /playwright-recorder-overlay|RecorderScreenshotButton|<button/);
  assert.match(content, /RecorderScreencastFramePrimer/);
});

test("manifest entry points resolve to files that exist", () => {
  const manifest = JSON.parse(read("manifest.json"));

  for (const entryPoint of [manifest.background.service_worker, manifest.side_panel.default_path]) {
    assert.ok(fs.existsSync(path.join(projectRoot, entryPoint)), `missing entry point: ${entryPoint}`);
  }
});

test("published extension excludes native Agent execution", () => {
  const manifest = JSON.parse(read("manifest.json"));
  const workers = collectSources(["background"]).join("\n");
  assert.ok(!manifest.permissions.includes("nativeMessaging"));
  assert.doesNotMatch(workers, /connectNative|createNativeAgentController|MESSAGE\.agent/);
});

test("manifest references complete Semantic Recorder icon sizes", () => {
  const manifest = JSON.parse(read("manifest.json"));

  for (const size of [16, 32, 48, 128]) {
    const relativePath = manifest.icons[String(size)];
    assert.equal(relativePath, `icons/icon-${size}.png`);
    const png = fs.readFileSync(path.join(projectRoot, relativePath));
    assert.equal(png.toString("ascii", 1, 4), "PNG");
    assert.equal(png.readUInt32BE(16), size);
    assert.equal(png.readUInt32BE(20), size);
  }

  assert.equal(manifest.action.default_icon["16"], "icons/icon-16.png");
  assert.equal(manifest.action.default_icon["32"], "icons/icon-32.png");
});

test("subframes that load on their own are instrumented", () => {
  const browserEvents = read("background", "browser-events.js");
  const injection = read("background", "recording", "injection.js");

  // A form rendered inside an iframe loads its own document after the top page.
  // The top-frame path uses allFrames and so only covers frames present then;
  // without this a late iframe never gets the recorder and typing in it is lost.
  assert.match(injection, /export async function injectRecordingScriptsIntoFrame/);
  assert.match(injection, /frameIds: \[frameId\]/);
  // A subframe is content, not a page open, so it must not record a navigation.
  assert.match(injection, /injectRecordingScriptsIntoFrame[\s\S]*?recordNavigate: false/);
  // The worker no longer ignores subframe loads outright.
  assert.doesNotMatch(browserEvents, /if \(details\.frameId !== 0\) return;/);
  assert.match(browserEvents, /if \(details\.frameId !== 0\) \{[\s\S]*?injectRecordingScriptsIntoFrame/);
});

test("only a fresh session requests an opening-page step", () => {
  const main = read("background", "main.js");
  const scope = read("background", "recording", "scope.js");
  const session = read("background", "recording", "session.js");
  const injection = read("background", "recording", "injection.js");

  // The flag is derived once from the kind of session and handed to every tab that
  // session covers, so only a fresh recording ever asks for an opening step.
  assert.match(session, /const recordNavigate = !continueHistory;/);
  assert.match(session, /injectRecordingScripts\(tab\.id, recordNavigate\)/);
  assert.doesNotMatch(session, /injectRecordingScripts\(tab\.id, true\)/);
  assert.match(injection, /recordNavigate = false/);
  assert.doesNotMatch(main, /injectRecordingScripts\([^\n]*, true\)/);
  assert.doesNotMatch(scope, /injectRecordingScripts\([^\n]*, true\)/);
});

test("synthetic page-script clicks are not recorded as user actions", () => {
  const content = read("content", "main.js");

  assert.match(content, /function handleClickEvent\(event\) \{[\s\S]*?if \(!event\.isTrusted\) return/);
});

test("explicit legacy click handlers are recorded without a same-frame DOM mutation", () => {
  const content = read("content", "main.js");

  assert.match(content, /forceValid:[\s\S]*?target\.hasAttribute\("onclick"\)/);
  assert.match(content, /a\[href\]/);
});

test("child tab registration is not blocked by the action queue", () => {
  const main = read("background", "main.js");
  const browserEvents = read("background", "browser-events.js");
  const scope = read("background", "recording", "scope.js");

  // A child page can become interactive before the parent click finishes its
  // 1.2s validation, so registration must not wait behind action writes.
  assert.match(main, /queueTabRegistration\s*=\s*createSerialQueue\(/);
  assert.match(browserEvents, /queueTabRegistration\(\(\) => scope\.registerDescendantTab\(tab\)\)/);
  assert.doesNotMatch(browserEvents, /queueAction\(\(\) => scope\.registerDescendantTab\(tab\)\)/);
  assert.match(scope, /MESSAGE\.pingRecorder|injectRecordingScripts/);
});

test("screenshot media has reference-aware deletion paths", () => {
  const mediaStore = read("shared", "media-store.js");
  const cleanup = read("background", "store", "media-cleanup.js");
  const screenshots = read("background", "capture", "screenshots.js");
  const steps = read("ui", "app", "step-view.js");

  assert.match(mediaStore, /async function deleteBlobs\(keys\)/);
  assert.match(mediaStore, /async function getAllKeys\(\)/);
  assert.match(cleanup, /cleanupOrphans/);
  assert.match(cleanup, /screenshotBeforeKey/);
  assert.match(steps, /screenshotBeforeKey/);
  assert.match(steps, /step-media-row/);
  assert.doesNotMatch(steps, /step-technical|technicalDetails/);
  assert.doesNotMatch(steps, /viewLargeImage|查看大图/);
  assert.match(cleanup, /pendingScreenshotDeleteKeys/);
  assert.match(screenshots, /if \(!previous\) \{[\s\S]*deleteScreenshots\(\[screenshotKey\]\)/);
  assert.match(steps, /MESSAGE\.deleteStep/);
  assert.match(steps, /MESSAGE\.deleteSteps/);
  assert.match(steps, /selectedActionIds/);

  // Reclaiming media reads every step and the saved-case media lists. Doing that
  // inside the action queue delays everything waiting on it, including the
  // injection a freshly opened tab needs before its first click can be recorded.
  assert.doesNotMatch(screenshots, /queueAction\(async \(\) => \{[\s\S]*?deleteScreenshots/);

  // The reference set comes from the per-case media lists, so deleting one step
  // does not have to read the steps of every saved case. The arguments are not
  // pinned: a deletion preview passes the cases it is about to remove.
  assert.match(cleanup, /caseStore\.readReferencedScreenshotKeys\(/);
});

test("a screenshot is never written over a key another record may still use", () => {
  const screenshots = read("background", "capture", "screenshots.js");
  const screenshotKeys = read("background", "capture", "screenshot-keys.js");

  // `screenshot:<actionId>` was overwritten in place, which is only safe while an
  // action id has one owner. Loading a case puts its steps -- ids and screenshot
  // keys included -- into the workspace, so re-capturing there rewrote the saved
  // case's screenshot.
  assert.match(screenshotKeys, /screenshot:\$\{actionId\}:\$\{captureId\}/);
  assert.doesNotMatch(screenshots, /`screenshot:\$\{job\.actionId\}`/);
  // Bind first, then offer the replaced key for collection, and only through the
  // reference-aware path so a key a saved case still uses survives.
  assert.match(
    screenshots,
    /previous\.screenshotKey !== screenshotKey[\s\S]*deleteScreenshots\(\[previous\.screenshotKey\]\)/
  );
});

test("recording never clears where the workspace came from", () => {
  const actionLog = read("background", "recording", "action-log.js");
  const screenshots = read("background", "capture", "screenshots.js");

  // Appending a step clears `activeCaseId`, because the workspace no longer
  // matches a saved case. The origin must survive that: continuing a recording is
  // exactly when the relationship it records is being created. Only a deliberate
  // clear -- a new case, a restarted recording, a deleted active case -- drops it,
  // and all of those live in the case manager.
  assert.match(actionLog, /activeCaseId: null/);
  assert.doesNotMatch(actionLog, /ORIGIN_KEY/);
  assert.doesNotMatch(screenshots, /ORIGIN_KEY|workspaceOrigin/);

  const cases = read("background", "store", "cases.js");
  const session = read("background", "recording", "session.js");
  assert.match(cases, /\[ORIGIN_KEY\]: null/);
  // Continuing keeps the origin; the spread that drops it is the restart branch,
  // which is also the branch that discards the scope a continuation re-adopts.
  assert.match(session, /continueHistory \? \{\} : \{[\s\S]*?\[ORIGIN_KEY\]: null/);
});

test("recording and saved-case management stay in their own surfaces", () => {
  const popup = read("ui", "popup.html");
  const console_ = read("ui", "console.html");
  const consoleEntry = read("ui", "console-entry.js");
  const workbench = read("ui", "app", "case-workbench.js");

  assert.match(popup, /id="record-btn"/);
  assert.doesNotMatch(popup, /id="restart-record-btn"/);
  assert.match(popup, /id="record-btn"[\s\S]*?id="manual-screenshot-btn"[\s\S]*?id="download-doc-btn"/);
  assert.match(popup, /id="more-actions-menu"[\s\S]*?id="download-doc-btn"/);
  assert.match(popup, /class="case-actionbar"/);
  assert.match(popup, /id="save-current-case-btn"/);
  assert.match(popup, /id="download-doc-btn"/);
  assert.match(popup, /class="app-header compact recorder-header"[\s\S]*?id="record-btn"/);
  assert.match(popup, /id="download-doc-compact-btn"[^>]*data-i18n-title="exportResult"[^>]*data-i18n-aria-label="exportResult"/);
  // Two different actions, two different weights: clearing the whole workspace is
  // the quiet control in the step list's toolbar, while deleting a selection is a
  // danger button the row reveals only while something is selected
  // (.steps-section-head.is-selecting), so the toolbar never shows a pair of peers.
  assert.match(popup, /class="step-batch-actions"[\s\S]*?class="step-clear-btn"[^>]*data-i18n-aria-label="clearSteps"/);
  assert.match(popup, /class="step-batch-actions"[\s\S]*?class="btn btn-danger step-batch-delete"/);
  assert.match(read("ui", "app", "step-view.js"), /is-selecting", selectedCount > 0/);
  assert.match(read("ui", "styles", "steps.css"), /\.step-batch-actions \.btn \{\s*display: none;/);
  assert.doesNotMatch(popup, /id="step-selection-count"/);
  assert.match(popup, /class="selection-control step-select-all"[\s\S]*?class="selection-checkbox"/);
  assert.match(popup, /class="case-actionbar"[\s\S]*?id="save-current-case-btn"[\s\S]*?class="copy-task-control"[\s\S]*?id="copy-task-btn"/);
  assert.match(popup, /id="copy-task-btn"[\s\S]*?data-i18n="copyForAI"/);
  assert.match(popup, /id="copy-task-btn"[\s\S]*?aria-describedby="copy-task-tooltip"/);
  assert.match(popup, /class="tooltip-content"[\s\S]*?role="tooltip"[\s\S]*?data-i18n="copyTaskHint"/);
  assert.match(popup, /class="tooltip-trigger copy-task-info"[\s\S]*?data-i18n-aria-label="copyTaskHelp"/);
  const recorderPanel = read("ui", "app", "recorder-panel.js");
  assert.doesNotMatch(recorderPanel, /restartRecordBtn|restartRecordingMessage/);
  assert.match(recorderPanel, /copyTaskBtn[\s\S]*?navigator\.clipboard\.writeText[\s\S]*?StepDocGenerator\.generateTask/);
  assert.doesNotMatch(popup, /class="logo-area"|id="history-btn"|id="recording-counts"|id="recording-summary-status"|class="app-footer"|id="tab-code-btn"|id="panel-code"|id="copy-code-btn"/);
  assert.doesNotMatch(popup, /id="batch-export-cases-btn"|id="export-case-package-btn"|id="case-package-file-input"/);

  assert.match(console_, /id="import-case-package-btn"/);
  assert.match(console_, /id="batch-export-cases-btn"/);
  assert.match(console_, /id="export-case-package-btn"/);
  assert.match(console_, /id="create-case-folder-btn"/);
  assert.match(console_, /class="case-folder-heading"[\s\S]*?id="create-case-folder-btn"[^>]*data-i18n-aria-label="createFolder"/);
  assert.match(console_, /id="batch-delete-cases-btn"[^>]*data-i18n="delete"/);
  assert.match(console_, /id="batch-export-cases-btn"[^>]*data-i18n-title="exportDocumentsHint"/);
  assert.match(console_, /id="export-case-package-btn"[^>]*data-i18n-title="exportCasePackageHint"/);
  assert.match(console_, /id="import-case-package-btn"[^>]*data-i18n-title="importCasePackageHint"/);
  assert.match(console_, /id="case-folder-list"/);
  assert.match(console_, /id="move-cases-folder-btn"/);
  assert.match(console_, /id="case-search-scope"[\s\S]*?value="all"/);
  assert.doesNotMatch(console_, /id="case-folder-target"/);
  assert.match(console_, /id="batch-delete-cases-btn"/);
  assert.match(console_, /class="selection-control library-select-all"[\s\S]*?class="selection-checkbox"/);
  assert.doesNotMatch(workbench, /library-item-folder-select/);
  // Folder management moved to its own module; the library keeps the case-level
  // moves and the drag payload the folder tree reads.
  const folders = read("ui", "app", "case-folders.js");
  assert.match(folders, /move-folder-dialog/);
  assert.match(folders, /createFolder\(id\)/);
  assert.match(workbench, /ctx\.showMoveDialog\(\[caseRecord\.id\]/);
  assert.match(workbench, /dataTransfer\.setData\("application\/x-workflow-recorder-case-ids"/);
  assert.match(workbench, /addEventListener\("drop"/);
  assert.match(workbench, /ctx\.draggedCaseIds = ctx\.selectedIds\.has\(caseRecord\.id\)/);
  assert.match(workbench, /MESSAGE\.deleteCases/);
  assert.match(console_, /id="preview-steps-container"/);
  assert.doesNotMatch(console_, /id="preview-lineage-flow"|id="create-scene-btn"/);
  // The workbench ships without the AI execution surfaces: no lab iframe, no
  // execution records, no agent control panel, and no module imports for them.
  assert.doesNotMatch(console_, /ai-execution-frame|execution-records-panel|view-ai-btn|view-records-btn|agent-panel|preview-runs-view/);
  assert.doesNotMatch(consoleEntry, /case-agent-runner|execution-records/);
  assert.doesNotMatch(console_, /id="record-btn"|id="restart-record-btn"|id="clear-steps-btn"/);
});

test("the case name is asked for when it is needed, not kept on the page", () => {
  const popup = read("ui", "popup.html");
  const panel = read("ui", "app", "recorder-panel.js");

  // The actionbar carried a permanent name field that the panel read at save and
  // export time. It is a dialog now, so neither the markup nor the placeholder
  // string that belonged to it should come back.
  assert.doesNotMatch(popup, /export-name-input|export-name-field|exportNamePlaceholder/);
  // Prefilled with the remembered name, and a cancelled dialog must return
  // without saving rather than fall through to a nameless save.
  assert.match(panel, /label: t\("caseName", \[\], "用例名称"\)[\s\S]{0,40}value: caseName/);
  assert.match(panel, /const answer = await promptText\(\{[\s\S]*?saveCaseAction[\s\S]*?if \(answer === null\) return;/);
  // The name the worker actually filed the case under, which is not the typed one
  // when it was left empty.
  assert.match(panel, /caseName = response\.case\?\.name \|\| caseName;/);
});

test("recording settings are reachable from both surfaces", () => {
  const popup = read("ui", "popup.html");
  const consolePage = read("ui", "console.html");
  const popupEntry = read("ui", "popup-entry.js");
  const consoleEntry = read("ui", "console-entry.js");

  // The panel and the workbench offer the same entry point...
  for (const page of [popup, consolePage]) {
    assert.match(page, /id="capture-settings-btn"/);
    assert.match(page, /id="capture-settings-btn"[^>]*data-i18n-title="captureSettingsTitle"/);
  }
  // ...one dialog over one stored record, so neither page carries its own copy of
  // the settings and the two can never disagree about what is configured.
  for (const entry of [popupEntry, consoleEntry]) {
    assert.match(entry, /shared\/capture-settings\.js/);
    assert.match(entry, /lib\/settings-dialog\.js/);
  }
  // The button is all either page inlines; the dialog builds its own markup, which
  // is what keeps the two from drifting into showing different controls.
  for (const page of [popup, consolePage]) {
    assert.doesNotMatch(page, /capture-settings-dialog|capture-screenshots-enabled|capture-quality/);
  }
});

test("side-panel controls stay on one responsive toolbar row", () => {
  const popup = read("ui", "popup.html");
  const controls = read("ui", "styles", "controls.css");
  const steps = read("ui", "styles", "steps.css");
  const base = read("ui", "styles", "base.css");
  const selection = read("ui", "styles", "selection.css");

  assert.match(popup, /class="recorder-meta-row"[\s\S]*?class="header-utilities"[\s\S]*?class="record-actions header-record-actions"/);
  assert.match(popup, /id="open-console-btn"[\s\S]*?data-i18n="workspace"/);
  assert.match(controls, /\.recorder-header \{[\s\S]*?display: grid[\s\S]*?grid-template-columns: minmax\(280px, 360px\) minmax\(0, 1fr\) auto/);
  assert.match(controls, /\.recorder-meta-row \{[\s\S]*?display: contents/);
  assert.match(controls, /\.header-record-actions \{[\s\S]*?grid-column: 1[\s\S]*?grid-row: 1[\s\S]*?width: 100%[\s\S]*?align-items: stretch/);
  assert.match(controls, /\.header-utilities \{[\s\S]*?grid-column: 3[\s\S]*?grid-row: 1/);
  assert.match(controls, /\.record-actions \{[\s\S]*?height: auto/);
  assert.match(controls, /\.header-record-actions \.btn \{[\s\S]*?min-height: 36px[\s\S]*?white-space: nowrap/);
  assert.doesNotMatch(controls, /\.restart-state/);
  assert.match(controls, /@media \(max-width: 560px\)[\s\S]*?\.recorder-header \{[\s\S]*?grid-template-columns: minmax\(0, 360px\) minmax\(0, 1fr\) auto[\s\S]*?gap: 8px/);
  assert.match(popup, /id="record-btn"[\s\S]*?class="btn-icon"[\s\S]*?<svg/);
  assert.doesNotMatch(controls, /#record-btn \.btn-icon \{[\s\S]*?display: none/);
  assert.match(steps, /\.step-index \{[\s\S]*?margin-top: calc\(\(var\(--step-header-height\) - var\(--step-index-size\)\) \/ 2\)/);
  assert.match(steps, /\.step-batch-actions \{[\s\S]*?flex-wrap: wrap/);
  assert.match(base, /@import url\("\.\/selection\.css"\)/);
  assert.match(selection, /\.selection-control \{[\s\S]*?align-items: center[\s\S]*?line-height: 1/);
  assert.match(selection, /\.selection-checkbox \{[\s\S]*?width: 14px[\s\S]*?height: 14px[\s\S]*?margin: 0/);
  assert.doesNotMatch(popup, /id="status-dot"|id="status-text"/);
  assert.doesNotMatch(controls, /\.header-record-actions \{[\s\S]{0,120}?max-width:/);
});

test("side-panel screenshots zoom in place instead of opening a tab", () => {
  const preview = read("ui", "lib", "image-preview.js");

  assert.match(preview, /className = "image-preview-overlay"/);
  assert.match(preview, /const zoomOut[\s\S]*const zoomIn/);
  assert.match(preview, /previousScreenshot|nextScreenshot|ArrowLeft|ArrowRight/);
  assert.match(preview, /if \(options\.showFit !== false\)/);
  assert.match(preview, /title\.title = alt/);
  assert.match(preview, /stage\.addEventListener\("wheel"/);
  assert.match(preview, /stage\.addEventListener\("pointermove"/);
  assert.doesNotMatch(preview, /chrome\.tabs\.(create|update|query)/);
});

test("hideable panels override the author display rules", () => {
  const styles = fs.readdirSync(path.join(projectRoot, "ui", "styles"))
    .filter(file => file.endsWith(".css"))
    .map(file => read("ui", "styles", file))
    .join("\n");

  // An author `display` declaration beats the UA rule behind the `hidden`
  // attribute, so without these the panels render on top of each other.
  assert.match(styles, /\.console-panel\[hidden\][\s\S]*?display: none/);
  assert.match(styles, /\.empty-state\[hidden\][\s\S]*?display: none/);
});

test("a recording holds the worker open, and releases it on both stop paths", () => {
  const content = read("content", "main.js");
  const browserEvents = read("background", "browser-events.js");

  // A worker is terminated after 30s without events, and a screencast only pushes
  // on paint -- so a user reading the page they just clicked produces none. Losing
  // the worker loses the capture queue and every CDP session with it.
  assert.match(content, /chrome\.runtime\.connect\(\{ name: "recording-keepalive" \}\)/);
  assert.match(browserEvents, /RECORDING_KEEPALIVE_PORT = "recording-keepalive"/);
  assert.match(browserEvents, /keepalivePorts\.delete\(port\)/);

  // One port per tab, not one per iframe.
  assert.match(content, /function openKeepalive\(\) \{\s*if \(window\.top !== window \|\| keepalivePort\) return/);
  // Released on the message and on the storage flag, because a backgrounded tab may
  // never receive the message and a port left open outlives the recording.
  assert.match(content, /closeKeepalive\(\);/);
  assert.match(content, /if \(isRecording\) openKeepalive\(\);\s*else closeKeepalive\(\);/);
});

test("interrupted captures resolve instead of waiting forever", () => {
  const screenshots = read("background", "capture", "screenshots.js");
  const actionLog = read("background", "recording", "action-log.js");
  const main = read("background", "main.js");

  // The queue lives in worker memory, so a terminated worker leaves steps marked
  // pending with nothing coming for them.
  assert.match(screenshots, /async function recoverInterruptedJobs\(\)/);
  assert.match(screenshots, /claimedActionIds/);
  assert.match(main, /screenshots\.recoverInterruptedJobs\(\)/);

  // The pending marker rides along with the write that creates or changes the
  // step: recording a step must stay one storage write.
  assert.match(actionLog, /pendingCaptureFields\(\)/);
  assert.doesNotMatch(actionLog, /patchAction\([^)]*screenshotStatus/);
});

test("the installer cannot hide a v1 profile from the case store migration", () => {
  const install = read("background", "install.js");

  // This handler runs before anything has inspected the stored layout. Stamping
  // the version would erase the signal the migration recognises a v1 profile by,
  // and re-seeding `cases` would make a converted profile look empty.
  assert.doesNotMatch(install, /schemaVersion\s*:/);
  assert.doesNotMatch(install, /\bcases\s*:/);
});

test("saved cases are reached through the split store, not the v1 array", () => {
  // The two modules that own the layout and its conversion are the only places
  // allowed to name the v1 key; anywhere else it would mean a runtime path is
  // still deserializing every step of every case.
  const owners = [
    path.join("background", "store", "case-store.js"),
    path.join("background", "store", "case-migration.js")
  ];
  const offenders = collectSourceFiles(["background"])
    .filter(file => !owners.some(owner => file.endsWith(owner)))
    .filter(file => /["']cases["']/.test(fs.readFileSync(file, "utf8")))
    .map(file => path.relative(projectRoot, file));

  assert.deepEqual(offenders, []);

  const caseStore = read("background", "store", "case-store.js");
  assert.match(caseStore, /export const INDEX_KEY = "caseIndex"/);
  assert.match(caseStore, /export const DETAIL_PREFIX = "case:"/);
  assert.match(caseStore, /export const MEDIA_PREFIX = "caseMedia:"/);
});

test("public notifications render as centered top banners", () => {
  const dialogs = read("ui", "lib", "dialogs.js");

  assert.match(dialogs, /function notify\(/);
  assert.match(dialogs, /position:fixed;top:16px/);
  assert.match(dialogs, /align-items:center/);
  assert.match(dialogs, /#f0fdf4/);
  assert.doesNotMatch(dialogs, /bottom:12px/);
  assert.doesNotMatch(dialogs, /background:\$\{danger \? "#7f1d1d" : "#0f172a"\}/);
});

test("recording disclosure accurately includes all form input values", () => {
  const consent = read("ui", "lib", "consent.js");
  const zh = JSON.parse(read("_locales", "zh_CN", "messages.json"));
  const en = JSON.parse(read("_locales", "en", "messages.json"));

  assert.match(consent, /CONSENT_VERSION = 3/);
  assert.equal(zh.consentItemValues.message, "表单输入值");
  assert.equal(en.consentItemValues.message, "Form input values");
  assert.doesNotMatch(consent, /密码输入框除外|password fields/i);
});

test("text prompts use a full-width single-column dialog", () => {
  const dialogs = read("ui", "lib", "dialogs.js");
  const styles = read("ui", "styles", "steps.css");

  assert.match(dialogs, /confirm-dialog save-recording-dialog prompt-text-dialog/);
  assert.match(styles, /\.prompt-text-dialog \{[\s\S]*?flex-direction: column/);
  assert.match(styles, /\.prompt-text-dialog \.recording-name-field input,[\s\S]*?select \{[\s\S]*?height: 40px[\s\S]*?font-size: 14px/);
});

/**
 * Recursively reads every .js file under the given source directories.
 * Recursion matters: the sources are nested now, and a non-recursive scan would
 * quietly stop asserting on most of them.
 */
function collectSources(directories) {
  return collectSourceFiles(directories).map(file => fs.readFileSync(file, "utf8"));
}

function collectSourceFiles(directories) {
  return directories.flatMap(directory => walk(path.join(projectRoot, directory)))
    .filter(file => file.endsWith(".js"));
}

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}
