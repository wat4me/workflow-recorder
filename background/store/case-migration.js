/**
 * Case store readiness and the v1 -> v2 conversion.
 *
 * Every case route waits on `ready()` before it touches storage, which is what
 * removes "half migrated" as a state anyone has to handle: a request that
 * arrives while the conversion is running simply waits for it. The promise is
 * memoized per worker, so concurrent routes and the install handler share one
 * conversion instead of racing to write `schemaVersion`.
 *
 * The conversion is resumable because a Service Worker can be terminated at any
 * point. Details and media lists are written in idempotent batches keyed by case
 * id; the index and the version number are committed in a single write at the
 * end; and the v1 array -- the only other copy of the data -- is deleted only
 * after that commit has been read back.
 *
 * A failed attempt leaves the v1 array in place and reports `writable: false`.
 * Reads keep working off the old layout (see case-store.js), writes are refused,
 * and the next worker start retries from the beginning rather than from the last
 * batch: a failure in the verification step means some record did not persist,
 * and resuming past it would fail forever.
 */
import * as caseStore from "./case-store.js";
import { MIGRATABLE_FROM, SCHEMA_VERSION } from "./schema.js";

const VERSION_KEY = "schemaVersion";
const PROGRESS_KEY = "caseStoreMigration";
// Cases per storage round trip. Small enough that an interrupted conversion
// loses little work, large enough that a normal history is a couple of writes.
const BATCH_SIZE = 20;

export function createCaseStoreCoordinator() {
  let readyPromise = null;

  function ready() {
    if (!readyPromise) {
      readyPromise = resolveState().catch(error => {
        console.error("[Case Store] Readiness check failed:", error?.message);
        return {
          ok: false,
          writable: false,
          reason: "unavailable",
          error: error?.message || String(error),
          version: null,
          expected: SCHEMA_VERSION
        };
      });
    }
    return readyPromise;
  }

  return { ready };
}

async function resolveState() {
  const data = await chrome.storage.local.get([
    VERSION_KEY,
    caseStore.INDEX_KEY,
    caseStore.LEGACY_KEY,
    PROGRESS_KEY
  ]);
  const stored = data[VERSION_KEY];

  // A profile opened by a later build. Reading its cases would be guesswork and
  // writing to them would corrupt data that build still owns.
  if (Number(stored) > SCHEMA_VERSION) {
    return { ok: false, writable: false, reason: "newer", version: stored, expected: SCHEMA_VERSION };
  }

  if (Number(stored) === SCHEMA_VERSION && Array.isArray(data[caseStore.INDEX_KEY])) {
    return { ok: true, writable: true, version: SCHEMA_VERSION };
  }

  // `undefined` predates versioning entirely, and that data has the v1 shape.
  if (stored !== undefined && Number(stored) !== SCHEMA_VERSION && !MIGRATABLE_FROM.has(Number(stored))) {
    return { ok: false, writable: false, reason: "unsupported", version: stored, expected: SCHEMA_VERSION };
  }

  const legacyRecords = Array.isArray(data[caseStore.LEGACY_KEY]) ? data[caseStore.LEGACY_KEY] : [];
  const convertible = legacyRecords.filter(record => record?.id);
  if (convertible.length !== legacyRecords.length) {
    console.warn(
      `[Case Store] Dropping ${legacyRecords.length - convertible.length} v1 case record(s) without an id.`
    );
  }
  if (convertible.length === 0) return initialize();
  return migrate(convertible, data[PROGRESS_KEY], stored);
}

/** Fresh profile, or a v1 profile that never saved a case. */
async function initialize() {
  await chrome.storage.local.set({
    [caseStore.INDEX_KEY]: [],
    [VERSION_KEY]: SCHEMA_VERSION,
    [PROGRESS_KEY]: null
  });
  await chrome.storage.local.remove(caseStore.LEGACY_KEY);
  return { ok: true, writable: true, version: SCHEMA_VERSION, initialized: true };
}

