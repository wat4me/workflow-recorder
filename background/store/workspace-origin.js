/**
 * Where the open workspace came from, and what that makes the next save.
 *
 * Loading a case and continuing to record produces a new case that shares a
 * prefix with the one it started from. Nothing recorded that relationship before:
 * `activeCaseId` was the only marker, and it is cleared on the first new step
 * precisely because it means "the workspace matches a saved case", which stops
 * being true. So the origin is tracked separately and survives recording.
 *
 * The snapshot taken at load time is the part that matters. Computing how much of
 * a case was inherited by comparing against the parent's stored steps would stop
 * working the moment the parent is deleted -- and deleting it is allowed while an
 * unsaved derived workspace is open. Comparing against a snapshot taken when the
 * workspace was loaded needs the parent only at load time.
 */
import { fingerprintOf } from "./step-signature.js";

export const ORIGIN_KEY = "workspaceOrigin";

export const RELATION = {
  /** The whole parent was loaded, every inherited step is intact, new steps appended. */
  continued: "continued",
  /**
   * The user deliberately loaded a prefix of the parent and recorded a different
   * continuation from there.
   *
   * This has to be recorded as intent at load time, because the result is
   * indistinguishable from `modified` afterwards: loading steps 1-3 of a six-step
   * case leaves exactly the same workspace as loading all six and deleting the last
   * three. Only the first is a branch; describing both as "modified" would bury the
   * one relationship the graph exists to explain.
   */
  branched: "branched",
  /** An inherited step was changed or removed. */
  modified: "modified"
};

const LINEAGE_VERSION = 1;

export async function readOrigin() {
  const data = await chrome.storage.local.get(ORIGIN_KEY);
  const origin = data[ORIGIN_KEY];
  return origin?.caseId ? origin : null;
}

/** A saved baseline stays saved when continue is clicked without new steps. */
export function savedCaseIdFor(state, actions) {
  if (!actions.length) return null;
  if (state.activeCaseId) return state.activeCaseId;
  const origin = state.workspaceOrigin;
  const original = origin?.originalActions;
  if (!origin?.caseId || origin.deleted || !Array.isArray(original) || original.length !== actions.length) return null;
  return original.every((step, index) => step.actionId === actions[index].id && step.signature === fingerprintOf(actions[index]))
    ? origin.caseId : null;
}

/**
 * The origin state for a case that has just been loaded or saved.
 *
 * Returned rather than written, so the caller can put it in the same storage
 * write as the case itself: an origin that points at a case that failed to save
 * would attribute the next save to something that does not exist.
 */
export function originFor(caseEntry, actions, { branchedFromStep = null } = {}) {
  const origin = {
    caseId: caseEntry.id,
    caseNameSnapshot: caseEntry.name,
    // Only the steps actually loaded. A branch loads a prefix, and the steps left
    // behind are not in the workspace, so they are not something the workspace can
    // be said to have inherited or dropped.
    originalActions: (actions || []).map(action => ({
      actionId: action.id,
      signature: fingerprintOf(action)
    })),
    loadedAt: Date.now()
  };
  // Absent for a full load. Present only when the user picked a step to branch at,
  // which is the one thing that cannot be recovered from the resulting workspace.
  if (Number.isInteger(branchedFromStep) && branchedFromStep > 0) {
    origin.branchedFromStep = branchedFromStep;
  }
  return origin;
}

/**
 * Marks the origin as pointing at a case that no longer exists.
 *
 * The workspace is not cleared: those steps are the user's unsaved work, and the
 * fact that the case they started from was deleted is no reason to discard them.
 * The name snapshot is what keeps the relationship explainable afterwards.
 */
export function tombstone(origin) {
  return { ...origin, deleted: true };
}

/** True while the step is still shared with the case it came from. */
export function isInheritedStep(origin, actionId) {
  if (!origin || !actionId) return false;
  return (origin.originalActions || []).some(entry => entry.actionId === actionId);
}

/**
 * How much of the origin the current workspace still carries.
 *
 * The fork point is the end of the longest prefix that is still the same steps in
 * the same order. Both halves of the comparison are needed: the id catches a step
 * that was removed or reordered, and the signature catches one that kept its id
 * while its meaning changed. Copy-on-write is supposed to make the second case
 * impossible, so this is also the check that would notice if some future edit path
 * forgot to do it.
 */
export function describeFork(origin, actions) {
  const snapshot = origin?.originalActions || [];
  let prefix = 0;
  while (prefix < snapshot.length && prefix < actions.length) {
    const inherited = snapshot[prefix];
    const action = actions[prefix];
    if (action.id !== inherited.actionId) break;
    if (fingerprintOf(action) !== inherited.signature) break;
    prefix++;
  }

  const intact = prefix === snapshot.length;
  const fork = {
    inheritedStepCount: prefix,
    forkedFromActionId: prefix > 0 ? actions[prefix - 1].id : null,
    // Appending to an intact prefix is a continuation, or a branch when the prefix
    // was chosen deliberately. Anything else -- a deleted inherited step, an edited
    // one, a prefix that no longer matches at all -- is a modification, and must
    // not be presented as either.
    relation: !intact
      ? RELATION.modified
      : (origin?.branchedFromStep ? RELATION.branched : RELATION.continued)
  };
  // Kept even when the relation ended up `modified`, so "this started as a branch at
  // step 3 and was then edited" stays explainable rather than collapsing into a
  // plain edit.
  if (origin?.branchedFromStep) fork.branchedFromStep = origin.branchedFromStep;
  return fork;
}

/** The lineage to store on a case saved from this workspace, or null for a root. */
export function lineageFor(origin, actions) {
  if (!origin?.caseId) return null;
  return {
    version: LINEAGE_VERSION,
    parentCaseId: origin.caseId,
    // Kept so the relationship stays explainable after the parent is renamed or
    // deleted; the id alone would leave a dangling reference and nothing to show.
    parentCaseNameSnapshot: origin.caseNameSnapshot || "",
    ...describeFork(origin, actions)
  };
}
