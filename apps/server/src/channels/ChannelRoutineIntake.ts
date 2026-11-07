/**
 * ChannelRoutineIntake - ingests admitted routine firings as their owner and settles them from the
 * inbox. Every step repeats safely (fixed idempotency key, ScheduledTaskRuns ignores passed steps),
 * so a restart only repeats work. @module ChannelRoutineIntake
 */
import {
  type ChannelGatewayError,
  type ChannelIngestInput,
  CommandId,
  ScheduledTaskId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ScheduledTaskRuns from "../scheduledTasks/ScheduledTaskRuns.ts";
import { decodeRoutinePayload } from "../scheduledTasks/scheduledBotRoutines.ts";
import * as ChannelGateway from "./ChannelGateway.ts";
import type { ChannelIngressContext } from "./ChannelIngressContext.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";
import { channelOwnerIdFor } from "./channelOwner.ts";
import { inputIdFor } from "./channelIds.ts";
import { ROUTINE_KEY_PREFIX } from "./channelRoutineInputs.ts";

const SETTLED_LINK_DAYS = 7;
const BATCH = 50;

const refusedCopy = (reason: ChannelGatewayError["reason"]) =>
  reason === "forbidden"
    ? "GOAT Bot no longer takes this routine: its conversation was deleted. Set the routine up again."
    : "GOAT Bot could not take this routine's check-in (" + reason + ").";
const ANSWER_FAILED = "GOAT Bot could not answer this routine's check-in.";

const decodeFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ message: Schema.String })),
);

export class ChannelRoutineIntake extends Context.Service<
  ChannelRoutineIntake,
  {
    /** Ingests admitted firings into their bot conversations; returns how many moved. */
    readonly ingestPending: Effect.Effect<number, ChannelLedgerError>;
    /** Settles firings whose input reception finished and prunes old links; returns how many. */
    readonly settle: Effect.Effect<number, ChannelLedgerError>;
  }
>()("goat/channels/ChannelRoutineIntake") {}

interface PendingRow {
  readonly firing_id: string;
  readonly task_id: string;
  readonly payload_json: string;
}

interface FinishedRow {
  readonly firing_id: string;
  readonly inbox_state: string;
  readonly failure_json: string | null;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const gateway = yield* ChannelGateway.ChannelGateway;
  const runs = yield* ScheduledTaskRuns.ScheduledTaskRuns;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const ownerId = channelOwnerIdFor(environmentId);
  const persistence = (detail: string) => (cause: unknown) =>
    new ChannelLedgerError({ reason: "persistence", detail, cause });

  const finish = (firingId: string, outcome: ScheduledTaskRuns.ChannelFiringOutcome, at: string) =>
    runs
      .finishChannelFiring({ firingId: CommandId.make(firingId), outcome, at })
      .pipe(Effect.mapError(persistence("finish routine firing")));

  const settleLink = (firingId: string, error: string | null, at: string) =>
    sql`UPDATE scheduled_task_channel_inputs SET state = 'settled', error = ${error}, settled_at = ${at}
      WHERE firing_id = ${firingId}`.pipe(Effect.mapError(persistence("settle routine link")));

  const refuse = (firingId: string, error: string, at: string) =>
    finish(firingId, { type: "failed", error }, at).pipe(
      Effect.andThen(settleLink(firingId, error, at)),
    );

  const ingestOne = Effect.fn("ChannelRoutineIntake.ingestOne")(function* (
    row: PendingRow,
    at: string,
  ) {
    const decoded = yield* decodeRoutinePayload(row.payload_json).pipe(Effect.option);
    if (Option.isNone(decoded))
      return yield* refuse(row.firing_id, "The routine's check-in could not be read.", at);
    const payload = decoded.value;
    const key = ROUTINE_KEY_PREFIX + row.firing_id;
    const inputId = inputIdFor({
      ownerId,
      kind: "goat",
      connectionId: ChannelGateway.GOAT_CONNECTION_ID,
      idempotencyKey: key,
    });
    yield* sql`UPDATE scheduled_task_channel_inputs SET input_id = ${inputId}
        WHERE firing_id = ${row.firing_id}`.pipe(
      Effect.mapError(persistence("link routine input")),
    );
    const input: ChannelIngestInput = {
      kind: "goat",
      connectionId: ChannelGateway.GOAT_CONNECTION_ID,
      conversationKey: payload.threadId,
      externalMessageId: key,
      idempotencyKey: key,
      actor: {},
      replyAddress: { kind: "goat", environmentId, threadId: payload.threadId },
      text: payload.text,
      attachments: [],
      receivedAt: payload.receivedAt,
      intent: "message",
    };
    // The person who set the routine up, never above approval-required: a firing runs unattended.
    const context: ChannelIngressContext = {
      ownerId,
      principalId: payload.principalId,
      displayName: "Owner",
      grantedScopes: payload.grantedScopes,
      runtimeModeCeiling: "approval-required",
      caller: {
        type: "schedule",
        scheduledTaskId: ScheduledTaskId.make(row.task_id),
        firingId: CommandId.make(row.firing_id),
      },
    };
    const ingested = yield* gateway.ingest(input, context).pipe(
      Effect.map(() => true),
      Effect.catchIf(
        (error) => error.reason !== "persistence_failed",
        (error) => refuse(row.firing_id, refusedCopy(error.reason), at).pipe(Effect.as(false)),
      ),
      Effect.mapError(persistence("ingest routine input")),
    );
    if (!ingested) return;
    yield* finish(row.firing_id, { type: "accepted", threadId: payload.threadId }, at);
    yield* sql`UPDATE scheduled_task_channel_inputs SET state = 'ingested'
        WHERE firing_id = ${row.firing_id} AND state = 'pending'`.pipe(
      Effect.mapError(persistence("mark routine input ingested")),
    );
  });

