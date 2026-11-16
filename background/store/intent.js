/**
 * The intent draft of the open workspace.
 *
 * Recording is incremental: steps are written one at a time, and the tester's
 * annotations have to survive pause/resume, a service-worker restart and a
 * draft switch. They therefore live beside the workspace state (drafts snapshot
 * the key together with the steps) and are copied onto the case record when the
 * workspace is saved.
 *
 * Values are normalised on the way in, so nothing downstream has to trust what
 * a storage write or an older build left behind.
 */
import { sanitizeIntent } from "./case-store.js";

export const INTENT_KEY = "workspaceIntent";

/** The annotation draft, or null when the workspace was never annotated. */
export async function readIntent(stepCount) {
  const stored = await chrome.storage.local.get(INTENT_KEY);
  return sanitizeIntent(stored[INTENT_KEY], stepCount);
}

/**
 * Stores a normalised copy and returns it. An empty annotation removes the key
 * rather than storing null: "never annotated" and "annotated with nothing" must
 * look the same to the document writer.
 */
export async function writeIntent(intent, stepCount) {
  const clean = sanitizeIntent(intent, stepCount);
  if (clean) await chrome.storage.local.set({ [INTENT_KEY]: clean });
  else await chrome.storage.local.remove(INTENT_KEY);
  return clean;
}

/**
 * Moves the boundaries after recorded steps were deleted.
 *
 * A boundary is an index into the recording, so deleting one step shifts every
 * later test step by one. `positions` are the 0-based indexes that were removed;
 * a test step that loses every recorded action is removed. A placeholder
 * waiting for recording stays at the end.
 */
export async function intentAfterRemoval(positions, stepCount) {
  const stored = await chrome.storage.local.get(INTENT_KEY);
  if (!stored[INTENT_KEY]) return {};
  const intent = sanitizeIntent(stored[INTENT_KEY], stepCount);
  const nextCount = stepCount - positions.length;
  const shift = boundary => positions.filter(index => index < boundary).length;

  const steps = (intent?.steps || []).flatMap(step => {
    const start = step.start - shift(step.start - 1);
    const end = step.end - shift(step.end);
    const pending = step.open && step.start === stepCount + 1;
    return start <= end || pending ? [{ ...step, start, end }] : [];
  });
  return { [INTENT_KEY]: sanitizeIntent({ ...intent, steps }, nextCount) };
}
