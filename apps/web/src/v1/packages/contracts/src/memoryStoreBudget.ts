import * as DateTime from "effect/DateTime";
import { MEMORY_STORE_BUDGET_BYTES } from "./memory.ts";

/** Over MEMORY_STORE_TARGET_BYTES, log rows the published checkpoint covers are kept one day. */
export const MEMORY_LOG_PRESSURE_RETENTION_MS = 86400000;

/**
 * The whole-store budget reuses live_payload_bytes on the wire so older clients and hub peers
 * decode it; its limit tells it apart from the live payload limit.
 */
export const isMemoryStoreBudgetCapacity = (capacity: {
  readonly dimension: string;
  readonly limit: number;
}) => capacity.dimension === "live_payload_bytes" && capacity.limit === MEMORY_STORE_BUDGET_BYTES;

/** The client label and the agent refusal both open with these words. */
export const MEMORY_STORE_FULL_LABEL = "Memory storage limit reached";

const mib = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MiB`;

/**
 * The refusal text when automatic cleanup already ran and cannot make room now. Shared by the
 * remember path and provider imports so agents and people read the same facts.
 */
export const memoryStoreFullMessage = (input: {
  readonly current: number;
  readonly limit: number;
  /** "unsupported": this environment does not host the hub, so it cannot compact the shared log. */
  readonly reclaim: "completed" | "unsupported";
  readonly nextEligibleAtMs: number | null;
  readonly largestTables: ReadonlyArray<{ readonly table: string; readonly bytes: number }>;
}) =>
  [
    `${MEMORY_STORE_FULL_LABEL}: ${mib(input.current)} of ${mib(input.limit)} used.`,
    input.largestTables.length > 0
      ? `Largest: ${input.largestTables.map((t) => `${t.table} ${mib(t.bytes)}`).join(", ")}.`
      : "",
    input.reclaim === "unsupported"
      ? "This machine does not host the memory hub, so it cannot clean the shared memory log."
      : input.nextEligibleAtMs !== null
        ? `Automatic cleanup already ran and may free more space after ${DateTime.formatIso(DateTime.makeUnsafe(input.nextEligibleAtMs))}; try again then.`
        : "Automatic cleanup already ran and cannot free more space now; sync records expire 30 days after they complete.",
    "Forgetting a memory frees only its own text, so it helps only when many memories are no longer needed (Settings → Memory, or memory_forget). memory_sync_status shows what uses the space.",
  ]
    .filter((part) => part !== "")
    .join(" ");
