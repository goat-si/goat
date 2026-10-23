/**
 * Wakes the thread that asked when a person answers its handoff, or a clocked one expires
 * (docs/internals/agent-surface.md, Human steps: Wake). It tails stored handoff updates and, on
 * start and each handoff-expiry tick, reconciles the last day's resolutions, so a restart or a
 * failed dispatch delays a wake instead of losing it. Wake ids derive from the handoff and its
 * state, and a wake whose message exists was delivered.
 *
 * @module HandoffWakeReactor
 */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  CommandId,
  Handoff,
  MessageId,
  endsWithItsRun,
  isHubDeviceHandoffPath,
  type OrchestrationV2DomainEvent,
  type ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type { LaunchWatchWake } from "../mcp/launchWatch.ts";
import { wakeThread } from "../mcp/threadWake.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { forkParked } from "../serverActivation.ts";

const RECONCILE_WINDOW_HOURS = 24;
/** Attempt n waits 2^n seconds after the resolution, at most this long between attempts. */
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;
const retryAfterMs = (attempt: number) => Math.min(2 ** attempt * 1000, MAX_RETRY_DELAY_MS);
const ENDED: ReadonlySet<string> = new Set([
  "completed",
  "declined",
  "cancelled",
  "failed",
  "expired",
]);
const VERB = {
  completed: "approved",
  declined: "declined",
  cancelled: "cancelled",
  failed: "failed",
  expired: "expired",
} as const;
const decodeHandoff = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);

const continuation = (handoff: Handoff) => {
  if (handoff.state !== "completed")
    return "Nothing ran. Ask again only if the user still wants it.";
  if (isHubDeviceHandoffPath(handoff.target.path))
    return `Call ${handoff.target.path === "hub.device_join" ? "goat_hub_device_join" : handoff.target.path === "hub.device_leave" ? "goat_hub_device_leave" : "goat_hub_device_repair"} again with decisionId "${handoff.handoffId}" to continue.`;
  if (handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH)
    return "This turn has the cua-driver tools until the admission ends; goat_computer_use_request reports it.";
  return "GOAT continues it; check its status before acting.";
};

/** The wake for a handoff's current state, or undefined when the asking thread needs none. */
export const handoffWake = (handoff: Handoff): LaunchWatchWake | undefined => {
  if (!ENDED.has(handoff.state) || handoff.kind === "secret") return undefined;
  // An approval tied to its run expired because that run ended; waking would ask again forever.
  if (handoff.state === "expired" && endsWithItsRun(handoff)) return undefined;
  // The asking agent ended it itself.
  if (handoff.actor.type === "agent") return undefined;
  const state = handoff.state as keyof typeof VERB;
  const by = handoff.resolvedBy ?? (handoff.actor.type === "server" ? "GOAT" : "a person");
  const key = `handoff-wake:${handoff.handoffId}:${state}`;
  const summary = `${handoff.title}: ${VERB[state]}`;
  return {
    commandId: CommandId.make(`server:${key}`),
    messageId: MessageId.make(`message:${key}`),
    text: `The handoff "${handoff.title}" (${handoff.handoffId}, ${handoff.target.path}) was ${VERB[state]} by ${by}. ${continuation(handoff)}`,
    notification: { source: { kind: "system" }, outcome: "updated", summary },
  };
};

export class HandoffWakeReactor extends Context.Service<
  HandoffWakeReactor,
  {
    readonly start: Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly reconcile: Effect.Effect<void>;
  }
