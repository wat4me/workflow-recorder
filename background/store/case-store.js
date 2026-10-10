/**
 * Storage layout for saved cases (schema 2).
 *
 * Cases used to live in one `cases` array holding every case's full `actions`.
 * That made three unrelated operations expensive in the same way: listing the
 * history deserialized every step of every case, saving one case rewrote all of
 * them, and the reference-aware screenshot cleanup could only work by holding
 * the entire history in memory.
 *
 * The record is now split by access pattern:
 *
 *   caseIndex          metadata only, read on every list/summary query
 *   caseMedia:<id>     that case's deduplicated screenshot keys, read only by
 *                      media cleanup
 *   case:<id>          actions and pages, read only to load, preview or export
 *
 * Keeping the screenshot keys out of `caseIndex` matters: they scale with step
 * count, so folding them into the index would put a megabyte of strings on the
 * path of every history list -- the exact cost the split exists to remove.
 *
 * A profile that has not been migrated yet has no `caseIndex`. Readers fall back
 * to the v1 array in that state so the panel keeps working; writes are refused
 * upstream by the migration coordinator, so the fallback is read-only by
 * construction.
 */
import { isReadableCase } from "./schema.js";
import { sanitizeComposition } from "../../shared/composition.js";

export const INDEX_KEY = "caseIndex";
export const FOLDERS_KEY = "caseFolders";
export const LEGACY_KEY = "cases";
export const DETAIL_PREFIX = "case:";
export const MEDIA_PREFIX = "caseMedia:";
// Ids whose index entry is already gone but whose records may still be stored.
// See `removeCase`: the two writes cannot be one atomic operation.
export const PENDING_REMOVAL_KEY = "pendingCaseRecordRemovalIds";

export function detailKey(caseId) {
  return `${DETAIL_PREFIX}${caseId}`;
}

export function mediaKey(caseId) {
  return `${MEDIA_PREFIX}${caseId}`;
}

/**
 * Deduplicated screenshot keys of one case, in first-referenced order.
 *
 * Each step can hold two frames -- the "before" (at action time) and the "after"
 * (result) -- so both keys are collected; missing either from the reference set
 * would let cleanup delete a blob a saved case still shows.
 */
export function screenshotKeysOf(actions) {
  const keys = [];
  for (const action of actions || []) {
    if (action?.screenshotKey) keys.push(action.screenshotKey);
    if (action?.screenshotBeforeKey) keys.push(action.screenshotBeforeKey);
  }
  return [...new Set(keys)];
}

/**
 * Newest first, and total: two cases saved in the same millisecond still get a
 * stable order, which is what lets a keyset cursor page through the index
 * without repeating or skipping an entry.
 */
export function compareEntriesDesc(a, b) {
  const byTime = (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0);
  if (byTime !== 0) return byTime;
  return String(b?.id || "").localeCompare(String(a?.id || ""));
}

export function sortIndex(entries) {
  return [...entries].sort(compareEntriesDesc);
}

/** The index entry for a case. Deliberately excludes actions, pages and media. */
export function indexEntryFor(caseRecord) {
  // Counted from the steps rather than trusted from the record: the index is
  // what the history list renders, so it must not be able to disagree with the
  // detail record it points at.
  const stepCount = Array.isArray(caseRecord?.actions)
    ? caseRecord.actions.length
    : (Number.isInteger(caseRecord?.stepCount) ? caseRecord.stepCount : 0);
  const entry = {
    id: caseRecord.id,
    name: caseRecord.name,
    createdAt: Number(caseRecord.createdAt) || 0,
    stepCount,
    // Persisted rather than recomputed: deciding whether a case is loadable
    // would otherwise require reading its detail record, which is the one thing
    // summary queries must not do.
    readable: isReadableCase(caseRecord)
  };
  // Absent for a root case. Kept in the index rather than the detail record
  // because the relationship is what gets browsed; reading a case's steps to find
  // out who its parent is would defeat the split.
  if (caseRecord.lineage?.parentCaseId) entry.lineage = caseRecord.lineage;
  if (caseRecord.folderId) entry.folderId = caseRecord.folderId;
  // Preserve the type of a scene saved by earlier builds.
  if (caseRecord.kind === "scene") entry.kind = "scene";
  return entry;
}

