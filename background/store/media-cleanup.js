import { wait } from "../timing.js";
import * as actionStore from "./actions.js";
import * as caseStore from "./case-store.js";
import { createSerialQueue } from "../queue.js";

/**
 * Reference-aware screenshot cleanup with retry and persisted fallback work.
 *
 * The reference set is assembled from the open workspace steps plus the
 * `caseMedia:<id>` lists, never from the cases' steps themselves. That is what
 * keeps deleting a single step cheap: it costs one small read per saved case
 * instead of deserializing every step of every case in the history.
 */
export function createMediaCleanupManager({ mediaStore }) {
  const PENDING_KEY = "pendingScreenshotDeleteKeys";
  const LAST_CLEANUP_KEY = "lastScreenshotCleanupAt";
  const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  const queueCleanup = createSerialQueue("Media Cleanup");

  async function guardedCleanup(callback, candidates = []) {
    const result = mediaStore.withCleanupLock
      ? await mediaStore.withCleanupLock(callback)
      : await callback();
    // A writer is publishing media. Defer rather than wait while a case
    // mutation owns the case queue; the import retries cleanup after release.
    if (result.skipped && result.pending) await rememberPending(candidates);
    return result;
  }

  function screenshotKeys(actions = []) {
    // Both frames a step can hold: the after-frame and the before-frame.
    return (actions || []).flatMap(action => [action?.screenshotKey, action?.screenshotBeforeKey])
      .filter(Boolean);
  }

  /**
   * Every screenshot key still in use, by the workspace or by a saved case.
   *
   * `excludingCaseIds` answers the same question for a world where those cases are
   * already gone, which is what a deletion preview needs. The workspace is counted
   * either way: its steps belong to no case and outlive the deletion.
   */
  async function referencedKeys({ excludingCaseIds = null } = {}) {
    const [workspaceActions, retained] = await Promise.all([
      actionStore.readActions(),
      caseStore.readReferencedScreenshotKeys({ excluding: excludingCaseIds })
    ]);
    for (const key of screenshotKeys(workspaceActions)) retained.add(key);
    return retained;
  }

  async function rememberPending(keys) {
    const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
    if (uniqueKeys.length === 0) return;
    const stored = await chrome.storage.local.get(PENDING_KEY);
    await chrome.storage.local.set({
      [PENDING_KEY]: [...new Set([...(stored[PENDING_KEY] || []), ...uniqueKeys])]
    });
  }

  async function deleteWithRetry(keys, attempts = 3) {
    const uniqueKeys = [...new Set((keys || []).filter(Boolean))];
    if (uniqueKeys.length === 0) return { deletedCount: 0, pending: false };

    let lastError = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await mediaStore.deleteBlobs(uniqueKeys);
        const stored = await chrome.storage.local.get(PENDING_KEY);
        const remaining = (stored[PENDING_KEY] || []).filter(key => !uniqueKeys.includes(key));
        await chrome.storage.local.set({ [PENDING_KEY]: remaining });
        return { deletedCount: uniqueKeys.length, pending: false };
      } catch (error) {
        lastError = error;
        if (attempt < attempts) await wait(100 * attempt);
      }
    }

    await rememberPending(uniqueKeys);
    console.warn("[Media Cleanup] Screenshot deletion deferred:", lastError?.message);
    return { deletedCount: 0, pending: true, error: lastError?.message || "Screenshot deletion failed" };
  }

  /**
   * Deletes the given keys unless something still points at them.
   *
   * Callers pass only the keys their own change orphaned; they no longer hand in
   * the reference set, so a caller cannot get the deletion wrong by assembling it
   * from stale data. Run it after the index and workspace writes have landed.
   */
  async function deleteUnreferenced(candidateKeys) {
    const candidates = [...new Set((candidateKeys || []).filter(Boolean))];
    if (candidates.length === 0) return { deletedCount: 0, pending: false };
    const retained = await referencedKeys();
    return deleteWithRetry(candidates.filter(key => !retained.has(key)));
  }

  async function cleanupOrphans({ force = false } = {}) {
    const data = await chrome.storage.local.get(["isRecording", PENDING_KEY, LAST_CLEANUP_KEY]);
    const pendingKeys = data[PENDING_KEY] || [];
    const lastCleanupAt = Number(data[LAST_CLEANUP_KEY]) || 0;
    if (data.isRecording && !force && pendingKeys.length === 0) {
      return { deletedCount: 0, pending: false, skipped: true };
    }
    if (!force && pendingKeys.length === 0 && Date.now() - lastCleanupAt < CLEANUP_INTERVAL_MS) {
      return { deletedCount: 0, pending: false, skipped: true };
    }

    const retained = await referencedKeys();
    const stalePendingKeys = pendingKeys.filter(key => retained.has(key));
    if (stalePendingKeys.length > 0) {
      await chrome.storage.local.set({
        [PENDING_KEY]: pendingKeys.filter(key => !retained.has(key))
      });
    }
    const storedKeys = await mediaStore.getAllKeys();
    const orphanKeys = [...new Set([...storedKeys.filter(key => !retained.has(key)), ...pendingKeys])]
      .filter(key => !retained.has(key));
    const result = await deleteWithRetry(orphanKeys);
    await chrome.storage.local.set({ [LAST_CLEANUP_KEY]: Date.now() });
    return result;
  }

  return {
    cleanupOrphans: options => queueCleanup(() => guardedCleanup(() => cleanupOrphans(options))),
    deleteUnreferenced: keys => queueCleanup(() => guardedCleanup(() => deleteUnreferenced(keys), keys)),
    referencedKeys
  };
}
