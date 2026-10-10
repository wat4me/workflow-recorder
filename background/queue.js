/**
 * Serial task queues.
 *
 * Several unrelated concerns need their own ordering guarantee: action writes
 * must not interleave (they read-modify-write shared storage keys), recording
 * start/stop must not overlap, and child-tab registration must be ordered but
 * must NOT sit behind action writes -- a child page can become interactive
 * before the parent click finishes its 1.2s validation.
 *
 * Each queue used to be an inlined `let tail = Promise.resolve()` plus a
 * bespoke wrapper. Three copies drifted in their error handling, so the
 * pattern lives here once and the label makes failures attributable.
 */
export function createSerialQueue(label) {
  let tail = Promise.resolve();

  /** Appends `fn` to the queue. The returned promise rejects; the queue does not. */
  function enqueue(fn) {
    const task = tail.then(fn);
    tail = task.catch(error => console.error(`[${label}]`, error));
    return task;
  }

  /** Resolves once everything queued so far has settled. */
  enqueue.drain = () => tail;

  return enqueue;
}