export function detailRecordFor(caseRecord) {
  return {
    id: caseRecord.id,
    actions: caseRecord.actions,
    pages: caseRecord.pages,
    ...(Array.isArray(caseRecord.flowEdges) ? { flowEdges: caseRecord.flowEdges } : {}),
    // Validate legacy scene provenance while preserving its saved steps.
    ...(caseRecord.kind === "scene"
      ? { composition: sanitizeComposition(caseRecord.composition, caseRecord.actions.length) }
      : {})
  };
}

function legacyEntry(caseRecord) {
  return { ...indexEntryFor(caseRecord), legacy: true };
}

/**
 * Ordered case metadata.
 *
 * `legacy: true` on the entries means the migration has not committed, so the
 * caller is looking at a derived read-only view of the v1 array.
 */
export async function readIndex() {
  const data = await chrome.storage.local.get([INDEX_KEY, LEGACY_KEY]);
  if (Array.isArray(data[INDEX_KEY])) return data[INDEX_KEY];
  return sortIndex((data[LEGACY_KEY] || []).filter(item => item?.id).map(legacyEntry));
}

export async function readEntry(caseId) {
  if (!caseId) return null;
  return (await readIndex()).find(entry => entry.id === caseId) || null;
}

/** Actions and pages for one case. Null when the record is gone. */
export async function readDetail(caseId) {
  if (!caseId) return null;
  const data = await chrome.storage.local.get([detailKey(caseId), INDEX_KEY, LEGACY_KEY]);
  const detail = data[detailKey(caseId)];
  if (detail) return detail;
  // A committed index and no detail record means the detail is genuinely
  // missing; before that, the v1 array is still the source of truth.
  if (Array.isArray(data[INDEX_KEY])) return null;
  const legacy = (data[LEGACY_KEY] || []).find(item => item?.id === caseId);
  return legacy ? detailRecordFor(legacy) : null;
}

/**
 * Every screenshot key referenced by a saved case.
 *
 * Reads `caseMedia:<id>` for the ids in the index -- never the detail records --
 * so deleting a step stays cheap no matter how much history exists.
 *
 * `excluding` leaves out cases that are about to be removed. A deletion preview
 * has to answer what would still be referenced *after* the removal, and letting a
 * doomed case keep its own screenshots alive would report every one of them as
 * shared and promise a saving of zero.
 */
export async function readReferencedScreenshotKeys({ excluding = null } = {}) {
  const index = await readIndex();
  const excluded = excluding ? new Set(excluding) : null;
  const considered = excluded ? index.filter(entry => !excluded.has(entry.id)) : index;
  if (considered.length === 0) return new Set();

  if (considered.some(entry => entry.legacy)) {
    // Pre-migration the keys only exist inside the v1 records, so this one path
    // has to pay for the old layout. It disappears once the migration commits.
    const data = await chrome.storage.local.get(LEGACY_KEY);
    const items = (data[LEGACY_KEY] || []).filter(item => !excluded?.has(item.id));
    return new Set(items.flatMap(item => screenshotKeysOf(item?.actions)));
  }

  const keys = considered.map(entry => mediaKey(entry.id));
  const stored = await chrome.storage.local.get(keys);
  return new Set(keys.flatMap(key => stored[key] || []));
}

/**
 * The deduplicated screenshot keys of specific cases.
 *
 * Reads the media lists, which is what a removal and a removal preview both need.
 * The detail record is only a fallback: a media list can be absent for a case
 * written by an older build, and losing those keys would let cleanup delete
 * screenshots the case still shows.
 */
export async function readCaseScreenshotKeys(caseIds) {
  const ids = [...new Set((caseIds || []).filter(Boolean))];
  if (ids.length === 0) return [];

  const stored = await chrome.storage.local.get(ids.map(mediaKey));
  const keys = [];
  for (const id of ids) {
    const listed = stored[mediaKey(id)];
    keys.push(...(listed || screenshotKeysOf((await readDetail(id))?.actions)));
  }
  return [...new Set(keys)];
}

