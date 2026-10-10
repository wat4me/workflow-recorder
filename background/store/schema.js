/**
 * Stored-data versioning.
 *
 * Version 1 kept every saved case in a single `cases` array. Version 2 splits
 * that into `caseIndex`, `caseMedia:<id>` and `case:<id>` (see case-store.js).
 *
 * This is the first version bump with a real migration path. Earlier builds
 * deliberately had none and failed loudly instead, but that answer only works
 * while the data being rejected is data the user can afford to lose. Saved cases
 * are the product, so v1 -> v2 converts rather than refuses; see
 * case-migration.js, which owns the conversion and is the only writer of
 * `schemaVersion`.
 *
 * Bump SCHEMA_VERSION whenever the shape of `actions` or the case store changes
 * in a way older builds cannot read, and add the old number to MIGRATABLE_FROM
 * together with a deterministic, resumable conversion.
 */
export const SCHEMA_VERSION = 2;

/** Versions this build can convert forward from. */
export const MIGRATABLE_FROM = new Set([1]);

/**
 * Validates a saved case before it is loaded into the workspace. Without this,
 * a record from an incompatible build fails as "Cannot read properties of
 * undefined (reading 'length')" by the time it reaches the user.
 */
export function isReadableCase(caseRecord) {
  return !!caseRecord &&
    Array.isArray(caseRecord.actions) &&
    Array.isArray(caseRecord.pages);
}
