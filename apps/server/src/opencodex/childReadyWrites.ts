import type * as Journal from "./ChildReadyJournal.ts";

type Operation = Journal.ChildReadyOperation;
type Key = keyof Operation;

/**
 * A stage's write onto the record stored now, when another write landed since the stage read.
 * Only the keys this stage changed from what it read are applied. A stage other than the probe
 * never clears paid-request history or replaces a setup that carries a proof, so a request that
 * completed meanwhile is never forgotten and never paid for again.
 */
export const mergeStageWrite = (
  read: Operation | undefined,
  next: Operation,
  current: Operation,
  probe: boolean,
): Operation => {
  const merged: Partial<Record<Key, unknown>> = { ...current };
  const keys = new Set<Key>([
    ...(Object.keys(read ?? {}) as Array<Key>),
    ...(Object.keys(next) as Array<Key>),
  ]);
  for (const key of keys) {
    if (key === "revision" || (read !== undefined && read[key] === next[key])) continue;
    if (key in next) merged[key] = next[key];
    else delete merged[key];
  }
  if (!probe) {
    if (current.probeRequestedFor !== undefined)
      merged.probeRequestedFor = current.probeRequestedFor;
    if (current.setup?.proof !== undefined) merged.setup = current.setup;
  }
  return merged as Operation;
};
