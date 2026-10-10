/**
 * A step's semantic identity.
 *
 * Loading a saved case puts its steps into the workspace with their original
 * ids, which is what lets two cases be recognised as sharing a prefix. Ids alone
 * are not enough to claim a step is *unchanged*, though: the worker merges a run
 * of keystrokes into the preceding `type` step, so an inherited step's value can
 * change while its id does not. Comparing signatures is what stops that from
 * being reported as an untouched inherited step.
 *
 * What goes in is what the step means: the action, the page it happened on, how
 * the element is located, and the payload the user supplied. What stays out is
 * everything incidental -- when it was recorded, which screenshot it is showing,
 * what state that capture is in -- so re-capturing a screenshot does not make a
 * step look edited.
 *
 * Deliberately not included: `outerHTML`, `parentChain`, `nearbyTexts` and the
 * other DOM context. It is captured for the exported document, it is large, and
 * it describes the page rather than the step.
 */

const SEPARATOR = "\u0001";
const PAIR = "\u0002";

function normalize(value) {
  if (value === undefined || value === null) return "";
  return String(value).replace(/\s+/g, " ").trim();
}

/** The locator fields, in a fixed order so the result is comparable. */
function describeTarget(target) {
  if (!target) return "";
  const frame = target.frameInfo || {};
  return [
    normalize(target.tagName),
    normalize(target.id),
    normalize(target.name),
    normalize(target.type),
    normalize(target.role),
    normalize(target.accessibleName),
    normalize(target.domPath),
    frame.isIframe ? normalize(frame.frameName || frame.frameUrl || "iframe") : ""
  ].join(PAIR);
}

/** The user-supplied payload, which differs per action type. */
function describePayload(action) {
  switch (action.type) {
    case "navigate":
    case "newPage":
      return normalize(action.url);
    case "type":
      return normalize(action.value);
    case "select":
      return `${normalize(action.label)}${PAIR}${normalize(action.value)}`;
    case "pressKey":
      return normalize(action.key);
    case "drag":
      return describeTarget(action.source);
    default:
      return "";
  }
}

/** The canonical, human-readable signature. */
export function signatureOf(action) {
  if (!action) return "";
  return [
    normalize(action.type),
    normalize(action.pageName) || "page1",
    describeTarget(action.target),
    describePayload(action)
  ].join(SEPARATOR);
}

/**
 * A short stand-in for the signature.
 *
 * The workspace origin snapshot holds one of these per inherited step and is
 * rewritten whenever a case is loaded. Full signatures include DOM paths and
 * accessible names, so a 200-step case would put tens of kilobytes of strings in
 * a single storage key for no benefit: nothing reads them, they are only compared
 * for equality. FNV-1a is enough for that -- a collision would mislabel a step as
 * unchanged, which costs a `continued` where `modified` was correct, and cannot
 * lose data.
 */
export function fingerprintOf(action) {
  const signature = signatureOf(action);
  let hash = 0x811c9dc5;
  for (let index = 0; index < signature.length; index++) {
    hash ^= signature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // The length is folded in so two different signatures that happen to collide
  // still differ whenever their lengths do.
  return `${hash.toString(36)}${signature.length.toString(36)}`;
}
