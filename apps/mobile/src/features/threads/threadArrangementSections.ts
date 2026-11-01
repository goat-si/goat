import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { sortInboxThreadsByReturn } from "@goat/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@goat/client-runtime/state/thread-settled";
import { sortSettledThreads } from "@goat/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@goat/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { getThreadListV2OrderedSection, threadListInboxReturns } from "./threadListV2";
import { threadListV2ReorderExcludedKeys, type LaunchSubagentRow } from "./threadListV2LaunchFold";
import type { PendingThreadOrder } from "./threadOrder";

const keyOf = (thread: EnvironmentThreadShell) => scopedThreadKey(thread.environmentId, thread.id);

export function threadArrangementSections(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly now: string;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly pendingOrder: PendingThreadOrder | null;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly hiddenBotThreadKeys: ReadonlySet<string>;
  readonly workingShelfEnabled: boolean;
  /** Subagent rows, since `threads` leaves them out. */
  readonly launchOwners: readonly LaunchSubagentRow[];
}) {
  const { threads, now, hiddenBotThreadKeys } = input;
  // Folded and lifted rows are placed by their launcher and urgency; arranging leaves them out.
  const excludedThreadKeys = threadListV2ReorderExcludedKeys({
    ...input,
    owners: input.launchOwners,
  });
  const pinned = getThreadListV2OrderedSection({ ...input, section: "pinned", excludedThreadKeys });
  const active = getThreadListV2OrderedSection({ ...input, section: "active", excludedThreadKeys });
  const visible = new Set([...pinned, ...active].map(keyOf));
  const parked = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      !visible.has(keyOf(thread)) &&
      !excludedThreadKeys.has(keyOf(thread)) &&
      !hiddenBotThreadKeys.has(keyOf(thread)),
  );
  return {
    pinned,
    active: input.workingShelfEnabled
      ? sortInboxThreadsByReturn(active, threadListInboxReturns.returnedAt)
      : active,
    snoozed: parked.filter((thread) => effectiveSnoozed(thread, { now })),
    settled: sortSettledThreads(parked.filter((thread) => !effectiveSnoozed(thread, { now }))),
  };
}
