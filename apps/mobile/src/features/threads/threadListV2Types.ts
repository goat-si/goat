import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { LaunchLift } from "./threadListV2LaunchFold";

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly snoozed: boolean;
  readonly pinned: boolean;
  readonly wokeAt: string | null;
  readonly isLast: boolean;
  /** Launch nesting: 0 for a top-level row. */
  readonly depth?: number;
  /** The most urgent state folded under this row, which its card carries. */
  readonly lift?: LaunchLift | null;
}

/** An unread thread folded under a Priority row; Priority's read actions read it with the row. */
export interface ThreadListV2FoldedUnseen {
  readonly rowKey: string;
  readonly thread: EnvironmentThreadShell;
}