  /** One routine's failure is logged and retried next pass; the routines after it go on. */
  const isolated = (firingId: string, step: Effect.Effect<boolean, ChannelLedgerError>) =>
    step.pipe(
      Effect.catch((cause) =>
        Effect.logWarning("GOAT Bot routine step failed", { firingId, cause }).pipe(
          Effect.as(false),
        ),
      ),
    );

  // Each pass resumes after the last row the previous one read, wrapping at the end, so rows that
  // keep failing cannot hold back the ones behind them however many there are.
  const pendingAfter = yield* Ref.make("");
  const settleAfter = yield* Ref.make("");
  const advance = (cursor: Ref.Ref<string>, rows: ReadonlyArray<{ readonly firing_id: string }>) =>
    Ref.set(cursor, rows.length === BATCH ? (rows.at(-1)?.firing_id ?? "") : "");

  const ingestPending = Effect.gen(function* () {
    const after = yield* Ref.get(pendingAfter);
    const rows = yield* sql<PendingRow>`
      SELECT firing_id, task_id, payload_json FROM scheduled_task_channel_inputs
      WHERE state = 'pending' AND firing_id > ${after} ORDER BY firing_id LIMIT ${BATCH}`.pipe(
      Effect.mapError(persistence("list pending routine inputs")),
    );
    yield* advance(pendingAfter, rows);
    const at = DateTime.formatIso(yield* DateTime.now);
    let moved = 0;
    for (const row of rows)
      if (yield* isolated(row.firing_id, ingestOne(row, at).pipe(Effect.as(true)))) moved += 1;
    return moved;
  }).pipe(Effect.withSpan("ChannelRoutineIntake.ingestPending"));

  const settle = Effect.gen(function* () {
    const clock = yield* DateTime.now;
    const at = DateTime.formatIso(clock);
    const after = yield* Ref.get(settleAfter);
    const rows = yield* sql<FinishedRow>`
      SELECT l.firing_id, i.state AS inbox_state, i.failure_json
      FROM scheduled_task_channel_inputs l JOIN channel_inbox i ON i.input_id = l.input_id
      WHERE l.state = 'ingested' AND i.state NOT IN ('accepted', 'processing') AND l.firing_id > ${after}
      ORDER BY l.firing_id LIMIT ${BATCH}`.pipe(
      Effect.mapError(persistence("list finished routine inputs")),
    );
    yield* advance(settleAfter, rows);
    let settled = 0;
    for (const row of rows) {
      const failure =
        row.inbox_state === "replied" && row.failure_json === null
          ? undefined
          : Option.match(Option.flatMap(Option.fromNullishOr(row.failure_json), decodeFailure), {
              onNone: () => ANSWER_FAILED,
              onSome: (decoded) => decoded.message,
            });
      const step = finish(
        row.firing_id,
        failure === undefined ? { type: "completed" } : { type: "failed", error: failure },
        at,
      ).pipe(Effect.andThen(settleLink(row.firing_id, failure ?? null, at)), Effect.as(true));
      if (yield* isolated(row.firing_id, step)) settled += 1;
    }
    const cutoff = DateTime.formatIso(
      DateTime.subtractDuration(clock, Duration.days(SETTLED_LINK_DAYS)),
    );
    yield* sql`DELETE FROM scheduled_task_channel_inputs WHERE state = 'settled' AND settled_at < ${cutoff}`.pipe(
      Effect.mapError(persistence("prune routine links")),
    );
    return settled;
  }).pipe(Effect.withSpan("ChannelRoutineIntake.settle"));

  return ChannelRoutineIntake.of({ ingestPending, settle });
});

/** Shares the scheduler's ScheduledTaskRuns layer, so firing changes reach the same subscribers. */
export const layer = Layer.effect(ChannelRoutineIntake, make).pipe(
  Layer.provide(ScheduledTaskRuns.layer),
);
