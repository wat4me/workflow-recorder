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
 *   caseMedia:<id>     that case's deduplicated media keys, read only by
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

export function isIntentPoolKey(key) {
  // Old case and draft media indexes can still contain retired attachment keys.
  return typeof key === "string" && (key.startsWith("intent-pool:") || key.startsWith("intent-pool-"));
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
  const intent = sanitizeIntent(caseRecord.intent, caseRecord.actions?.length);
  return {
    id: caseRecord.id,
    actions: caseRecord.actions,
    pages: caseRecord.pages,
    ...(Array.isArray(caseRecord.flowEdges) ? { flowEdges: caseRecord.flowEdges } : {}),
    // Tester-authored annotations. Absent when the case predates the field (or
    // was never annotated), which is what keeps the export unchanged for them.
    ...(intent ? { intent } : {}),
    // Validate legacy scene provenance while preserving its saved steps.
    ...(caseRecord.kind === "scene"
      ? { composition: sanitizeComposition(caseRecord.composition, caseRecord.actions.length) }
      : {})
  };
}

const INTENT_TEXT_LIMIT = 2000;
const INTENT_STEP_TEXT_LIMIT = 1000;
const INTENT_CHECK_LIMIT = 20;
const INTENT_MAX_STEPS = 500;
/**
 * Normalises the annotation layer a recorder fills in by hand.
 *
 * The model is the tester's: one annotation per test step covering an explicit
 * range of recorded steps. The step owns its goal, preconditions, purpose,
 * verification points and pass criteria, because one recording can span several
 * unrelated features.
 *
 * `start`/`end` are 1-based indexes into the recording. A step inserted at the
 * end starts one past the last step (`end` < `start`) and is marked `open`:
 * it grows to cover whatever is recorded next, which is how "pause, insert,
 * annotate, resume" works. Anything out of range is clamped -- an annotation is
 * never a reason to lose a case -- and a step that would overlap the previous
 * one is dropped rather than silently reordered.
 */
export function sanitizeIntent(intent, stepCount = 0) {
  if (!intent || typeof intent !== "object" || Array.isArray(intent)) return null;
  const text = (value, limit = INTENT_TEXT_LIMIT) =>
    typeof value === "string" ? value.trim().slice(0, limit) : "";
  const total = Number.isInteger(stepCount) && stepCount > 0 ? stepCount : 0;
  const maxStart = total + 1;

  const result = {};
  // `note` and the first iteration's `goal` used to be one case-level field.
  // They are now owned by each test step; keep the old value only for the
  // migration below, never as a document-level section. A recording can cover
  // several unrelated features, so one global goal would contradict the steps
  // that actually verify them.
  const legacyGoal = text(intent.note) || text(intent.goal);
  const legacySetup = text(intent.setup);
  const legacyPass = text(intent.pass);
  const linesOf = value => (Array.isArray(value) ? value
    : typeof value === "string" ? value.split(/\r?\n/) : [])
    .map(line => text(line, INTENT_STEP_TEXT_LIMIT)).filter(Boolean).slice(0, INTENT_CHECK_LIMIT);

  const seen = new Set();
  const steps = [];
  for (const [index, step] of (Array.isArray(intent.steps) ? intent.steps : []).entries()) {
    if (!step || typeof step !== "object") continue;
    const rawStart = Number.isInteger(step.start) ? step.start
      : Number.isInteger(step.afterStep) ? step.afterStep + 1 : 1;
    const start = Math.min(Math.max(rawStart, 1), maxStart);
    if (seen.has(start)) continue;
    const goal = text(step.goal);
    const preconditions = linesOf(step.preconditions);
    const checks = linesOf(step.checks);
    const pass = linesOf(step.pass);
    const entry = {
      id: typeof step.id === "string" && step.id ? step.id.slice(0, 64) : `step-${index + 1}`,
      title: text(step.title, 120),
      start,
      // Until the ends are derived below, keep the raw value (may be absent).
      end: Number.isInteger(step.end) ? step.end : null,
      open: step.open === true,
      note: text(step.note, INTENT_STEP_TEXT_LIMIT),
      goal,
      preconditions,
      checks,
      pass,
      ignore: step.ignore === true
    };
    const purpose = text(step.purpose, INTENT_STEP_TEXT_LIMIT);
    if (purpose) entry.purpose = purpose;
    // Kept even when empty: a test step the tester inserted at the end is a
    // placeholder that the steps recorded next belong to, and its annotation is
    // filled in later. Only duplicate starts are dropped.
    seen.add(start);
    steps.push(entry);
  }

  const sorted = steps.sort((a, b) => a.start - b.start).slice(0, INTENT_MAX_STEPS);
  const kept = [];
  for (const [position, step] of sorted.entries()) {
    const next = sorted[position + 1];
    // An explicit end wins; a missing one means "up to the step before the next
    // test step", and the last one runs to the end of the recording.
    const rawEnd = step.open && next ? next.start - 1
      : step.end === null ? (next ? next.start - 1 : total) : step.end;
    let end = Math.min(Math.max(rawEnd, step.start - 1), total);
    // Overlapping the previous test step is the one thing that cannot be
    // represented, so the later test step yields.
    const previous = kept[kept.length - 1];
    if (previous && step.start <= previous.end) continue;
    const open = !next && (step.open || (step.end === null && end === total));
    if (open) end = total;
    kept.push({ ...step, end, open });
  }
  result.steps = kept;

  // Migrate the old global values into the first test step so they are not
  // lost. The tester can move them to the step they actually belong to; the
  // document no longer prints a global goal, preconditions or pass criteria.
  if (legacyGoal) {
    if (kept.length > 0) {
      if (!kept.some(step => step.goal)) kept[0].goal = legacyGoal;
    } else {
      result.note = legacyGoal;
    }
  }
  if (legacySetup) {
    if (kept.length > 0) {
      if (!kept.some(step => step.preconditions.length > 0)) {
        kept[0].preconditions = linesOf(legacySetup);
      }
    } else {
      result.setup = legacySetup;
    }
  }
  if (legacyPass) {
    if (kept.length > 0) {
      if (!kept.some(step => step.pass.length > 0)) {
        kept[0].pass = linesOf(legacyPass);
      }
    } else {
      result.pass = legacyPass;
    }
  }

  const hasContent = Object.entries(result)
    .some(([key, value]) => key !== "steps" && value) || result.steps.length > 0;
  return hasContent ? result : null;
}

