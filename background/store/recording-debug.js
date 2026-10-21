/** Bounded, local diagnostic timeline; independent of action/case queues. */
export const RECORDING_DEBUG_KEY = "recordingDebugTimeline";
export const MAX_DEBUG_EVENTS = 600;
const MAX_DEBUG_BYTES = 600000;

export function createRecordingDebugStore({ storage = chrome.storage.local } = {}) {
  let pending = [];
  let timer = null;
  let tail = Promise.resolve();

  function serialize(task) {
    const result = tail.catch(() => {}).then(task);
    tail = result;
    return result;
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    const batch = pending;
    pending = [];
    if (!batch.length) return tail;
    return serialize(async () => {
      const stored = (await storage.get(RECORDING_DEBUG_KEY))[RECORDING_DEBUG_KEY];
      const events = [...(stored?.events || []), ...batch];
      let dropped = stored?.dropped || 0;
      let bytes = events.reduce((sum, item) => sum + JSON.stringify(item).length * 2, 0);
      while (events.length > MAX_DEBUG_EVENTS || bytes > MAX_DEBUG_BYTES) {
        bytes -= JSON.stringify(events.shift()).length * 2;
        dropped++;
      }
      await storage.set({ [RECORDING_DEBUG_KEY]: { events, dropped } });
    });
  }

  function append(entry) {
    if (!entry || typeof entry.event !== "string") return Promise.resolve();
    // Detach from caller objects and bound individual messages as well as history.
    const json = JSON.stringify(entry);
    if (json.length > 16000) return Promise.resolve();
    pending.push(JSON.parse(json));
    if (pending.length >= 20) return flush();
    if (timer === null) timer = setTimeout(() => { flush().catch(() => {}); }, 250);
    return Promise.resolve();
  }

  async function read() {
    await flush();
    return serialize(async () => {
      const stored = (await storage.get(RECORDING_DEBUG_KEY))[RECORDING_DEBUG_KEY];
      return { format: 1, exportedAt: new Date().toISOString(),
        version: globalThis.chrome?.runtime?.getManifest?.().version,
        events: stored?.events || [], dropped: stored?.dropped || 0,
        limits: { events: MAX_DEBUG_EVENTS, bytes: MAX_DEBUG_BYTES } };
    });
  }

  function clear() {
    clearTimeout(timer);
    timer = null;
    pending = [];
    return serialize(() => storage.set({ [RECORDING_DEBUG_KEY]: { events: [], dropped: 0 } }));
  }

  return { append, read, clear, flush };
}
