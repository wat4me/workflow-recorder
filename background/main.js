/**
 * Workflow Recorder Service Worker entry point.
 *
 * This file is composition and nothing else: it builds the modules, wires their
 * dependencies, then hands the two runtime boundaries to routes.js and
 * browser-events.js. Any behaviour worth a name lives in its owning module.
 *
 * Layout:
 *   store/      persistence (steps, cases, screenshot cleanup, schema version)
 *   capture/    CDP screencast sessions and the screenshot job queue
 *   recording/  what a recording is: scope, lifecycle, injection, step logging
 *   routes.js   application messages
 *   browser-events.js  Chrome listeners            side-panel.js  panel layout
 */
import "../shared/media-store.js";
import "../shared/protocol.js";

import { registerBrowserEventHandlers } from "./browser-events.js";
import { registerInstallHandler } from "./install.js";
import { loadLocaleMessages, t } from "./locale.js";
import { createSerialQueue } from "./queue.js";
import { registerMessageRouter } from "./router.js";
import { createApplicationRoutes } from "./routes.js";
import { createSidePanelController } from "./side-panel.js";

import { createScreencastManager } from "./capture/screencast.js";
import { createScreenshotManager } from "./capture/screenshots.js";

import { createActionLog } from "./recording/action-log.js";
import { injectRecordingScripts, injectRecordingScriptsIntoFrame } from "./recording/injection.js";
import { createRecordingScope } from "./recording/scope.js";
import { createRecordingSession } from "./recording/session.js";

import * as actionStore from "./store/actions.js";
import * as caseStore from "./store/case-store.js";
import { createCaseStoreCoordinator } from "./store/case-migration.js";
import { createCaseManager } from "./store/cases.js";
import { createMediaCleanupManager } from "./store/media-cleanup.js";

const { MESSAGE } = globalThis.WorkflowRecorderProtocol;

// --- Queues -----------------------------------------------------------------
// Action writes read-modify-write shared storage keys, so they are serialized.
// Tab registration gets its own queue: a child page can become interactive
// before the parent click finishes its 1.2s validation, so it must not wait
// behind action writes.
const queueAction = createSerialQueue("Action Queue");
const queueTabRegistration = createSerialQueue("Tab Registration");
const queueRecordingTransition = createSerialQueue("Recording Transition");
// Case writes read the index, change it and write it back, so two at once can
// drop one another's entry. Separate from the action queue: banking a large case
// must not delay the screenshot binding of the step being recorded.
const queueCaseWrite = createSerialQueue("Case Store");

// --- Modules ----------------------------------------------------------------
const notifyStepsUpdated = () => {
  chrome.runtime.sendMessage({ action: MESSAGE.stepsUpdated }).catch(() => {});
};

const mediaCleanup = createMediaCleanupManager({ mediaStore: globalThis.RecorderMediaStore });

// Saved cases are stored per id behind an index, and a profile written by an
// earlier build has to be converted before any of it can be read or written.
// Case routes wait on this, so no caller has to know which layout is on disk.
const caseStoreCoordinator = createCaseStoreCoordinator();
const caseStoreReady = () => caseStoreCoordinator.ready();

const cases = createCaseManager({
  t,
  notifyStepsUpdated,
  caseStoreReady,
  queueCaseWrite,
  deleteScreenshots: keys => mediaCleanup.deleteUnreferenced(keys),
  // The same reference check the deletion itself uses, asked about a world where
  // the selected cases are already gone. Routing it through one entry point is
  // what stops a preview and the deletion it describes from disagreeing.
  readReferencedScreenshotKeys: options => mediaCleanup.referencedKeys(options)
});


const screencast = createScreencastManager();

const screenshots = createScreenshotManager({
  t,
  queueAction,
  screencast,
  mediaStore: globalThis.RecorderMediaStore,
  deleteScreenshots: keys => mediaCleanup.deleteUnreferenced(keys),
  notifyStepsUpdated
});

const scope = createRecordingScope({ screencast });

const actionLog = createActionLog({ t, scope, screenshots, mediaCleanup, notifyStepsUpdated });

const session = createRecordingSession({
  t,
  scope,
  cases,
  screencast,
  screenshots,
  drainActions: () => queueAction.drain()
});

const sidePanel = createSidePanelController({ isRecordableTab: scope.isRecordableTab });

// --- Startup ----------------------------------------------------------------
registerInstallHandler();

// Runs on every worker start, not just install: a profile can be opened by a
// newer build and then downgraded, and a conversion interrupted by the worker
// being terminated has to be able to resume.
const storeReady = caseStoreReady().then(state => {
  if (!state.ok) {
    console.error(
      `[Case Store] Stored data is version ${state.version} but this build reads version ${state.expected}`
      + ` (${state.reason}). Cases are readable but cannot be modified.`
    );
  }
  return state;
});

// Both wait for the store: they read what saved cases still reference, and the
// answer before a conversion commits lives in a different place than after.
storeReady.then(async () => {
  // Finishes a case removal interrupted between the index write and the record
  // delete. Nothing else would ever reclaim those records.
  const removed = await caseStore.flushPendingRemovals();
  if (removed > 0) console.log(`[Case Store] Removed ${removed} orphaned case record(s).`);
  await mediaCleanup.cleanupOrphans();
}).catch(error => {
  console.warn("[Case Store] Startup cleanup failed:", error.message);
});

// An interrupted write can leave action records that actionOrder no longer
// lists; nothing else would ever reclaim them.
actionStore.removeOrphanActions().then(count => {
  if (count > 0) console.log(`[Actions] Removed ${count} orphaned action records.`);
}).catch(error => {
  console.warn("[Actions] Orphan cleanup failed:", error.message);
});

// A worker that was terminated mid-capture took its queue and its CDP sessions
// with it. The steps it was holding would otherwise wait forever.
screenshots.recoverInterruptedJobs().then(count => {
  if (count > 0) console.log(`[Screenshots] Failed ${count} step(s) interrupted by a worker restart.`);
}).catch(error => {
  console.warn("[Screenshots] Interrupted-capture recovery failed:", error.message);
});

// --- Runtime boundaries -----------------------------------------------------
registerMessageRouter(createApplicationRoutes({
  actionLog,
  actionStore,
  cases,
  loadLocaleMessages,
  mediaCleanup,
  notifyStepsUpdated,
  queueAction,
  queueRecordingTransition,
  screenshots,
  session,
  sidePanel,
  storeReady
}));

registerBrowserEventHandlers({
  injectRecordingScripts,
  injectRecordingScriptsIntoFrame,
  queueAction,
  queueTabRegistration,
  scope,
  screencast,
  screenshots,
  sidePanel
});
