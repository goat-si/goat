import {
  FleetGoal,
  FleetGoalEvent,
  FleetGoalId,
  FleetGoalOwner,
  type FleetGoalPhase,
  FleetGoalSpec,
  FleetGoalStatus,
  GoalWorkerPullRequest,
  GoalWorkerState,
  IsoDateTime,
  ModelSelection,
  NonNegativeInt,
  PositiveInt,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import { PersistenceDecodeError, PersistenceSqlError } from "../../persistence/Errors.ts";

export type GoalStoreError = PersistenceSqlError | PersistenceDecodeError;

/** Events kept per goal; older ones are trimmed on write. */
const GOAL_EVENT_LIMIT = 200;

/** What the controller keeps per slot beyond the public worker status. */
const WorkerDetail = Schema.Struct({
  target: Schema.NullOr(Schema.String),
  pullRequest: Schema.NullOr(GoalWorkerPullRequest),
  lastActivityAt: Schema.NullOr(IsoDateTime),
  reported: Schema.Boolean,
  followUps: NonNegativeInt,
  /** The run a follow-up was last sent about, so each run is nudged once. */
  followedUpRunId: Schema.NullOr(RunId),
  /**
   * The run whose recovery reached an outcome, so each run is recovered once. Rows an earlier
   * controller wrote lack it and mark such runs only in followedUpRunId (#1452).
   */
  recoveredRunId: Schema.NullOr(RunId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The usage-limited run the goal resumed after its reset, so it is resumed once. */
  resumedRunId: Schema.NullOr(RunId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The run a stall was steered on, so a second stall reschedules. */
  steeredRunId: Schema.NullOr(RunId),
  lastRunId: Schema.NullOr(RunId),
  note: Schema.NullOr(Schema.String),
});

export const WorkerRecord = Schema.Struct({
  slot: NonNegativeInt,
  attempt: PositiveInt,
  host: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(ThreadId),
  watchId: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  modelSelection: ModelSelection,
  state: GoalWorkerState,
  launchClientRequestId: Schema.String,
  tried: Schema.Array(ModelSelection),
  ...WorkerDetail.fields,
});
export type WorkerRecord = typeof WorkerRecord.Type;

/** The public view of a slot, as goat_goal_get shows it. */
export const publicWorker = (worker: WorkerRecord) => ({
  slot: worker.slot,
  target: worker.target,
  attempt: worker.attempt,
  host: worker.host,
  threadId: worker.threadId,
  branch: worker.branch,
  modelSelection: worker.modelSelection,
  state: worker.state,
  pullRequest: worker.pullRequest,
  lastActivityAt: worker.lastActivityAt,
  launchClientRequestId: worker.launchClientRequestId,
});

export interface GoalRecord {
  readonly goal: FleetGoal;
  readonly workers: ReadonlyArray<WorkerRecord>;
}

export type ClaimRefusal =
  | "generation_moved"
  | "paused"
  | "deleting"
  | "budget"
  | "already_claimed"
  | "gone";

export interface LaunchClaim {
  readonly actionId: string;
  readonly slot: number | null;
  readonly claimedAt: string;
  readonly settledAt: string | null;
  readonly outcome: string | null;
  readonly host: string | null;
  readonly threadId: string | null;
}

/** The outcome of a claimed action that was never sent; its claim may be taken again. */
export const NOT_SENT = "not_sent";

export interface ClaimRequest {
  readonly goalId: FleetGoalId;
  readonly generation: number;
  readonly actionId: string;
  readonly kind: "launch" | "followup" | "fallback" | "interrupt";
  readonly host: string | null;
  readonly slot: number | null;
  readonly nowIso: string;
}

/** Actions that start or continue a run, and so spend the goal's turn budget. */
const TURN_KINDS = ["launch", "followup", "fallback"] as const;

export class GoalStore extends Context.Service<
  GoalStore,
  {
    /** Inserts, or returns the goal an earlier create with the same owner and clientRequestId made. */
    readonly create: (
      goal: FleetGoal,
      ownerKey: string,
      clientRequestId: string | null,
    ) => Effect.Effect<{ readonly goal: FleetGoal; readonly created: boolean }, GoalStoreError>;
    readonly get: (id: FleetGoalId) => Effect.Effect<GoalRecord | null, GoalStoreError>;
    readonly listByOwner: (input: {
      readonly ownerKey: string;
      readonly phase?: FleetGoalPhase | undefined;
      readonly offset: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly goals: ReadonlyArray<FleetGoal>; readonly more: boolean },
      GoalStoreError
    >;
    /** Replaces title, owner and spec, bumping generation, when it still equals `expectedGeneration`. */
    readonly updateSpec: (
      goal: FleetGoal,
      expectedGeneration: number,
    ) => Effect.Effect<FleetGoal | null, GoalStoreError>;
    /**
     * Writes the controller's view for `generation`: refused (false) once the spec moved on,
     * so a status computed for an old spec never overwrites a newer one.
     */
    readonly writeStatus: (input: {
      readonly id: FleetGoalId;
      readonly generation: number;
      readonly status: FleetGoalStatus;
      readonly workers: ReadonlyArray<WorkerRecord>;
      readonly events: ReadonlyArray<FleetGoalEvent>;
      readonly nowIso: string;
    }) => Effect.Effect<boolean, GoalStoreError>;
    readonly requestDeletion: (
      id: FleetGoalId,
      nowIso: string,
    ) => Effect.Effect<boolean, GoalStoreError>;
    readonly remove: (id: FleetGoalId) => Effect.Effect<boolean, GoalStoreError>;
    /** Goals whose spec moved, whose deletion is pending, or whose next pass is due. */
    readonly due: (
      nowIso: string,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<GoalRecord>, GoalStoreError>;
    readonly poke: (id: FleetGoalId, nowIso: string) => Effect.Effect<void, GoalStoreError>;
    readonly events: (
      id: FleetGoalId,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<FleetGoalEvent>, GoalStoreError>;
    /**
     * Claims an action before it runs, in one transaction that re-reads the goal: refused when
     * the generation moved, the goal is paused or being deleted (only interrupts pass then),
     * the turn or wall-clock budget is spent, or the id was already claimed.
     */
    readonly claim: (request: ClaimRequest) => Effect.Effect<ClaimRefusal | null, GoalStoreError>;
    /**
     * Records how an action ended. A launch also records the thread it started; that mapping is
     * written once and never changed, so a later write cannot point the action elsewhere.
     */
    readonly settle: (
      actionId: string,
      outcome: string,
      nowIso: string,
      thread?: { readonly host: string | null; readonly threadId: string },
    ) => Effect.Effect<void, GoalStoreError>;
    /** Every launch the goal claimed, with the thread each one started when that is known. */
    readonly launches: (
      id: FleetGoalId,
    ) => Effect.Effect<ReadonlyArray<LaunchClaim>, GoalStoreError>;
    /** Fallbacks that continued their run in its own thread, by action id. */
    readonly switchedFallbacks: (
      id: FleetGoalId,
    ) => Effect.Effect<ReadonlyArray<string>, GoalStoreError>;
    /** When an action was claimed and whether it settled; null when it never was. */
    readonly claimOf: (actionId: string) => Effect.Effect<
      {
        readonly claimedAt: string;
        readonly settledAt: string | null;
        readonly outcome: string | null;
      } | null,
      GoalStoreError
    >;
    /** Whether a goal launched or adopted this thread, as its slot record or launch record says. */
    readonly ownsThread: (threadId: string) => Effect.Effect<boolean, GoalStoreError>;
    /** When the goal's first action was claimed, or null before any. */
    readonly firstClaimAt: (id: FleetGoalId) => Effect.Effect<string | null, GoalStoreError>;
    /** Turns the goal has spent: claimed launches, follow-ups and model switches. */
    readonly turns: (id: FleetGoalId) => Effect.Effect<number, GoalStoreError>;
  }
>()("goat/fleet/goals/GoalStore") {}

const GoalRow = Schema.Struct({
  id: Schema.String,
  owner_json: Schema.fromJsonString(FleetGoalOwner),
  title: Schema.String,
  spec_json: Schema.fromJsonString(FleetGoalSpec),
  generation: Schema.Number,
  status_json: Schema.fromJsonString(FleetGoalStatus),
  deletion_requested_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
const WorkerRow = Schema.Struct({
  slot: Schema.Number,
  attempt: Schema.Number,
  host: Schema.NullOr(Schema.String),
  thread_id: Schema.NullOr(Schema.String),
  watch_id: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  model_json: Schema.fromJsonString(ModelSelection),
  state: Schema.String,
  launch_client_request_id: Schema.String,
  tried_json: Schema.fromJsonString(Schema.Array(ModelSelection)),
  detail_json: Schema.fromJsonString(WorkerDetail),
});
const EventRow = Schema.Struct({
  at: Schema.String,
  type: Schema.String,
  reason: Schema.String,
  message: Schema.String,
  slot: Schema.NullOr(Schema.Number),
  attempt: Schema.NullOr(Schema.Number),
  action_id: Schema.NullOr(Schema.String),
});

const decodeGoalRow = Schema.decodeUnknownEffect(GoalRow);
const decodeWorkerRow = Schema.decodeUnknownEffect(WorkerRow);
const decodeEventRow = Schema.decodeUnknownEffect(EventRow);
const decodeWorkerState = Schema.decodeUnknownEffect(GoalWorkerState);
const decodeSpecJson = Schema.decodeUnknownEffect(Schema.fromJsonString(FleetGoalSpec));
const decodeEvent = Schema.decodeUnknownEffect(FleetGoalEvent);
const encodeGoal = Schema.encodeEffect(FleetGoal);
const encodeOwnerJson = Schema.encodeEffect(Schema.fromJsonString(FleetGoalOwner));
const encodeSpecJson = Schema.encodeEffect(Schema.fromJsonString(FleetGoalSpec));
const encodeStatusJson = Schema.encodeEffect(Schema.fromJsonString(FleetGoalStatus));
const encodeModelJson = Schema.encodeEffect(Schema.fromJsonString(ModelSelection));
const encodeTriedJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(ModelSelection)));
const encodeDetailJson = Schema.encodeEffect(Schema.fromJsonString(WorkerDetail));

const decodeError = (operation: string) => (cause: Schema.SchemaError) =>
  PersistenceDecodeError.fromSchemaError(operation, cause);

const GOAL_COLUMNS =
  "id, owner_json, title, spec_json, generation, status_json, deletion_requested_at, created_at, updated_at";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sqlError = (operation: string) => (cause: unknown) =>
    new PersistenceSqlError({ operation, cause });
  const run = <A>(operation: string, query: Effect.Effect<A, SqlError.SqlError>) =>
    query.pipe(Effect.mapError(sqlError(operation)));

  const workersOf = (goalId: string) =>
    run(
      "GoalStore.workers",
      sql<Record<string, unknown>>`
        SELECT slot, attempt, host, thread_id, watch_id, branch, model_json, state,
          launch_client_request_id, tried_json, detail_json
        FROM fleet_goal_workers WHERE goal_id = ${goalId} ORDER BY slot
      `,
    ).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (raw) =>
          Effect.gen(function* () {
            const row = yield* decodeWorkerRow(raw);
            const state = yield* decodeWorkerState(row.state);
            return {
              slot: row.slot,
              attempt: row.attempt,
              host: row.host,
              threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
              watchId: row.watch_id,
              branch: row.branch,
              modelSelection: row.model_json,
              state,
              launchClientRequestId: row.launch_client_request_id,
              tried: row.tried_json,
              ...row.detail_json,
            } satisfies WorkerRecord;
          }).pipe(Effect.mapError(decodeError("GoalStore.workers"))),
        ),
      ),
    );

  /** One unreadable goal is logged and skipped, so it cannot hide every other goal. */
  const records = (
    operation: string,
    query: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
  ) =>
    run(operation, query).pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (raw) =>
          Effect.gen(function* () {
            const row = yield* decodeGoalRow(raw).pipe(Effect.mapError(decodeError(operation)));
            const workers = yield* workersOf(row.id);
            const goal: FleetGoal = {
              id: FleetGoalId.make(row.id),
              title: row.title,
              generation: row.generation,
              owner: row.owner_json,
              spec: row.spec_json,
              status: { ...row.status_json, workers: workers.map(publicWorker) },
              deletionRequestedAt: row.deletion_requested_at,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            };
            return [{ goal, workers } satisfies GoalRecord];
          }).pipe(
            Effect.catchTags({
              PersistenceDecodeError: (error) =>
                Effect.logWarning("fleet goal row unreadable", { issue: error.issue }).pipe(
                  Effect.as([] as Array<GoalRecord>),
                ),
            }),
          ),
        ),
      ),
      Effect.map((found) => found.flat()),
    );

  const get = (id: FleetGoalId) =>
    records(
      "GoalStore.get",
      sql`SELECT ${sql.literal(GOAL_COLUMNS)} FROM fleet_goals WHERE id = ${id}`,
    ).pipe(Effect.map((found) => found[0] ?? null));

  const goalColumns = (goal: FleetGoal) =>
    Effect.all({
      owner: encodeOwnerJson(goal.owner),
      spec: encodeSpecJson(goal.spec),
      status: encodeStatusJson({ ...goal.status, workers: [] }),
    }).pipe(Effect.mapError(decodeError("GoalStore.encode")));

  const workerColumns = (worker: WorkerRecord) =>
    Effect.all({
      model: encodeModelJson(worker.modelSelection),
      tried: encodeTriedJson(worker.tried),
      detail: encodeDetailJson({
        target: worker.target,
        pullRequest: worker.pullRequest,
        lastActivityAt: worker.lastActivityAt,
        reported: worker.reported,
        followUps: worker.followUps,
        followedUpRunId: worker.followedUpRunId,
        recoveredRunId: worker.recoveredRunId,
        steeredRunId: worker.steeredRunId,
        resumedRunId: worker.resumedRunId,
        lastRunId: worker.lastRunId,
        note: worker.note,
      }),
    }).pipe(Effect.mapError(decodeError("GoalStore.encodeWorker")));

  const remove = (id: FleetGoalId) =>
    run(
      "GoalStore.remove",
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM fleet_goal_workers WHERE goal_id = ${id}`;
          yield* sql`DELETE FROM fleet_goal_events WHERE goal_id = ${id}`;
          yield* sql`DELETE FROM fleet_goal_actions WHERE goal_id = ${id}`;
          const gone = yield* sql<{ readonly id: string }>`
            DELETE FROM fleet_goals WHERE id = ${id} RETURNING id
          `;
          return gone.length > 0;
        }),
      ),
    );

  return GoalStore.of({
    create: (goal, ownerKey, clientRequestId) =>
      Effect.gen(function* () {
        yield* encodeGoal(goal).pipe(Effect.mapError(decodeError("GoalStore.create")));
        const columns = yield* goalColumns(goal);
        const inserted = yield* run(
          "GoalStore.create",
          sql<{ readonly id: string }>`
            INSERT INTO fleet_goals (
              id, owner_key, client_request_id, owner_json, title, spec_json, generation,
              status_json, observed_generation, phase, paused, next_reconcile_at,
              deletion_requested_at, created_at, updated_at
            ) VALUES (
              ${goal.id}, ${ownerKey}, ${clientRequestId}, ${columns.owner}, ${goal.title},
              ${columns.spec}, ${goal.generation}, ${columns.status},
              ${goal.status.observedGeneration}, ${goal.status.phase},
              ${goal.spec.paused ? 1 : 0}, ${goal.status.nextReconcileAt}, NULL,
              ${goal.createdAt}, ${goal.updatedAt}
            )
            ON CONFLICT DO NOTHING
            RETURNING id
          `,
        );
        if (inserted.length > 0) return { goal, created: true };
        const existing =
          clientRequestId === null
            ? []
            : yield* records(
                "GoalStore.create",
                sql`
                  SELECT ${sql.literal(GOAL_COLUMNS)} FROM fleet_goals
                  WHERE owner_key = ${ownerKey} AND client_request_id = ${clientRequestId}
                `,
              );
        const found = existing[0];
        if (found === undefined)
          return yield* new PersistenceSqlError({
            operation: "GoalStore.create",
            detail: "insert ignored without an existing goal",
          });
        return { goal: found.goal, created: false };
      }),
    get,
    listByOwner: ({ ownerKey, phase, offset, limit }) =>
      records(
        "GoalStore.listByOwner",
        sql`
          SELECT ${sql.literal(GOAL_COLUMNS)} FROM fleet_goals
          WHERE owner_key = ${ownerKey}
            AND ${phase === undefined ? sql.literal("1 = 1") : sql`phase = ${phase}`}
          ORDER BY created_at, id
          LIMIT ${limit + 1} OFFSET ${offset}
        `,
      ).pipe(
        Effect.map((found) => ({
          goals: found.slice(0, limit).map((record) => record.goal),
          more: found.length > limit,
        })),
      ),
    updateSpec: (goal, expectedGeneration) =>
      Effect.gen(function* () {
        const columns = yield* goalColumns(goal);
        const updated = yield* run(
          "GoalStore.updateSpec",
          sql<{ readonly id: string }>`
            UPDATE fleet_goals SET
              owner_json = ${columns.owner},
              title = ${goal.title},
              spec_json = ${columns.spec},
              generation = ${goal.generation},
              paused = ${goal.spec.paused ? 1 : 0},
              next_reconcile_at = NULL,
              updated_at = ${goal.updatedAt}
            WHERE id = ${goal.id} AND generation = ${expectedGeneration}
              AND deletion_requested_at IS NULL
            RETURNING id
          `,
        );
        if (updated.length === 0) return null;
        return (yield* get(goal.id))?.goal ?? null;
      }),
    writeStatus: ({ id, generation, status, workers, events, nowIso }) =>
      Effect.gen(function* () {
        const statusJson = yield* encodeStatusJson({ ...status, workers: [] }).pipe(
          Effect.mapError(decodeError("GoalStore.writeStatus")),
        );
        const encodedWorkers = yield* Effect.forEach(workers, (worker) =>
          workerColumns(worker).pipe(Effect.map((columns) => ({ worker, columns }))),
        );
        return yield* run(
          "GoalStore.writeStatus",
          sql.withTransaction(
            Effect.gen(function* () {
              const updated = yield* sql<{ readonly id: string }>`
                UPDATE fleet_goals SET
                  status_json = ${statusJson},
                  observed_generation = ${status.observedGeneration},
                  phase = ${status.phase},
                  next_reconcile_at = ${status.nextReconcileAt},
                  updated_at = ${nowIso}
                WHERE id = ${id} AND generation = ${generation}
                RETURNING id
              `;
              if (updated.length === 0) return false;
              yield* sql`DELETE FROM fleet_goal_workers WHERE goal_id = ${id}`;
              for (const { worker, columns } of encodedWorkers)
                yield* sql`
                  INSERT INTO fleet_goal_workers (
                    goal_id, slot, attempt, host, thread_id, watch_id, branch, model_json, state,
                    launch_client_request_id, tried_json, detail_json, updated_at
                  ) VALUES (
                    ${id}, ${worker.slot}, ${worker.attempt}, ${worker.host}, ${worker.threadId},
                    ${worker.watchId}, ${worker.branch}, ${columns.model}, ${worker.state},
                    ${worker.launchClientRequestId}, ${columns.tried}, ${columns.detail}, ${nowIso}
                  )
                `;
              if (events.length > 0) {
                const [last] = yield* sql<{ readonly seq: number | null }>`
                  SELECT MAX(seq) AS seq FROM fleet_goal_events WHERE goal_id = ${id}
                `;
                let seq = last?.seq ?? 0;
                for (const event of events) {
                  seq += 1;
                  yield* sql`
                    INSERT INTO fleet_goal_events (
                      goal_id, seq, at, type, reason, message, slot, attempt, action_id
                    ) VALUES (
                      ${id}, ${seq}, ${event.at}, ${event.type}, ${event.reason}, ${event.message},
                      ${event.slot}, ${event.attempt}, ${event.actionId}
                    )
                  `;
                }
                yield* sql`
                  DELETE FROM fleet_goal_events
                  WHERE goal_id = ${id} AND seq <= ${seq - GOAL_EVENT_LIMIT}
                `;
              }
              return true;
            }),
          ),
        );
      }),
    requestDeletion: (id, nowIso) =>
      run(
        "GoalStore.requestDeletion",
        sql<{ readonly id: string }>`
          UPDATE fleet_goals
          SET deletion_requested_at = COALESCE(deletion_requested_at, ${nowIso}),
            next_reconcile_at = NULL, updated_at = ${nowIso}
          WHERE id = ${id}
          RETURNING id
        `,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    remove,
    due: (nowIso, limit) =>
      records(
        "GoalStore.due",
        sql`
          SELECT ${sql.literal(GOAL_COLUMNS)} FROM fleet_goals
          WHERE (
              deletion_requested_at IS NOT NULL
              AND (next_reconcile_at IS NULL OR next_reconcile_at <= ${nowIso})
            )
            OR observed_generation < generation
            OR (
              paused = 0
              AND (
                (phase NOT IN ('succeeded', 'failed') AND next_reconcile_at IS NULL)
                -- A finished goal is scheduled only while it still has cleanup to do.
                OR next_reconcile_at <= ${nowIso}
              )
            )
          ORDER BY COALESCE(next_reconcile_at, ''), id
          LIMIT ${limit}
        `,
      ),
    poke: (id, nowIso) =>
      run(
        "GoalStore.poke",
        sql`UPDATE fleet_goals SET next_reconcile_at = ${nowIso} WHERE id = ${id}`,
      ).pipe(Effect.asVoid),
    events: (id, limit) =>
      run(
        "GoalStore.events",
        sql<Record<string, unknown>>`
          SELECT at, type, reason, message, slot, attempt, action_id FROM fleet_goal_events
          WHERE goal_id = ${id} ORDER BY seq DESC LIMIT ${limit}
        `,
      ).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows.toReversed(), (row) =>
            decodeEventRow(row).pipe(
              Effect.flatMap((event) =>
                decodeEvent({
                  at: event.at,
                  type: event.type,
                  reason: event.reason,
                  message: event.message,
                  slot: event.slot,
                  attempt: event.attempt,
                  actionId: event.action_id,
                }),
              ),
              Effect.mapError(decodeError("GoalStore.events")),
            ),
          ),
        ),
      ),
    claim: (request) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const [row] = yield* sql<{
              readonly generation: number;
              readonly paused: number;
              readonly deletion_requested_at: string | null;
              readonly spec_json: string;
              readonly status_json: string;
            }>`
              SELECT generation, paused, deletion_requested_at, spec_json, status_json
              FROM fleet_goals WHERE id = ${request.goalId}
            `;
            if (row === undefined) return "gone" as const;
            if (row.generation !== request.generation) return "generation_moved" as const;
            if (request.kind !== "interrupt") {
              if (row.deletion_requested_at !== null) return "deleting" as const;
              if (row.paused === 1) return "paused" as const;
              const spec = yield* decodeSpecJson(row.spec_json);
              const [spent] = yield* sql<{ readonly turns: number }>`
                SELECT COUNT(*) AS turns FROM fleet_goal_actions
                WHERE goal_id = ${request.goalId}
                  AND kind IN ${sql.in([...TURN_KINDS])}
              `;
              if (spec.limits.maxTurns !== null && (spent?.turns ?? 0) >= spec.limits.maxTurns)
                return "budget" as const;
              const [first] = yield* sql<{ readonly started: string | null }>`
                SELECT MIN(claimed_at) AS started FROM fleet_goal_actions
                WHERE goal_id = ${request.goalId}
              `;
              const started = first?.started ?? null;
              if (
                spec.limits.maxWallClockMs !== null &&
                started !== null &&
                Date.parse(request.nowIso) - Date.parse(started) > spec.limits.maxWallClockMs
              )
                return "budget" as const;
            }
            const inserted = yield* sql<{ readonly action_id: string }>`
              INSERT INTO fleet_goal_actions (
                action_id, goal_id, generation, kind, host, reserved_slot, claimed_at
              ) VALUES (
                ${request.actionId}, ${request.goalId}, ${request.generation}, ${request.kind},
                ${request.host}, ${request.slot}, ${request.nowIso}
              )
              ON CONFLICT (action_id) DO UPDATE SET
                generation = excluded.generation,
                host = excluded.host,
                claimed_at = excluded.claimed_at,
                settled_at = NULL,
                outcome = NULL
              WHERE fleet_goal_actions.outcome = ${NOT_SENT}
              RETURNING action_id
            `;
            return inserted.length === 0 ? ("already_claimed" as const) : null;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            Schema.isSchemaError(error)
              ? decodeError("GoalStore.claim")(error)
              : sqlError("GoalStore.claim")(error),
          ),
        ),
    settle: (actionId, outcome, nowIso, thread) =>
      run(
        "GoalStore.settle",
        sql`
          UPDATE fleet_goal_actions SET
            settled_at = ${nowIso},
            outcome = ${outcome},
            -- Write-once: the first known thread stays the action's thread.
            thread_host = CASE WHEN thread_id IS NULL THEN ${thread?.host ?? null} ELSE thread_host END,
            thread_id = COALESCE(thread_id, ${thread?.threadId ?? null})
          WHERE action_id = ${actionId}
        `,
      ).pipe(Effect.asVoid),
    launches: (id) =>
      run(
        "GoalStore.launches",
        sql<{
          readonly action_id: string;
          readonly reserved_slot: number | null;
          readonly claimed_at: string;
          readonly settled_at: string | null;
          readonly outcome: string | null;
          readonly thread_host: string | null;
          readonly thread_id: string | null;
        }>`
          SELECT action_id, reserved_slot, claimed_at, settled_at, outcome,
            -- Until a thread is recorded, the claim's own host is where the launch went.
            CASE WHEN thread_id IS NULL THEN host ELSE thread_host END AS thread_host, thread_id
          FROM fleet_goal_actions WHERE goal_id = ${id} AND kind = 'launch'
          ORDER BY claimed_at, action_id
        `,
      ).pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            actionId: row.action_id,
            slot: row.reserved_slot,
            claimedAt: row.claimed_at,
            settledAt: row.settled_at,
            outcome: row.outcome,
            host: row.thread_host,
            threadId: row.thread_id,
          })),
        ),
      ),
    claimOf: (actionId) =>
      run(
        "GoalStore.claimOf",
        sql<{
          readonly claimed_at: string;
          readonly settled_at: string | null;
          readonly outcome: string | null;
        }>`
          SELECT claimed_at, settled_at, outcome FROM fleet_goal_actions WHERE action_id = ${actionId}
        `,
      ).pipe(
        Effect.map(([row]) =>
          row === undefined
            ? null
            : { claimedAt: row.claimed_at, settledAt: row.settled_at, outcome: row.outcome },
        ),
      ),
    switchedFallbacks: (id) =>
      run(
        "GoalStore.switchedFallbacks",
        sql<{ readonly action_id: string }>`
          SELECT action_id FROM fleet_goal_actions
          WHERE goal_id = ${id} AND kind = 'fallback' AND outcome = 'switched'
        `,
      ).pipe(Effect.map((rows) => rows.map((row) => row.action_id))),
    ownsThread: (threadId) =>
      run(
        "GoalStore.ownsThread",
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM fleet_goal_workers WHERE thread_id = ${threadId}
          UNION ALL
          SELECT 1 AS found FROM fleet_goal_actions WHERE thread_id = ${threadId}
          LIMIT 1
        `,
      ).pipe(Effect.map((rows) => rows.length > 0)),
    firstClaimAt: (id) =>
      run(
        "GoalStore.firstClaimAt",
        sql<{ readonly started: string | null }>`
          SELECT MIN(claimed_at) AS started FROM fleet_goal_actions WHERE goal_id = ${id}
        `,
      ).pipe(Effect.map(([row]) => row?.started ?? null)),
    turns: (id) =>
      run(
        "GoalStore.turns",
        sql<{ readonly turns: number }>`
          SELECT COUNT(*) AS turns FROM fleet_goal_actions
          WHERE goal_id = ${id} AND kind IN ${sql.in([...TURN_KINDS])}
        `,
      ).pipe(Effect.map(([row]) => row?.turns ?? 0)),
  });
});

export const layer = Layer.effect(GoalStore, make);
