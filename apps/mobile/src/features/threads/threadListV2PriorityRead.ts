import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  resolveThreadPriorityRank,
  selectPriorityClear,
  selectPriorityMarkReadTargets,
  withFoldedUnseen,
  type ThreadPriorityReadPlan,
} from "@goat/client-runtime/state/thread-list-priority";

import type { ThreadListV2FoldedUnseen, ThreadListV2Item } from "./threadListV2";

type Plan = ThreadPriorityReadPlan<EnvironmentThreadShell>;

const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;
// Mobile keeps no visit watermark of its own; the server's lastVisitedAt is the read state.
const NO_LOCAL_VISITS: Readonly<Record<string, string | undefined>> = {};

/** Priority's Mark all as read and Clear read threads plans, as the web sidebar builds them. */
export function threadListV2PriorityReadPlans(input: {
  readonly rows: ReadonlyArray<ThreadListV2Item>;
  readonly foldedUnseen: ReadonlyArray<ThreadListV2FoldedUnseen>;
  readonly canOperate: (thread: EnvironmentThreadShell) => boolean;
}): { readonly markAll: Plan; readonly clear: Plan } {
  const { rows, foldedUnseen, canOperate } = input;
  const threads = rows.map((row) => row.thread);
  const wokeAtByKey = new Map(rows.map((row) => [keyOf(row.thread), row.wokeAt]));
  // Work or a request folded under a row keeps it in Priority, as the row's own would.
  const liftedByActiveWork = new Map(
    rows.flatMap((row) =>
      row.lift === "approval" || row.lift === "input" || row.lift === "working"
        ? [[keyOf(row.thread), row.lift] as const]
        : [],
    ),
  );
  const withFolded = (plan: Plan) =>
    withFoldedUnseen(plan, {
      rows: threads,
      unseenUnder: (key) =>
        foldedUnseen.flatMap((entry) => (entry.rowKey === key ? [entry.thread] : [])),
      canOperate,
      // A row in Priority only through unread work folded under it.
      liftedOnly: (row) =>
        !liftedByActiveWork.has(keyOf(row)) &&
        resolveThreadPriorityRank({
          thread: row,
          wokeAt: wokeAtByKey.get(keyOf(row)) ?? null,
          hasChildAttention: false,
        }) === null,
    });
  const targets = selectPriorityMarkReadTargets({
    threads,
    localLastVisitedAtByKey: NO_LOCAL_VISITS,
    wokeAtByKey,
    canOperate,
  });
  return {
    markAll: withFolded({ markRead: targets, releaseKeys: targets.map(keyOf) }),
    clear: withFolded(
      selectPriorityClear({
        threads,
        localLastVisitedAtByKey: NO_LOCAL_VISITS,
        wokeAtByKey,
        attentionByOwnerKey: liftedByActiveWork,
        canOperate,
      }),
    ),
  };
}
