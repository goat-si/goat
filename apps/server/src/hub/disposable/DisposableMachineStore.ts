import {
  DISPOSABLE_FINAL_STATES,
  type DisposableMachineState,
  HubNodeMachineClass,
  ServerSettingsError,
  type ServerSettings,
  ThreadId,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError, type SqlError } from "effect/sql/SqlError";

import * as Settings from "../../serverSettings.ts";
import type { DisposableRecord } from "./disposableClass.ts";
import { disposableSwitch } from "./disposableSwitch.ts";

/** Who vouched for a machine, as stored: the person's session never leaves the hub. */
const StoredProvisioner = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("thread"),
    threadId: ThreadId,
    cloudRunId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("person"), sessionId: Schema.String }),
]);

// The fields the hub nodes snapshot sends decode with its own schemas, so a row it could not carry
// fails this read (every machine kept) instead of the whole snapshot.
const wire = HubNodeMachineClass.fields;
const Row = Schema.Struct({
  attach_id: wire.attachId,
  node_id: Schema.String,
  state: wire.state,
  state_since: wire.stateSince,
  created_at: Schema.String,
  provisioner_json: Schema.fromJsonString(StoredProvisioner),
  final_at: Schema.NullOr(Schema.String),
  environment_id: Schema.NullOr(Schema.String),
  machine_install_id: Schema.NullOr(Schema.String),
  sshd_pin: Schema.NullOr(Schema.String),
  link_id: Schema.NullOr(Schema.String),
  conflicts_json: Schema.fromJsonString(wire.conflicts),
  pen_admitted_at: Schema.NullOr(Schema.String),
  pen_removed_at: Schema.NullOr(Schema.String),
});
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(Row));

export class DisposableStoreError extends Data.TaggedError("DisposableStoreError")<{
  readonly message: string;
}> {}

const OPEN_LIMIT = 1000;
// The settings write lock is held for the whole commit; nothing may keep every settings writer waiting.
const COMMIT_BOUND = "15 seconds";
const unreadable = () =>
  new DisposableStoreError({ message: "The hub's disposable machine records are unreadable." });
const isServerSettingsError = Schema.is(ServerSettingsError);
const isStorageFailure = (error: unknown): error is SqlError | ServerSettingsError =>
  isSqlError(error) || isServerSettingsError(error);
/** A failure of the caller's write, kept apart from the store's own storage failures. */
class WriteFailed<E> extends Data.TaggedError("WriteFailed")<{ readonly error: E }> {}
/** The switch expired while the write ran; failing the transaction rolls the write back. */
class ExpiredDuringWrite extends Data.TaggedError("ExpiredDuringWrite")<{}> {}

/** Why a forward commit did not run. */
export type ForwardRefusal =
  | "switch_off"
  | "switch_expired"
  | "grant_changed"
  | "fence_moved"
  | "not_found";
export type Forward<A> =
  | { readonly committed: true; readonly value: A }
  | { readonly committed: false; readonly reason: ForwardRefusal };

