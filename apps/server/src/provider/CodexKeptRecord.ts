import type { ProviderSessionId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { DetachedAppServerRecord, DetachedClassification } from "./CodexDetachedAppServer.ts";
import { CodexDetachedAppServerError } from "./CodexDetachedAppServerError.ts";
import { servesSession } from "./CodexRecordSessions.ts";

/** An exiting app-server leaves its group and socket within moments; past this, open refuses. */
const SETTLE_WINDOW = "2 seconds";
const SETTLE_POLL = Schedule.spaced("250 millis");

export interface KeptRecordOpen {
  readonly instanceId: string;
  readonly name: string;
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
  /** Threads whose survivor binding still names this record. */
  readonly survivorThreads: ReadonlyArray<ThreadId>;
}

type KeptRecordDecision =
  | { readonly type: "connect" }
  | { readonly type: "release"; readonly record: DetachedAppServerRecord }
  | { readonly type: "refuse"; readonly detail: string };

const settled = (classification: DetachedClassification) =>
  classification.type === "verified" ||
  classification.type === "mismatch" ||
  (classification.type === "gone" && !classification.possibleLeftovers?.length);

const describe = (record: DetachedAppServerRecord) =>
  "The Codex app-server GOAT kept from before its restart (process group " +
  String(record.pgid) +
  ", socket " +
  record.socketPath +
  ")";

const ownTurn = (record: DetachedAppServerRecord) =>
  describe(record) +
  " has exited while it still held this thread's turn from before the restart. GOAT keeps this thread blocked until that turn is settled; restarting GOAT settles it. Other threads can continue.";

const AGAIN = " GOAT checks again on every message, so send it again once that is done.";

/**
 * Decides how a session opens on a record kept for recovery. Only a group that is provably gone
 * (no members, socket refusing) is released; a live, unverifiable or reused group is refused, and
 * so is a thread its fences or survivor binding still guard.
 */
const decideKeptRecord = Effect.fn("CodexDetachedAppServers.decideKeptRecord")(function* (
  input: KeptRecordOpen & {
    readonly record: DetachedAppServerRecord | undefined;
    readonly busy: boolean;
    readonly globallyBlocked: string | undefined;
    readonly classify: (record: DetachedAppServerRecord) => Effect.Effect<DetachedClassification>;
    readonly warn: (pids: ReadonlyArray<number>) => Effect.Effect<void>;
  },
): Effect.fn.Return<KeptRecordDecision> {
  const record = input.record;
  if (input.globallyBlocked !== undefined)
    return { type: "refuse", detail: input.globallyBlocked } as const;
  if (
    record === undefined ||
    input.busy ||
    record.stderrMode !== "discard" ||
    record.state !== "running" ||
    !servesSession(record, input.instanceId, input.providerSessionId)
  )
    return {
      type: "refuse",
      detail: "The existing Codex process cannot be verified for recovery.",
    } as const;
  const last: { value: DetachedClassification } = { value: { type: "unverifiable" } };
  yield* input.classify(record).pipe(
    Effect.tap((classification) =>
      Effect.sync(() => {
        last.value = classification;
      }),
    ),
    Effect.repeat({ schedule: SETTLE_POLL, until: settled }),
    Effect.timeoutOption(SETTLE_WINDOW),
  );
  const current = last.value;
  if (current.type === "verified") return { type: "connect" } as const;
  if (current.type === "unverifiable")
    return {
      type: "refuse",
      detail:
        describe(record) +
        " is still running, but GOAT cannot confirm it is that process, so it will neither reconnect to it nor start another for this session. If that group's command line names the socket, stop the group." +
        AGAIN,
    } as const;
  if (current.type === "mismatch")
    return {
      type: "refuse",
      detail:
        describe(record) +
        " has exited, and its process group id now belongs to another program. GOAT will not start another Codex app-server for this session until it restarts and settles the record.",
    } as const;
  if (current.possibleLeftovers?.length) {
    yield* input.warn(current.possibleLeftovers);
    return {
      type: "refuse",
      detail:
        describe(record) +
        " has exited, but processes " +
        current.possibleLeftovers.join(", ") +
        " remain in its group. Stop them if they are leftovers of that app-server." +
        AGAIN,
    } as const;
  }
  const guarded = new Set([
    ...(record.goalBlocks ?? []).map((goal) => goal.threadId),
    ...(record.stopObligations ?? []).map((stop) => stop.threadId),
    ...input.survivorThreads,
  ]);
  if (guarded.has(input.threadId)) return { type: "refuse", detail: ownTurn(record) } as const;
  return { type: "release", record } as const;
});

/** Applies the decision: "connect" leaves the record for connectExisting; "release" frees the session to spawn. */
export const settleKeptRecord = Effect.fn("CodexDetachedAppServers.settleKept")(function* <E>(
  input: Omit<Parameters<typeof decideKeptRecord>[0], "globallyBlocked"> & {
    readonly globallyBlocked: Effect.Effect<string | undefined>;
    /** Re-reads the record's fences under the record gate: "own" when one guards this thread. */
    readonly release: (threadId: ThreadId) => Effect.Effect<"released" | "own", E>;
  },
) {
  const decision = yield* decideKeptRecord({
    ...input,
    globallyBlocked: yield* input.globallyBlocked,
  });
  if (decision.type === "refuse")
    return yield* new CodexDetachedAppServerError({ detail: decision.detail });
  if (decision.type === "connect") return "connect" as const;
  if ((yield* input.release(input.threadId)) === "own")
    return yield* new CodexDetachedAppServerError({ detail: ownTurn(decision.record) });
  return "release" as const;
});

const fencedThreads = (record: DetachedAppServerRecord | undefined) => [
  ...(record?.goalBlocks ?? []).map((goal) => goal.threadId),
  ...(record?.stopObligations ?? []).map((stop) => stop.threadId),
];

/**
 * Release bookkeeping, called under the record gate. A thread is guarded by a record's fences or
 * by a fence write of its own that has not landed (failedFences holds it until it does).
 */
export const makeReleases = (state: {
  readonly fences: ReadonlyMap<string, DetachedAppServerRecord>;
  readonly failedFences: ReadonlyMap<string, ThreadId>;
  readonly recoveryRetained: Set<string>;
  readonly released: Set<string>;
}) => {
  const guards = (name: string, threadId: ThreadId) =>
    [...state.failedFences.values(), ...fencedThreads(state.fences.get(name))].includes(threadId);
  return {
    release: (name: string, threadId: ThreadId) => {
      if (guards(name, threadId)) return "own" as const;
      state.recoveryRetained.delete(name);
      state.released.add(name);
      return "released" as const;
    },
    ensureClear: (instanceId: string, session: ProviderSessionId, threadId: ThreadId) => {
      const record = [...state.released]
        .map((name) => state.fences.get(name))
        .find(
          (value) =>
            value !== undefined &&
            servesSession(value, instanceId, session) &&
            guards(value.name, threadId),
        );
      return record === undefined
        ? Effect.void
        : Effect.fail(new CodexDetachedAppServerError({ detail: ownTurn(record) }));
    },
  };
};