function legacyEntry(caseRecord) {
  return { ...indexEntryFor(caseRecord), legacy: true };
}

/**
 * Rewrites one case's annotation, leaving its steps untouched.
 *
 * Keep the media references and any linked workspace in the same commit.
 */
export async function updateIntent(caseId, intent, { workspaceKey } = {}) {
  const detail = await readDetail(caseId);
  if (!detail) return undefined;
  const clean = sanitizeIntent(intent, detail.actions?.length);
  const next = { ...detail };
  if (clean) next.intent = clean;
  else delete next.intent;
  await chrome.storage.local.set({
    ...(workspaceKey ? { [workspaceKey]: clean } : {}),
    [detailKey(caseId)]: next,
    [mediaKey(caseId)]: screenshotKeysOf(next.actions)
  });
  return clean;
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
  const referenced = keys.flatMap(key => stored[key] || []);
  return new Set(referenced.filter(key => !isIntentPoolKey(key)));
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
    const screenshots = listed || screenshotKeysOf((await readDetail(id))?.actions);
    keys.push(...screenshots.filter(key => !isIntentPoolKey(key)));
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
  const detail = detailRecordFor(caseRecord);
  await chrome.storage.local.set({
    ...extraWrites,
    [INDEX_KEY]: nextIndex,
    [detailKey(entry.id)]: detail,
    [mediaKey(entry.id)]: screenshotKeysOf(detail.actions)
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
    const entry = entries[index];
    const detail = detailRecordFor(records[index]);
    writes[detailKey(entry.id)] = detail;
    writes[mediaKey(entry.id)] = screenshotKeysOf(detail.actions);
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
export async function moveCasesToFolder(caseIds, folderId, { namesById = new Map(), extraWrites = {} } = {}) {
  const ids = new Set(caseIds || []);
  const index = await readIndex();
  let movedCount = 0;
  const nextIndex = index.map(entry => {
    if (!ids.has(entry.id) || (entry.folderId || null) === folderId) return entry;
    movedCount++;
    const renamed = namesById.has(entry.id) ? { ...entry, name: namesById.get(entry.id) } : entry;
    if (folderId) return { ...renamed, folderId };
    const { folderId: ignored, ...unfiled } = renamed;
    return unfiled;
  });
  if (movedCount > 0) await chrome.storage.local.set({ ...extraWrites, [INDEX_KEY]: nextIndex });
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