/**
 * Adds or replaces a case.
 *
 * Index, detail and media list go out in one `set()`, so a case can never be
 * listed without its steps being readable. `extraWrites` joins that same write
 * for state that must land with the case or not at all -- `activeCaseId` being
 * the one that matters, since a case saved without becoming the active baseline
 * leaves the workspace looking unsaved.
 */
export async function writeCase(caseRecord, extraWrites = {}) {
  const entry = indexEntryFor(caseRecord);
  const index = await readIndex();
  const nextIndex = sortIndex([...index.filter(item => item.id !== entry.id), entry]);
  await chrome.storage.local.set({
    ...extraWrites,
    [INDEX_KEY]: nextIndex,
    [detailKey(entry.id)]: detailRecordFor(caseRecord),
    [mediaKey(entry.id)]: screenshotKeysOf(caseRecord.actions)
  });
  return entry;
}

/**
 * Adds several independent case records in one storage commit.
 *
 * Portable-package import uses this so the history index can never expose half
 * an imported family if the browser rejects the write (for example, because the
 * device is out of space). Screenshot blobs are staged separately in IndexedDB
 * and rolled back by the importing page when this commit fails.
 */
export async function writeCases(caseRecords) {
  const records = Array.isArray(caseRecords) ? caseRecords : [];
  if (records.length === 0) return [];

  const entries = records.map(indexEntryFor);
  const importedIds = new Set(entries.map(entry => entry.id));
  const index = await readIndex();
  const writes = {
    [INDEX_KEY]: sortIndex([
      ...index.filter(entry => !importedIds.has(entry.id)),
      ...entries
    ])
  };
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    const entry = entries[index];
    writes[detailKey(entry.id)] = detailRecordFor(record);
    writes[mediaKey(entry.id)] = screenshotKeysOf(record.actions);
  }
  await chrome.storage.local.set(writes);
  return entries;
}

/**
 * Removes a case, index first.
 *
 * `set` and `remove` are separate storage operations, so this cannot be atomic.
 * The order is chosen so an interruption leaves records nothing references --
 * reclaimable, and invisible to the user -- rather than an index entry pointing
 * at steps that are already gone. The id is parked in `PENDING_REMOVAL_KEY` for
 * the same reason: a worker that dies between the two writes must not strand the
 * records forever.
 */
export async function removeCase(caseId) {
  const result = await removeCases([caseId]);
  return {
    removed: result.removed[0] || null,
    screenshotKeys: result.screenshotKeys
  };
}

/** Removes several cases behind one index commit so a batch cannot be half-listed. */
export async function removeCases(caseIds) {
  const ids = [...new Set((caseIds || []).filter(Boolean))];
  const index = await readIndex();
  const idSet = new Set(ids);
  const removed = index.filter(item => idSet.has(item.id));
  if (removed.length === 0) return { removed: [], screenshotKeys: [] };

  const [screenshotKeys, stored] = await Promise.all([
    readCaseScreenshotKeys(removed.map(entry => entry.id)),
    chrome.storage.local.get(PENDING_REMOVAL_KEY)
  ]);

  await chrome.storage.local.set({
    [INDEX_KEY]: index.filter(item => !idSet.has(item.id)),
    [PENDING_REMOVAL_KEY]: [...new Set([...(stored[PENDING_REMOVAL_KEY] || []), ...removed.map(item => item.id)])]
  });
  await removeRecords(removed.map(item => item.id));
  return { removed, screenshotKeys };
}

async function removeRecords(caseIds) {
  const ids = [...new Set((caseIds || []).filter(Boolean))];
  if (ids.length === 0) return 0;
  await chrome.storage.local.remove(ids.flatMap(id => [detailKey(id), mediaKey(id)]));
  const stored = await chrome.storage.local.get(PENDING_REMOVAL_KEY);
  const remaining = (stored[PENDING_REMOVAL_KEY] || []).filter(id => !ids.includes(id));
  await chrome.storage.local.set({ [PENDING_REMOVAL_KEY]: remaining });
  return ids.length;
}

