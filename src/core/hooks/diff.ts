export function diffOrdering(
  before: readonly string[],
  after: readonly string[],
): { added: readonly string[]; removed: readonly string[]; reordered: boolean } {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);

  const added = after.filter((extId) => !beforeSet.has(extId));
  const removed = before.filter((extId) => !afterSet.has(extId));
  const reordered = before.some(
    (extId, beforeIndex) => afterSet.has(extId) && after.indexOf(extId) !== beforeIndex,
  );

  return { added, removed, reordered };
}
