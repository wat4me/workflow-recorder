/** Names are unique within one folder; existing records are never overwritten. */
export function nameKey(name) {
  return String(name || "").trim().toLowerCase();
}

export function reserveCaseName(name, used) {
  const requested = name.trim().slice(0, 120);
  if (!used.has(nameKey(requested))) {
    used.add(nameKey(requested));
    return requested;
  }
  const numbered = /^(.*)（(\d+)）$/.exec(requested);
  const base = numbered ? numbered[1] : requested;
  let number = numbered ? Math.max(2, Number(numbered[2]) + 1) : 2;
  // Bound the starting number even for a user-entered numeric suffix.
  if (!Number.isSafeInteger(number)) number = 2;
  for (;;) {
    const suffix = `（${number++}）`;
    const candidate = base.slice(0, 120 - suffix.length).trimEnd() + suffix;
    if (used.has(nameKey(candidate))) continue;
    used.add(nameKey(candidate));
    return candidate;
  }
}