/**
 * Finishes removals that were interrupted between the index write and the record
 * delete. Ids that came back into the index are dropped from the list instead of
 * being deleted, so a re-saved id cannot lose its steps.
 */
export async function flushPendingRemovals() {
  const stored = await chrome.storage.local.get(PENDING_REMOVAL_KEY);
  const pending = stored[PENDING_REMOVAL_KEY] || [];
  if (pending.length === 0) return 0;

  const live = new Set((await readIndex()).map(entry => entry.id));
  const removable = pending.filter(id => !live.has(id));
  if (removable.length !== pending.length) {
    await chrome.storage.local.set({ [PENDING_REMOVAL_KEY]: removable });
  }
  return removeRecords(removable);
}

/** Index-only update: the detail record holds no name to keep in sync. */
export async function renameCase(caseId, name) {
  const index = await readIndex();
  if (!index.some(entry => entry.id === caseId)) return false;
  await chrome.storage.local.set({
    [INDEX_KEY]: index.map(entry => (entry.id === caseId ? { ...entry, name } : entry))
  });
  return true;
}

/** Lightweight organizational folders. Cases without a folderId are unfiled. */
export async function readFolders() {
  const data = await chrome.storage.local.get(FOLDERS_KEY);
  return Array.isArray(data[FOLDERS_KEY]) ? data[FOLDERS_KEY] : [];
}

export async function writeFolder(folder) {
  const folders = await readFolders();
  await chrome.storage.local.set({
    [FOLDERS_KEY]: [...folders.filter(item => item.id !== folder.id), folder]
  });
  return folder;
}

export function descendantFolderIds(folders, folderId) {
  const result = new Set([folderId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders || []) {
      if (folder.parentId && result.has(folder.parentId) && !result.has(folder.id)) {
        result.add(folder.id);
        changed = true;
      }
    }
  }
  return result;
}

/** An empty folder deletion also removes its empty descendant folders. */
export async function removeFolder(folderId) {
  const [folders, index] = await Promise.all([readFolders(), readIndex()]);
  const folder = folders.find(item => item.id === folderId);
  if (!folder) return { removed: null, removedCount: 0, caseCount: 0 };

  const removedIds = descendantFolderIds(folders, folderId);
  const caseCount = index.filter(entry => removedIds.has(entry.folderId)).length;
  if (caseCount > 0) return { removed: folder, removedCount: 0, caseCount };

  await chrome.storage.local.set({
    [FOLDERS_KEY]: folders.filter(item => !removedIds.has(item.id))
  });
  return { removed: folder, removedCount: removedIds.size, caseCount: 0 };
}

/** Moves existing cases to one folder, or removes their folder when folderId is null. */
export async function moveCasesToFolder(caseIds, folderId) {
  const ids = new Set(caseIds || []);
  const index = await readIndex();
  let movedCount = 0;
  const nextIndex = index.map(entry => {
    if (!ids.has(entry.id) || (entry.folderId || null) === folderId) return entry;
    movedCount++;
    if (folderId) return { ...entry, folderId };
    const { folderId: ignored, ...unfiled } = entry;
    return unfiled;
  });
  if (movedCount > 0) await chrome.storage.local.set({ [INDEX_KEY]: nextIndex });
  return movedCount;
}

/**
 * Records that a case turned out to be unloadable.
 *
 * Called from a read path, so it is a no-op while the index is still the derived
 * v1 view: writing there would fork the two layouts mid-migration.
 */
export async function markUnreadable(caseId) {
  const index = await readIndex();
  const entry = index.find(item => item.id === caseId);
  if (!entry || entry.legacy || entry.readable === false) return false;
  await chrome.storage.local.set({
    [INDEX_KEY]: index.map(item => (item.id === caseId ? { ...item, readable: false } : item))
  });
  return true;
}
