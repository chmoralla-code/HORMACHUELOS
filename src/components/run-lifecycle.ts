/** Pure run-registry reconciliation used by the desktop shell and browser tests. */
export function reconcileRunIds(
  localIds: Iterable<string>,
  nativeIds: Iterable<string>,
  startingIds: Iterable<string>,
): { activeIds: Set<string>; releasedIds: string[] } {
  const activeIds = new Set(
    [...nativeIds].filter((id) => typeof id === "string" && id.trim()),
  );
  // A submission is reserved synchronously, before the native command has had
  // a chance to register. Preserve that short, legitimate starting window.
  for (const id of startingIds) {
    if (typeof id === "string" && id.trim()) activeIds.add(id);
  }
  const releasedIds = [...localIds].filter((id) => !activeIds.has(id));
  return { activeIds, releasedIds };
}
