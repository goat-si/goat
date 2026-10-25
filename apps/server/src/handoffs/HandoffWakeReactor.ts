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
  CLOUD_AGENT_LAUNCH_HANDOFF_PATH,
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
import { HOST_SYNC_PATH, settledSyncWake } from "../provider/approvedSyncs.ts";
import {
  ProviderSettingsProgress,
  type ProviderSettingsOutcome,
} from "../provider/ProviderSettingsProgress.ts";
import { forkParked } from "../serverActivation.ts";
import * as Handoffs from "./Handoffs.ts";
import { goatCallText } from "@goat/contracts/agentSurface/callText";

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
const decodeProgress = Schema.decodeUnknownOption(Schema.toCodecJson(ProviderSettingsProgress));

/** What GOAT did with a provider change it applies itself, once the apply finished. */
const appliedText = (outcome: ProviderSettingsOutcome | undefined) => {
  switch (outcome?.state) {
    case "failed":
      return `GOAT could not apply it (${outcome.reason}: ${outcome.message}). Ask again only if the user still wants it.`;
    case "unknown_outcome":
      return `GOAT cannot tell whether its ${outcome.effect} step happened (${outcome.message}). Call ${goatCallText("provider.diagnose", JSON.stringify(outcome.reconcile.arguments))} to settle it before asking again.`;
    default:
      return `GOAT applied it; ${goatCallText("provider.diagnose")} shows the provider now.`;
  }
};

/** How a provider change GOAT applied after the approval ended, for the wake text and summary. */
type Applied = { readonly text: string; readonly summary?: string };

const appliedFrom = (path: string, progress: unknown): Applied => {
  if (path === HOST_SYNC_PATH) return settledSyncWake(progress);
  const outcome = Option.getOrUndefined(decodeProgress(progress))?.outcome;
  return {
    text: appliedText(outcome),
    ...(outcome === undefined ? {} : { summary: outcome.state }),
  };
};

const continuation = (handoff: Handoff, applied: Applied | undefined) => {
  if (handoff.state !== "completed")
    return "Nothing ran. Ask again only if the user still wants it.";
  if (applied !== undefined) return applied.text;
  if (isHubDeviceHandoffPath(handoff.target.path))
    return `Call ${goatCallText(handoff.target.path === "hub.device_join" ? "hub.device_join" : handoff.target.path === "hub.device_leave" ? "hub.device_leave" : "hub.device_repair")} again with decisionId "${handoff.handoffId}" to continue.`;
  if (handoff.target.path === CLOUD_AGENT_LAUNCH_HANDOFF_PATH)
    return `Call ${goatCallText("cloud_agent.launch")} again with the same arguments and handoffId "${handoff.handoffId}".`;
  if (handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH)
    return `This turn has the cua-driver tools until the admission ends; ${goatCallText("computer_use.request")} reports it.`;
  return "GOAT continues it; check its status before acting.";
};

