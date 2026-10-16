/** Height index for a variable-height list. No DOM nodes or action payloads. */
export function createVirtualWindow(gap = 6) {
  let keys = [];
  let estimate = 130;
  let offsets = [0];
  let dirty = true;
  const heights = new Map();
  function reset(nextKeys, nextEstimate = estimate) {
    keys = nextKeys;
    estimate = nextEstimate;
    const live = new Set(keys);
    for (const key of heights.keys()) if (!live.has(key)) heights.delete(key);
    dirty = true;
  }
  function measure(key, height) {
    if (!Number.isFinite(height) || height <= 0 || Math.abs((heights.get(key) || estimate) - height) < 1) return false;
    heights.set(key, height);
    dirty = true;
    return true;
  }
  function range(scrollTop, viewportHeight, overscan = 500) {
    if (dirty) {
      offsets = [0];
      for (const key of keys) offsets.push(offsets[offsets.length - 1] + (heights.get(key) || estimate) + gap);
      dirty = false;
    }
    function find(position) {
      let low = 0, high = keys.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (offsets[mid + 1] <= position) low = mid + 1;
        else high = mid;
      }
      return Math.min(low, Math.max(0, keys.length - 1));
    }
    const start = find(Math.max(0, scrollTop - overscan));
    const end = Math.min(keys.length, find(scrollTop + viewportHeight + overscan) + 1);
    return { start, end, before: Math.max(0, offsets[start] - gap),
      after: Math.max(0, offsets[keys.length] - offsets[end] - gap) };
  }
  function clear() { heights.clear(); reset([]); }
  return { reset, measure, range, clear };
}
