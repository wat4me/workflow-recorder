/**
 * Ordered storage for recorded actions.
 *
 * Actions used to live in a single `actions` array, so every append and every
 * screenshot binding rewrote the entire list. Measured on a 41-step session,
 * that was 3.8 MB of writes to persist 67 KB of data, and the cost grew with
 * the square of the step count.
 *
 * Each action now owns the key `action:<id>` and `actionOrder` holds only ids,
 * so binding a screenshot writes one action and appending writes one action
 * plus a list of ids. Readers still get a plain ordered array.
 */
const ORDER_KEY = "actionOrder";
const ACTION_PREFIX = "action:";

function storageKey(id) {
  return `${ACTION_PREFIX}${id}`;
}

export async function readOrder() {
  const data = await chrome.storage.local.get(ORDER_KEY);
  return Array.isArray(data[ORDER_KEY]) ? data[ORDER_KEY] : [];
}

/** Ordered actions. Ids without a stored record are skipped rather than faked. */
export async function readActions() {
  const order = await readOrder();
  if (order.length === 0) return [];
  const stored = await chrome.storage.local.get(order.map(storageKey));
  return order.map(id => stored[storageKey(id)]).filter(Boolean);
}

export async function countActions() {
  return (await readOrder()).length;
}

export async function readAction(id) {
  if (!id) return null;
  const stored = await chrome.storage.local.get(storageKey(id));
  return stored[storageKey(id)] || null;
}

export async function appendAction(action) {
  const order = await readOrder();
  await chrome.storage.local.set({
    [storageKey(action.id)]: action,
    [ORDER_KEY]: [...order.filter(id => id !== action.id), action.id]
  });
}

/**
 * Merges fields into one stored action. Returns false when the action is gone,
 * which is how a screenshot that finished after its step was deleted is
 * detected.
 *
 * `remove` deletes fields outright rather than setting them to null, because the
 * screenshot state is read as "is this field present": a successful capture that
 * left `screenshotError: null` behind would still look like a step that had
 * failed at some point.
 */
export async function patchAction(id, patch, { remove = [] } = {}) {
  const current = await readAction(id);
  if (!current) return null;
  const next = { ...current, ...patch };
  for (const field of remove) delete next[field];
  await chrome.storage.local.set({ [storageKey(id)]: next });
  // The record as it was. Callers test it for truthiness to detect a step that
  // was deleted mid-flight; a screenshot rebind also needs the key it replaced,
  // and reading it here saves that caller a second lookup.
  return current;
}

/**
 * Re-identifies one action in place, keeping its position.
 *
 * Used for copy-on-write: a step inherited from a saved case keeps that case's
 * action id, which is what marks it as shared. The moment its meaning changes it
 * is no longer that step, so it is given a fresh id and a back-reference. Order
 * and the new record go out together; the old record is dropped afterwards, so an
 * interruption leaves an unreferenced record rather than a gap in the list.
 */
export async function replaceActionId(previousId, nextAction) {
  const order = await readOrder();
  const index = order.indexOf(previousId);
  if (index === -1 || !nextAction?.id) return false;

  const nextOrder = [...order];
  nextOrder[index] = nextAction.id;
  await chrome.storage.local.set({
    [storageKey(nextAction.id)]: nextAction,
    [ORDER_KEY]: nextOrder
  });
  if (nextAction.id !== previousId) await chrome.storage.local.remove(storageKey(previousId));
  return true;
}

/** Replaces the whole list, dropping records the new list no longer references. */
export async function replaceActions(actions) {
  const previousOrder = await readOrder();
  const nextOrder = actions.map(action => action.id).filter(Boolean);
  const retained = new Set(nextOrder);

  const writes = { [ORDER_KEY]: nextOrder };
  for (const action of actions) {
    if (action.id) writes[storageKey(action.id)] = action;
  }
  await chrome.storage.local.set(writes);

  const stale = previousOrder.filter(id => !retained.has(id)).map(storageKey);
  if (stale.length > 0) await chrome.storage.local.remove(stale);
}

export async function clearActions() {
  await replaceActions([]);
}

/** Removes one action by position, returning it so callers can free its media. */
export async function removeActionAt(index) {
  const order = await readOrder();
  if (!Number.isInteger(index) || index < 0 || index >= order.length) return null;

  const [removedId] = order.splice(index, 1);
  const removed = await readAction(removedId);
  await chrome.storage.local.set({ [ORDER_KEY]: order });
  await chrome.storage.local.remove(storageKey(removedId));
  return removed;
}

/** Removes several actions by id behind one order update. */
export async function removeActions(actionIds) {
  const ids = new Set((actionIds || []).filter(Boolean));
  if (ids.size === 0) return [];

  const order = await readOrder();
  const removedIds = order.filter(id => ids.has(id));
  if (removedIds.length === 0) return [];
  const stored = await chrome.storage.local.get(removedIds.map(storageKey));
  await chrome.storage.local.set({ [ORDER_KEY]: order.filter(id => !ids.has(id)) });
  await chrome.storage.local.remove(removedIds.map(storageKey));
  return removedIds.map(id => stored[storageKey(id)]).filter(Boolean);
}

/**
 * Drops `action:` records that `actionOrder` no longer lists. Storage is shared
 * with saved cases, which keep their own copies, so nothing else can reclaim
 * these after an interrupted write.
 */
export async function removeOrphanActions() {
  const order = new Set(await readOrder());
  const all = await chrome.storage.local.get(null);
  const orphans = Object.keys(all).filter(
    key => key.startsWith(ACTION_PREFIX) && !order.has(key.slice(ACTION_PREFIX.length))
  );
  if (orphans.length > 0) await chrome.storage.local.remove(orphans);
  return orphans.length;
}
