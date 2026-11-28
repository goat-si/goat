import type { ThreadCheckpointSummary } from "@goat/client-runtime/state/thread-checkpoints";

export function setsEqual<T>(left: ReadonlySet<T>, right: ReadonlySet<T>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) if (!right.has(value)) return false;
  return true;
}

// Summaries are re-derived whenever messages change, including streamed text,
// so a new array often holds the same checkpoints.
export function checkpointSummariesEqual(
  left: ReadonlyArray<ThreadCheckpointSummary> | undefined,
  right: ReadonlyArray<ThreadCheckpointSummary> | undefined,
): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined || left.length !== right.length) return false;
  return left.every((summary, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      summary.checkpointId === other.checkpointId &&
      summary.scopeId === other.scopeId &&
      summary.runId === other.runId &&
      summary.checkpointTurnCount === other.checkpointTurnCount &&
      summary.checkpointRef === other.checkpointRef &&
      summary.completedAt === other.completedAt &&
      summary.status === other.status &&
      summary.files === other.files &&
      summary.assistantMessageId === other.assistantMessageId
    );
  });
}

export function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) {
    if (!right.has(key) || right.get(key) !== value) return false;
  }
  return true;
}

export function setMapsEqual<K, V>(
  left: ReadonlyMap<K, ReadonlySet<V>>,
  right: ReadonlyMap<K, ReadonlySet<V>>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, values] of left) {
    const other = right.get(key);
    if (other === undefined || !setsEqual(values, other)) return false;
  }
  return true;
}

/** Index of the first entry that differs, or the shorter length when one extends the other. */
export function firstChangedIndex<T>(previous: ReadonlyArray<T>, next: ReadonlyArray<T>): number {
  const limit = Math.min(previous.length, next.length);
  let index = 0;
  while (index < limit && previous[index] === next[index]) index += 1;
  return index;
}