export class DisposableMachineStore extends Context.Service<
  DisposableMachineStore,
  {
    /** Every open record; fails when the table cannot be read or holds more than it can show. */
    readonly records: Effect.Effect<ReadonlyArray<DisposableRecord>, DisposableStoreError>;
    /**
     * Every open record, for the class of hub nodes. An unreadable table reads as no
     * records, so every machine is kept and nothing acts on one automatically.
     */
    readonly recordsOrKept: Effect.Effect<ReadonlyArray<DisposableRecord>>;
    /**
     * Runs `write` in one transaction under the settings write lock, only while the switch holds the
     * record's grant and the fence is the one read; it advances the fence. `write` gets the snapshot
     * and must not call ServerSettingsService (its lookups wait for the held lock). Bounded by
     * COMMIT_BOUND; the write's own errors pass through.
     */
    readonly commitForward: <A, E, R>(
      target: { readonly attachId: string; readonly fence: number },
      write: (settings: ServerSettings) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<Forward<A>, E | DisposableStoreError, R>;
  }
>()("goat/hub/disposable/DisposableMachineStore") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const settings = yield* Settings.ServerSettingsService;

  const records = Effect.gen(function* () {
    const rows = yield* sql`SELECT attach_id, node_id, state, state_since, created_at,
        provisioner_json, final_at, environment_id, machine_install_id, sshd_pin, link_id,
        conflicts_json, pen_admitted_at, pen_removed_at
      FROM disposable_machines
      WHERE final_at IS NULL
      ORDER BY created_at, attach_id LIMIT ${OPEN_LIMIT + 1}`;
    // A collision past the limit would go unseen, so too many records read as unreadable.
    if (rows.length > OPEN_LIMIT) return yield* unreadable();
    return (yield* decodeRows(rows)).map((row): DisposableRecord => ({
      attachId: row.attach_id,
      nodeId: row.node_id,
      state: row.state,
      stateSince: row.state_since,
      createdAt: row.created_at,
      provisioner:
        row.provisioner_json.kind === "thread"
          ? { kind: "thread", threadId: row.provisioner_json.threadId }
          : { kind: "person" },
      final:
        row.final_at !== null || DISPOSABLE_FINAL_STATES.has(row.state as DisposableMachineState),
      environmentId: row.environment_id,
      machineInstallId: row.machine_install_id,
      sshdPin: row.sshd_pin,
      linkId: row.link_id,
      conflicts: row.conflicts_json,
      penMember: row.pen_admitted_at !== null && row.pen_removed_at === null,
    }));
  }).pipe(Effect.mapError(unreadable), Effect.withSpan("DisposableMachineStore.records"));

  const commitForward = <A, E, R>(
    target: { readonly attachId: string; readonly fence: number },
    write: (settings: ServerSettings) => Effect.Effect<A, E, R>,
  ): Effect.Effect<Forward<A>, E | DisposableStoreError, R> =>
    settings
      .withSettingsSnapshot((current) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              // Read the clock once the transaction is held: waiting for it can outlast the expiry.
              const gate = disposableSwitch(current.hub, yield* Clock.currentTimeMillis);
              const [row] = yield* sql<{ readonly grant_id: string; readonly fence: number }>`
                SELECT grant_id, fence FROM disposable_machines WHERE attach_id = ${target.attachId}`;
              const refused = (reason: ForwardRefusal): Forward<A> => ({
                committed: false,
                reason,
              });
              if (row === undefined) return refused("not_found");
              if (!gate.open) return refused(gate.reason);
              if (gate.grant !== row.grant_id) return refused("grant_changed");
              if (row.fence !== target.fence) return refused("fence_moved");
              const advanced = yield* sql`UPDATE disposable_machines SET fence = fence + 1
                WHERE attach_id = ${target.attachId} AND fence = ${target.fence} RETURNING fence`;
              if (advanced.length !== 1) return refused("fence_moved");
              const value = yield* write(current).pipe(
                Effect.mapError((error) => new WriteFailed({ error })),
              );
              // Settings cannot change while the lock is held, but the clock can pass the expiry.
              if (!disposableSwitch(current.hub, yield* Clock.currentTimeMillis).open)
                return yield* new ExpiredDuringWrite();
              return { committed: true, value } as const;
            }),
          )
          .pipe(
            Effect.catchTags({
              ExpiredDuringWrite: () =>
                Effect.succeed<Forward<A>>({ committed: false, reason: "switch_expired" }),
            }),
            Effect.timeoutOrElse({
              duration: COMMIT_BOUND,
              orElse: () => Effect.fail(unreadable()),
            }),
          ),
      )
      .pipe(
        Effect.catchIf(isStorageFailure, () => Effect.fail(unreadable())),
        Effect.catchTags({ WriteFailed: (failed) => Effect.fail(failed.error as E) }),
        Effect.withSpan("DisposableMachineStore.commitForward"),
      );

  // Logged once each time the table turns unreadable, not on every hub node snapshot.
  const warned = yield* Ref.make(false);
  return DisposableMachineStore.of({
    records,
    recordsOrKept: records.pipe(
      Effect.tap(() => Ref.set(warned, false)),
      Effect.catch((error) =>
        Ref.getAndSet(warned, true).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.void
              : Effect.logWarning(
                  "Disposable machine records unreadable; every machine reads kept.",
                ).pipe(Effect.annotateLogs({ reason: error.message })),
          ),
          Effect.as([]),
        ),
      ),
    ),
    commitForward,
  });
});

export const layer = Layer.effect(DisposableMachineStore, make);
