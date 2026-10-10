/**
 * First-run and upgrade bootstrap.
 *
 * Workspace data (steps, cases, page numbering) survives an update; only
 * runtime-only state is reset, because a fresh worker cannot know which tabs
 * were being recorded before the upgrade.
 *
 * Deliberately does not touch `schemaVersion` or the case store. This handler
 * runs before anything has looked at the stored layout, so stamping the current
 * version here would erase the very signal the migration needs to recognise a v1
 * profile, and re-seeding `cases` would make a converted profile look like it had
 * no history. Both belong to the case store coordinator, which is the only
 * writer of either (see store/case-migration.js).
 */

// Keys from retired features. Left behind they would keep occupying the user's
// storage quota forever, since nothing else reads them any more.
const RETIRED_KEYS = [
  "captureMode",
  "lastRecordedVideoUrl",
  "recordingRootTabId",
  "resumeLoadedHistory"
];

export function registerInstallHandler() {
  chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.local.get(["nextPageNumber", "activeCaseId"], current => {
      chrome.storage.local.set({
        isRecording: false,
        tabsMapping: {}, // { tabId: pageName }
        recordingTabIds: [], // Root tab plus tabs/windows opened by tracked pages
        nextPageNumber: current.nextPageNumber || 1,
        activeCaseId: current.activeCaseId || null // null = current unsaved session
      });
      chrome.storage.local.remove("actions"); // superseded by actionOrder + action:<id>
      chrome.storage.local.remove(RETIRED_KEYS);
    });
  });
}
