import type * as DateTime from "effect/DateTime";

export type PiCompactionStatus = "running" | "completed" | "failed" | "cancelled";
export function compactionTitle(status: PiCompactionStatus): string {
  switch (status) {
    case "running":
      return "Compacting context...";
    case "completed":
      return "Context compacted";
    case "failed":
      return "Context compaction failed";
    case "cancelled":
      return "Context compaction stopped";
  }
}

export interface PiCompactionState {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
}
