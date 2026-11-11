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
  | {
      readonly type: "retire";
      readonly record: DetachedAppServerRecord;
      /** Fences or survivor bindings guard other threads, so the record stays (unlisted). */
      readonly keep: boolean;
    }
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
 * (no members, socket refusing) is given up; a live, unverifiable or reused group is refused, and
 * a record whose fences still guard other threads stays for them while this session starts anew.
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
  return { type: "retire", record, keep: guarded.size > 0 } as const;
});

/** Applies the decision: "connect" leaves the record for connectExisting; the others free the session to spawn. */
export const settleKeptRecord = Effect.fn("CodexDetachedAppServers.settleKept")(function* <E>(
  input: Omit<Parameters<typeof decideKeptRecord>[0], "globallyBlocked"> & {
    readonly globallyBlocked: Effect.Effect<string | undefined>;
    /**
     * Re-reads the record's fences under the record gate: "own" when one guards this thread,
     * "kept" when others are guarded (or keep), otherwise removes it.
     */
    readonly retire: (
      record: DetachedAppServerRecord,
      threadId: ThreadId,
      keep: boolean,
    ) => Effect.Effect<"removed" | "kept" | "own", E>;
    readonly unlist: Effect.Effect<unknown>;
  },
) {
  const decision = yield* decideKeptRecord({
    ...input,
    globallyBlocked: yield* input.globallyBlocked,
  });
  if (decision.type === "refuse")
    return yield* new CodexDetachedAppServerError({ detail: decision.detail });
  if (decision.type === "connect") return "connect" as const;
  const retired = yield* input.retire(decision.record, input.threadId, decision.keep);
  if (retired === "own")
    return yield* new CodexDetachedAppServerError({ detail: ownTurn(decision.record) });
  if (retired === "removed") return "retire" as const;
  yield* input.unlist;
  return "unlist" as const;
});
