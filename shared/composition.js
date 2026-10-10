/** Validate provenance stored with scene details, including imported snapshots. */
export function sanitizeComposition(value, stepCount) {
  if (!value || value.type !== "sequence" || !Array.isArray(value.sources) ||
      !value.sources.length || value.sources.length > 200) throw new Error("Invalid scene composition");
  let offset = 0;
  const sources = value.sources.map((source, order) => {
    if (!source || source.order !== order || source.startIndex !== offset ||
        !Number.isInteger(source.count) || source.count <= 0 ||
        typeof source.caseName !== "string" || source.caseName.length > 120 ||
        !(source.caseId === null || typeof source.caseId === "string") ||
        !Array.isArray(source.actionIndexes) || source.actionIndexes.length !== source.count ||
        source.actionIndexes.some((index, i) => !Number.isInteger(index) || index < 0 ||
          (i > 0 && index <= source.actionIndexes[i - 1])) ||
        !Array.isArray(source.actionIds) || source.actionIds.length !== source.count ||
        source.actionIds.some(id => typeof id !== "string")) throw new Error("Invalid scene source");
    offset += source.count;
    return { caseId: source.caseId, caseName: source.caseName, order, startIndex: source.startIndex,
      count: source.count, actionIndexes: [...source.actionIndexes], actionIds: [...source.actionIds] };
  });
  if (offset !== stepCount) throw new Error("Scene step count mismatch");
  return { type: "sequence", sources };
}
