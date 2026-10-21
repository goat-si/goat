import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export interface ThreadArchiveGateSlot {
  /** Restores a thread's archived turn items before a read; never fails the read. */
  readonly restore: (threadId: string) => Effect.Effect<void>;
  readonly install: (restore: (threadId: string) => Effect.Effect<void>) => void;
}

export const makeThreadArchiveGateSlot = (): ThreadArchiveGateSlot => {
  let current: (threadId: string) => Effect.Effect<void> = () => Effect.void;
  return {
    restore: (threadId) => Effect.suspend(() => current(threadId)),
    install: (restore) => {
      current = restore;
    },
  };
};

const inert: ThreadArchiveGateSlot = { restore: () => Effect.void, install: () => undefined };

/**
 * Where reads of a thread's turn items wait for its archived history to come back. The server
 * provides a slot that the archive service fills when it starts; anywhere else, such as tests
 * and the doctor CLI, every thread reads as whole.
 */
export class ThreadArchiveGate extends Context.Reference<ThreadArchiveGateSlot>(
  "goat/orchestration-v2/ThreadArchiveGate",
  { defaultValue: () => inert },
) {}

/** Thread-scoped reads that return turn items, or number new ones, and so need them present. */
const GATED_READS = [
  "getThreadHistoryPage",
  "getTimelinePage",
  "getNextTurnItemOrdinal",
  "getThreadRecords",
  "getThread",
  "getTurnStartContext",
  "getTurnStartHistory",
  "getThreadProjection",
  "getThreadSnapshot",
  "getThreadSnapshotWindow",
  "getThreadAttachmentIds",
  "getTurnItem",
  "searchThread",
] as const;

type ThreadId = string;
const threadOf = (argument: unknown): ThreadId | undefined =>
  typeof argument === "string"
    ? argument
    : typeof argument === "object" &&
        argument !== null &&
        "threadId" in argument &&
        typeof argument.threadId === "string"
      ? argument.threadId
      : undefined;

/** Runs each gated read only after the thread it names has been restored. */
export function gateThreadReads<S extends Record<(typeof GATED_READS)[number], unknown>>(
  slot: ThreadArchiveGateSlot,
  store: S,
): S {
  const gated: Record<string, unknown> = { ...store };
  for (const name of GATED_READS) {
    // Erased only inside the wrapper: each read keeps its own error and result types through `S`.
    const read = store[name] as (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown>;
    gated[name] = (...args: ReadonlyArray<unknown>) => {
      const threadId = threadOf(args[0]);
      return threadId === undefined
        ? read(...args)
        : Effect.andThen(
            slot.restore(threadId),
            Effect.suspend(() => read(...args)),
          );
    };
  }
  return gated as S;
}