/** The wake for a handoff's current state, or undefined when the asking thread needs none. */
const handoffWake = (handoff: Handoff, applied?: Applied): LaunchWatchWake | undefined => {
  if (!ENDED.has(handoff.state) || handoff.kind === "secret") return undefined;
  // An approval tied to its run expired because that run ended; waking would ask again forever.
  if (handoff.state === "expired" && endsWithItsRun(handoff)) return undefined;
  // The asking agent ended it itself.
  if (handoff.actor.type === "agent") return undefined;
  const state = handoff.state as keyof typeof VERB;
  // The person's device label stays out of the agent's transcript.
  const by = handoff.actor.type === "server" ? "GOAT" : "a person";
  const key = `handoff-wake:${handoff.handoffId}:${state}`;
  const summary = `${handoff.title}: ${applied?.summary ?? VERB[state]}`;
  return {
    commandId: CommandId.make(`server:${key}`),
    messageId: MessageId.make(`message:${key}`),
    text: `The handoff "${handoff.title}" (${handoff.handoffId}, ${handoff.target.path}) was ${VERB[state]} by ${by}. ${continuation(handoff, applied)}`,
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
  const handoffs = yield* Handoffs.Handoffs;
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
   * id. Each wake remembers its next attempt and when it may run, so a tick makes at most one
   * fresh attempt and waits longer after each failure; only the first try after a restart walks
   * past earlier rejected ids. A long failure retries ever more slowly but never stops.
   * The wait counts from when the attempt failed, however long the dispatch took.
   */
  const retries = new Map<
    string,
    { readonly next: number; readonly failedAt: number; readonly eligibleAt: number }
  >();
  const dispatchWake = Effect.fn("HandoffWakeReactor.dispatchWake")(function* (
    threadId: ThreadId,
    wake: LaunchWatchWake,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const retry = retries.get(wake.messageId) ?? { next: 0, eligibleAt: 0 };
    if (now < retry.eligibleAt) return;
    for (let attempt = retry.next; ; attempt++) {
      const sent = yield* wakeThread(threads, threadId, {
        ...wake,
        ...(attempt === 0
          ? {}
          : { commandId: CommandId.make(`${wake.commandId}:attempt:${attempt}`) }),
      }).pipe(Effect.result);
      if (sent._tag === "Success") {
        retries.delete(wake.messageId);
        return;
      }
      // An earlier rejection under this id: move on without spending a fresh attempt.
      if (sent.failure._tag === "OrchestratorCommandPreviouslyRejectedError") continue;
      const failedAt = DateTime.toEpochMillis(yield* DateTime.now);
      retries.set(wake.messageId, {
        next: attempt + 1,
        failedAt,
        eligibleAt: failedAt + retryAfterMs(attempt + 1),
      });
      return yield* sent.failure;
    }
  });
  /** Forgets wakes the last reconcile no longer offers: delivered, outside its window, or gone. */
  const forgetRetries = (offered: ReadonlySet<string>, before: number) =>
    Effect.sync(() => {
      for (const [messageId, retry] of retries)
        if (!offered.has(messageId) && retry.failedAt < before) retries.delete(messageId);
    }).pipe(permit.withPermits(1));

  const deliver = Effect.fn("HandoffWakeReactor.deliver")(
    function* (handoff: Handoff, since: string) {
      const wake = handoffWake(handoff);
      if (wake === undefined) return;
      const resolvedAt =
        handoff.resolvedAt === undefined ? undefined : DateTime.formatIso(handoff.resolvedAt);
      if (resolvedAt === undefined || resolvedAt < since) return;
      const threadId = handoff.requestedBy.threadId;
      const shell = yield* threads.getThreadShell(threadId);
      if (
        shell === null ||
        shell.deletedAt !== null ||
        shell.archivedAt !== null ||
        (yield* delivered(wake.messageId))
      ) {
        retries.delete(wake.messageId);
        return;
      }
      // A person ending an approved computer use admission (Stop, Stop all, End computer use)
      // stopped that agent: waking it would start a turn that takes the screen again (#1521).
      // Its approval's wake is withdrawn here, after any delivery this reactor had under way, and
      // again on each reconcile until it is gone. A pending request a person cancels still wakes
      // the agent waiting on it.
      if (handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH) {
        const current = yield* handoffs.read({ threadId, handoffId: handoff.handoffId });
        if (yield* handoffs.computerUseEndedByPerson(current))
          return yield* handoffs.withdrawComputerUseWake({
            threadId,
            handoffId: handoff.handoffId,
          });
        // A late event for a state this grant has left wakes nothing; its current state does.
        if (current.state !== handoff.state) return;
      }
      if (
        handoff.state !== "completed" ||
        !Handoffs.isProviderContinuationPath(handoff.target.path)
      )
        return yield* dispatchWake(threadId, wake);
      // GOAT applies these after the approval; wake once that ends, with how it ended. Until then
      // each reconcile finds the wake still owed.
      const state = yield* handoffs.providerApplyState({ threadId, handoffId: handoff.handoffId });
      if (state.applying) return;
      const applied = appliedFrom(handoff.target.path, state.progress);
      yield* dispatchWake(threadId, handoffWake(handoff, applied) ?? wake);
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
    const startedAt = yield* DateTime.now;
    const windowStart = DateTime.formatIso(
      DateTime.subtract(startedAt, { hours: RECONCILE_WINDOW_HOURS }),
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
    const offered = new Set<string>();
    for (const row of rows) {
      if (row.handoff_json === null) continue;
      const handoff = decodeHandoff(row.handoff_json);
      if (Option.isNone(handoff)) continue;
      const wake = handoffWake(handoff.value);
      if (wake !== undefined) offered.add(wake.messageId);
      yield* deliver(handoff.value, since.value);
    }
    // A wake the tail started after this read began keeps its retry state.
    yield* forgetRetries(offered, DateTime.toEpochMillis(startedAt));
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