async function migrate(records, progress, storedVersion) {
  const from = Number(storedVersion) || 1;
  // Only an interrupted run resumes. A previously failed run starts over so a
  // record that never persisted gets rewritten instead of re-verified.
  const resumeAt = progress?.status === "running" && Number.isInteger(progress.nextIndex)
    ? Math.min(Math.max(progress.nextIndex, 0), records.length)
    : 0;

  try {
    await setProgress({ from, status: "running", nextIndex: resumeAt, total: records.length });

    for (let start = resumeAt; start < records.length; start += BATCH_SIZE) {
      const batch = records.slice(start, start + BATCH_SIZE);
      const writes = {};
      for (const record of batch) {
        writes[caseStore.detailKey(record.id)] = caseStore.detailRecordFor(record);
        writes[caseStore.mediaKey(record.id)] = caseStore.screenshotKeysOf(record.actions);
      }
      await chrome.storage.local.set(writes);
      await setProgress({ from, status: "running", nextIndex: start + batch.length, total: records.length });
    }

    // Rebuilt in full on every attempt. It is metadata only, so this costs
    // nothing, and it makes a partial index impossible to commit.
    const index = caseStore.sortIndex(records.map(caseStore.indexEntryFor));
    await verifyRecords(index);

    await chrome.storage.local.set({
      [caseStore.INDEX_KEY]: index,
      [VERSION_KEY]: SCHEMA_VERSION,
      [PROGRESS_KEY]: {
        from,
        to: SCHEMA_VERSION,
        status: "committed",
        nextIndex: records.length,
        total: records.length,
        committedAt: Date.now()
      }
    });

    const committed = await chrome.storage.local.get([caseStore.INDEX_KEY, VERSION_KEY]);
    if (
      !Array.isArray(committed[caseStore.INDEX_KEY]) ||
      committed[caseStore.INDEX_KEY].length !== index.length ||
      Number(committed[VERSION_KEY]) !== SCHEMA_VERSION
    ) {
      throw new Error("converted case index could not be read back");
    }

    // Safe now, and only now: the new layout is committed and verified.
    await chrome.storage.local.remove(caseStore.LEGACY_KEY);
    console.log(`[Case Store] Converted ${index.length} case(s) to schema ${SCHEMA_VERSION}.`);
    return { ok: true, writable: true, version: SCHEMA_VERSION, migrated: index.length };
  } catch (error) {
    await setProgress({
      from,
      status: "failed",
      nextIndex: resumeAt,
      total: records.length,
      error: error?.message || String(error)
    }).catch(() => {});
    console.error("[Case Store] Conversion failed, keeping v1 data:", error?.message);
    return {
      ok: false,
      writable: false,
      reason: "migration-failed",
      error: error?.message || String(error),
      version: from,
      expected: SCHEMA_VERSION
    };
  }
}

/**
 * Confirms every index entry has a detail record before the v1 array is dropped.
 * Batched, so verification never holds the whole history in memory either.
 */
async function verifyRecords(index) {
  for (let start = 0; start < index.length; start += BATCH_SIZE) {
    const batch = index.slice(start, start + BATCH_SIZE);
    const stored = await chrome.storage.local.get(batch.map(entry => caseStore.detailKey(entry.id)));
    for (const entry of batch) {
      const detail = stored[caseStore.detailKey(entry.id)];
      if (!detail) throw new Error(`case ${entry.id} was not converted`);
      // An unreadable v1 record is copied verbatim and stays flagged unreadable;
      // demanding a step count from it would fail the whole conversion over data
      // that was already broken.
      if (!entry.readable) continue;
      if (!Array.isArray(detail.actions) || detail.actions.length !== entry.stepCount) {
        throw new Error(`case ${entry.id} converted with ${detail.actions?.length} of ${entry.stepCount} steps`);
      }
    }
  }
}

function setProgress(progress) {
  return chrome.storage.local.set({
    [PROGRESS_KEY]: { to: SCHEMA_VERSION, updatedAt: Date.now(), ...progress }
  });
}
