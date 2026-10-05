/**
 * Default display name for a session branched off another one.
 *
 * Codex-style branching opens a new session without a title, which shows up in
 * the sidebar as an unnamed copy. Deriving "<source>-2" keeps the relationship
 * visible and gives every further branch a fresh suffix.
 */

// A name that already looks like a branch ("助手-2") collapses back to the base
// before the next suffix is chosen, so branching a branch yields "助手-3" rather
// than "助手-2-2".
function branchBase(sourceName: string): string {
  const trimmed = sourceName.trim();
  const withoutSuffix = trimmed.replace(/-\d+$/, "").trim();
  return withoutSuffix || trimmed;
}

export function nextBranchSessionName(
  sourceName: string,
  existingNames: Iterable<string | undefined | null>,
): string | undefined {
  const source = sourceName.trim();
  if (!source) return undefined;

  const base = branchBase(source);
  const used = new Set<string>();
  for (const name of existingNames) {
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed) used.add(trimmed);
  }

  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