>()("goat/handoffs/HandoffWakeReactor") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const sql = yield* SqlClient.SqlClient;

  /** Waking began here; older resolutions stay quiet. Absent until the first start. */
  const epoch = sql<{
    readonly since: string;
  }>`SELECT since FROM handoff_wake_epoch WHERE id = 1`.pipe(
    Effect.map((rows) => Option.fromNullishOr(rows[0]?.since)),
  );
  const seedEpoch = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO handoff_wake_epoch (id, since) VALUES (1, ${now}) ON CONFLICT (id) DO NOTHING`;
  });

  const permit = yield* Semaphore.make(1);
  const delivered = (messageId: string) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_messages WHERE message_id = ${messageId}`.pipe(
      Effect.map((rows) => rows.length > 0),
    );
  /**
   * The message id is the delivery record and never changes. A command id the orchestrator once
   * rejected (a transient planning failure) stays rejected, so a retry moves to the next attempt
   * id. Earlier rejected attempts are skipped on every tick; a fresh one waits out its backoff
   * from the resolution, so a long failure retries ever more slowly but never stops retrying.
   */
  const dispatchWake = (
    threadId: ThreadId,
    wake: LaunchWatchWake,
    resolvedAtMs: number,
    attempt = 0,
  ): Effect.Effect<
    void,
    | Orchestrator.OrchestratorV2Error
    | ThreadManagement.ThreadManagementProviderInstanceDisabledError
  > =>
    wakeThread(threads, threadId, {
      ...wake,
      ...(attempt === 0
        ? {}
        : { commandId: CommandId.make(`${wake.commandId}:attempt:${attempt}`) }),
    }).pipe(
      Effect.asVoid,
      Effect.catchIf(
        (error) => error._tag === "OrchestratorCommandPreviouslyRejectedError",
        () =>
          Effect.gen(function* () {
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            if (now < resolvedAtMs + retryAfterMs(attempt + 1)) return;
            yield* dispatchWake(threadId, wake, resolvedAtMs, attempt + 1);
          }),
      ),
    );

  const deliver = Effect.fn("HandoffWakeReactor.deliver")(
    function* (handoff: Handoff, since: string) {
      const wake = handoffWake(handoff);
      if (wake === undefined) return;
      const resolvedAt =
        handoff.resolvedAt === undefined ? undefined : DateTime.formatIso(handoff.resolvedAt);
      if (resolvedAt === undefined || resolvedAt < since) return;
      const threadId = handoff.requestedBy.threadId;
      const shell = yield* threads.getThreadShell(threadId);
      if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) return;
      if (yield* delivered(wake.messageId)) return;
      yield* dispatchWake(
        threadId,
        wake,
        handoff.resolvedAt === undefined ? 0 : DateTime.toEpochMillis(handoff.resolvedAt),
      );
    },
    // One delivery at a time, so the tail and a reconcile never race to a second attempt.
    permit.withPermits(1),
    Effect.catchCause((cause) =>
      Effect.logWarning("handoff wake failed; the next reconcile retries it", { cause }),
    ),
  );

  const handle: HandoffWakeReactor["Service"]["handle"] = (event) =>
    event.type !== "turn-item.updated" ||
    event.payload.type !== "human_handoff" ||
    event.payload.handoff === undefined
      ? Effect.void
      : Effect.gen(function* () {
          const since = yield* epoch;
          if (Option.isNone(since) || event.payload.type !== "human_handoff") return;
          if (event.payload.handoff !== undefined)
            yield* deliver(event.payload.handoff, since.value);
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("handoff wake failed", { cause })));

  const reconcile: HandoffWakeReactor["Service"]["reconcile"] = Effect.gen(function* () {
    const since = yield* epoch;
    if (Option.isNone(since)) return;
    const windowStart = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { hours: RECONCILE_WINDOW_HOURS }),
    );
    const from = since.value > windowStart ? since.value : windowStart;
    // The partial index keeps this to the day's resolved handoffs; delivered wakes drop out here.
    const rows = yield* sql<{ readonly handoff_json: string | null }>`
      SELECT json_extract(item.payload_json, '$.handoff') AS handoff_json
      FROM orchestration_v2_projection_turn_items AS item
      LEFT JOIN orchestration_v2_projection_messages AS message
        ON message.message_id = 'message:handoff-wake:' || item.turn_item_id || ':'
          || json_extract(item.payload_json, '$.handoff.state')
      WHERE item.type = 'human_handoff' AND item.status <> 'waiting'
        AND item.updated_at >= ${from} AND message.message_id IS NULL`;
    for (const row of rows) {
      if (row.handoff_json === null) continue;
      const handoff = decodeHandoff(row.handoff_json);
      if (Option.isSome(handoff)) yield* deliver(handoff.value, since.value);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("handoff wake reconcile failed", { cause })),
  );

  const start: HandoffWakeReactor["Service"]["start"] = Effect.gen(function* () {
    yield* seedEpoch;
    // After activation, so restart recovery does not hold a wake this server just queued. The
    // handoff-expiry tick reconciles after recovery and then on every tick, which also covers a
    // resolution that lands before the tail subscribes.
    yield* forkParked(
      orchestrator.streamDomainEvents.pipe(
        Stream.runForEach(handle),
        Effect.catchCause((cause) => Effect.logWarning("handoff wake stream ended", { cause })),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("handoff wakes did not start", { cause })),
  );

  return HandoffWakeReactor.of({ start, handle, reconcile });
});

export const layer = Layer.effect(HandoffWakeReactor, make);
