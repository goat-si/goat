/**
 * Effect evidence from the bound window's accessibility tree: an input the driver calls a
 * suspected no-op is confirmed when one read after it differs from the full read just before it.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { ScreenRunError } from "@goat/contracts";
import { classifyActionOutcome } from "@goat/shared/actionOutcomeSafety";
import { CELL_RESERVE_MS, driverCallCapMs } from "../cua/ComputerUseCallCaps.ts";
import type { DesktopRow } from "./DesktopObserveRead.ts";
import type { ScreenHostDispatchResult } from "./ScreenHostBridge.ts";

const COMPLETED_WRITE = classifyActionOutcome({
  effect: "write",
  status: "completed",
  dispatched: true,
});

/** A whole, uncut tree read of one window under one driver, the only read a change is told from. */
export interface TreeBaseline {
  readonly rows: ReadonlyArray<DesktopRow>;
  readonly windowId: number;
  readonly connectionGeneration: string;
}

const bareRole = (role: string) => role.toLowerCase().replace(/^ax/, "");
// Focus and frames move on any click, and indexes shift with the rows above; neither is an effect.
const keyOf = (row: DesktopRow) =>
  JSON.stringify([bareRole(row.role), row.name, row.text ?? null, row.selected ?? null]);
const shown = (row: DesktopRow) =>
  `${bareRole(row.role)} ${JSON.stringify((row.name || row.text || "").slice(0, 40))}`;

/** The rows of from that against does not hold, counting repeats. */
const unmatched = (from: ReadonlyArray<DesktopRow>, against: ReadonlyArray<DesktopRow>) => {
  const counts = new Map<string, number>();
  for (const row of against) counts.set(keyOf(row), (counts.get(keyOf(row)) ?? 0) + 1);
  return from.filter((row) => {
    const left = counts.get(keyOf(row)) ?? 0;
    if (left === 0) return true;
    counts.set(keyOf(row), left - 1);
    return false;
  });
};

/** The evidence line for two reads of one window that differ, or undefined when they agree. */
const treeChange = (
  before: ReadonlyArray<DesktopRow>,
  after: ReadonlyArray<DesktopRow>,
): string | undefined => {
  const added = unmatched(after, before);
  const removed = unmatched(before, after);
  const [first] = added.length > 0 ? added : removed;
  if (first === undefined) return undefined;
  return `observed:tree_changed:+${added.length} -${removed.length} ${added.length > 0 ? "+" : "-"}${shown(first)}`;
};

/**
 * A suspected no-op read once more when a full read came right before it. The cell would stop
 * on it anyway, so this read retiring the earlier refs costs nothing; a read that fails or finds
 * the tree unchanged, another window or driver, or a close (proven only by the window list),
 * leaves the driver's verdict.
 */
export const confirmByTree = Effect.fn("DesktopTreeEffect.confirmByTree")(function* (
  result: ScreenHostDispatchResult,
  baseline: TreeBaseline | undefined,
  read: Effect.Effect<TreeBaseline | undefined, ScreenRunError>,
  deadlineMillis: number,
  closing: boolean,
) {
  if (
    closing ||
    result.category !== "suspected_noop" ||
    baseline === undefined ||
    baseline.rows.length === 0
  )
    return result;
  const now = yield* Clock.currentTimeMillis;
  if (deadlineMillis - now - CELL_RESERVE_MS < driverCallCapMs("get_window_state", {}))
    return result;
  const after = yield* read.pipe(Effect.orElseSucceed(() => undefined));
  const change =
    after === undefined ||
    after.windowId !== baseline.windowId ||
    after.connectionGeneration !== baseline.connectionGeneration
      ? undefined
      : treeChange(baseline.rows, after.rows);
  if (change === undefined) return result;
  return {
    ...result,
    category: "confirmed" as const,
    safety: COMPLETED_WRITE,
    evidence: [...(result.evidence ?? []), change].slice(0, 16),
  };
});
