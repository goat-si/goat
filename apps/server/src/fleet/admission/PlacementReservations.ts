import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

/** The target's record of placed launches (design §11): one row per key, conditional writes only. */

export const LEASE_MS = 5 * 60 * 1000;
export const PENDING_CAP_MS = 60 * 60 * 1000;
export const FUTURE_MS = 10 * 60 * 1000;
export const ADMIT_WINDOW_MS = 25 * 24 * 60 * 60 * 1000;
export const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
export const PLACER_BOUND = 4096;
export const DEFAULT_PENDING_LIMIT = 256;

export class PlacementStoreError extends Schema.TaggedError<PlacementStoreError>()(
  "PlacementStoreError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export interface PlacementKey {
  /** "pen:<nodeId>" or "local"; taken from the session, never from the payload. */
  readonly placer: string;
  readonly ownerKey: string;
  readonly attempt: number;
  /** Milliseconds since the epoch, as the placer stamped the attempt. */
  readonly issuedAt: number;
}

export type ReservationState = "pending" | "counted" | "fenced";

export interface Reservation {
  readonly key: PlacementKey;
  readonly commandId: string;
  readonly digest: string;
  readonly state: ReservationState;
  readonly ownerEpoch: string;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly admittedAt: number;
  readonly leaseUntil: number;
  readonly reason: string | null;
}

export type AdmitRefusal = "expired" | "future" | "placer_bound" | "cordoned" | "full";

export type AdmitDecision =
  | { readonly _tag: "Admitted"; readonly reservation: Reservation }
  | { readonly _tag: "Known"; readonly reservation: Reservation }
  | { readonly _tag: "Conflicting"; readonly reservation: Reservation }
  | { readonly _tag: "Refused"; readonly refusal: AdmitRefusal };

export interface AdmitInput {
  readonly key: PlacementKey;
  readonly commandId: string;
  readonly digest: string;
  readonly epoch: string;
  readonly now: number;
  /** This machine's own limit; null when it sets none. */
  readonly maxThreads: number | null;
  /** Running and queued work in the live projection, read inside the admission transaction. */
  readonly live: Effect.Effect<number, PlacementStoreError>;
  readonly cordoned: Effect.Effect<boolean, PlacementStoreError>;
}

interface Owned {
  readonly commandId: string;
  readonly epoch: string;
}

export interface PlacementReservationsShape {
  /** One write transaction: the key's row first, then the watermark, the clock, the bound, the cordon and capacity. */
  readonly admit: (input: AdmitInput) => Effect.Effect<AdmitDecision, PlacementStoreError>;
  /** The key's row and the watermark, read together. */
  readonly lookup: (
    key: PlacementKey,
  ) => Effect.Effect<
    { readonly row: Reservation | null; readonly watermark: number },
    PlacementStoreError
  >;
  readonly get: (commandId: string) => Effect.Effect<Reservation | null, PlacementStoreError>;
  /** Runs inside the transaction that commits thread.create. */
  readonly bindThread: (
    input: Owned & { readonly threadId: string },
  ) => Effect.Effect<boolean, PlacementStoreError>;
  /** Runs inside the transaction that commits the initial message and its preparing run. */
  readonly markCounted: (
    input: Owned & { readonly threadId: string; readonly runId: string },
  ) => Effect.Effect<boolean, PlacementStoreError>;
  readonly renew: (
    input: Owned & { readonly now: number },
  ) => Effect.Effect<boolean, PlacementStoreError>;
  readonly finalize: (
    input: Owned & { readonly reason: string },
  ) => Effect.Effect<boolean, PlacementStoreError>;
  /** Fences lapsed leases, then anything pending past the 60-minute cap. */
  readonly sweep: (now: number) => Effect.Effect<number, PlacementStoreError>;
  /** Before admission opens: every pending row another process owned. */
  readonly fenceStale: (epoch: string) => Effect.Effect<number, PlacementStoreError>;
  readonly prune: (
    now: number,
  ) => Effect.Effect<{ readonly deleted: number; readonly watermark: number }, PlacementStoreError>;
}

export class PlacementReservations extends Context.Service<
  PlacementReservations,
  PlacementReservationsShape
>()("goat/fleet/admission/PlacementReservations") {}

interface Row {
  readonly placer: string;
  readonly owner_key: string;
  readonly attempt: number;
  readonly issued_at: number;
  readonly command_id: string;
  readonly digest: string;
  readonly state: ReservationState;
  readonly owner_epoch: string;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly admitted_at: number;
  readonly lease_until: number;
  readonly reason: string | null;
}

const fromRow = (row: Row): Reservation => ({
  key: {
    placer: row.placer,
    ownerKey: row.owner_key,
    attempt: row.attempt,
    issuedAt: row.issued_at,
  },
  commandId: row.command_id,
  digest: row.digest,
  state: row.state,
  ownerEpoch: row.owner_epoch,
  threadId: row.thread_id,
  runId: row.run_id,
  admittedAt: row.admitted_at,
  leaseUntil: row.lease_until,
  reason: row.reason,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const isStoreError = Schema.is(PlacementStoreError);
  const failed =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isStoreError(cause) ? cause : new PlacementStoreError({ operation, cause }),
        ),
      );

  const watermark = (operation: string) =>
    sql<{
      readonly issued_at: number;
    }>`SELECT issued_at FROM placement_watermark WHERE id = 1`.pipe(
      Effect.flatMap((rows) =>
        rows[0] === undefined
          ? // Never re-created here: a lost watermark could make a pruned key look new.
            Effect.fail(
              new PlacementStoreError({ operation, cause: "The prune watermark is missing." }),
            )
          : Effect.succeed(rows[0].issued_at),
      ),
    );

  const rowByKey = (key: PlacementKey) =>
    sql<Row>`
      SELECT * FROM placement_reservations
      WHERE placer = ${key.placer} AND owner_key = ${key.ownerKey}
        AND attempt = ${key.attempt} AND issued_at = ${key.issuedAt}
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))));

  const updated = (rows: ReadonlyArray<unknown>) => rows.length > 0;

  const admit = Effect.fn("PlacementReservations.admit")(function* (input: AdmitInput) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* rowByKey(input.key);
          if (existing !== null)
            return existing.digest === input.digest
              ? ({ _tag: "Known", reservation: existing } as const)
              : ({ _tag: "Conflicting", reservation: existing } as const);
          const floor = yield* watermark("admit");
          const refuse = (refusal: AdmitRefusal) => ({ _tag: "Refused", refusal }) as const;
          if (input.key.issuedAt <= floor) return refuse("expired");
          if (input.key.issuedAt > input.now + FUTURE_MS) return refuse("future");
          if (input.key.issuedAt < input.now - ADMIT_WINDOW_MS) return refuse("expired");
          const [retained] = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM placement_reservations WHERE placer = ${input.key.placer}
          `;
          if ((retained?.count ?? 0) >= PLACER_BOUND) return refuse("placer_bound");
          if (yield* input.cordoned) return refuse("cordoned");
          const [pending] = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM placement_reservations WHERE state = 'pending'
          `;
          const held = pending?.count ?? 0;
          const full =
            input.maxThreads === null
              ? held >= DEFAULT_PENDING_LIMIT
              : held + (yield* input.live) >= input.maxThreads;
          if (full) return refuse("full");
          const [inserted] = yield* sql<Row>`
            INSERT INTO placement_reservations
              (placer, owner_key, attempt, issued_at, command_id, digest, state, owner_epoch,
               admitted_at, lease_until)
            VALUES (${input.key.placer}, ${input.key.ownerKey}, ${input.key.attempt}, ${input.key.issuedAt},
              ${input.commandId}, ${input.digest}, 'pending', ${input.epoch}, ${input.now},
              ${input.now + LEASE_MS})
            RETURNING *
          `;
          if (inserted === undefined)
            return yield* new PlacementStoreError({
              operation: "admit",
              cause: "Insert returned no row.",
            });
          return { _tag: "Admitted", reservation: fromRow(inserted) } as const;
        }),
      )
      .pipe(failed("admit"));
  });

  const conditional = (
    operation: string,
    statement: Effect.Effect<ReadonlyArray<unknown>, SqlError.SqlError>,
  ) => statement.pipe(Effect.map(updated), failed(operation));

  const lookup = Effect.fn("PlacementReservations.lookup")(function* (key: PlacementKey) {
    return yield* sql
      .withTransaction(Effect.all({ row: rowByKey(key), watermark: watermark("lookup") }))
      .pipe(failed("lookup"));
  });
  const get = Effect.fn("PlacementReservations.get")(function* (commandId: string) {
    const rows =
      yield* sql<Row>`SELECT * FROM placement_reservations WHERE command_id = ${commandId}`.pipe(
        failed("get"),
      );
    return rows[0] === undefined ? null : fromRow(rows[0]);
  });
  const bindThread = Effect.fn("PlacementReservations.bindThread")(function* (
    input: Owned & { readonly threadId: string },
  ) {
    return yield* conditional(
      "bindThread",
      sql`
        UPDATE placement_reservations SET thread_id = ${input.threadId}
        WHERE command_id = ${input.commandId} AND state = 'pending' AND owner_epoch = ${input.epoch}
        RETURNING command_id
      `,
    );
  });
  const markCounted = Effect.fn("PlacementReservations.markCounted")(function* (
    input: Owned & { readonly threadId: string; readonly runId: string },
  ) {
    return yield* conditional(
      "markCounted",
      sql`
        UPDATE placement_reservations
        SET state = 'counted', thread_id = ${input.threadId}, run_id = ${input.runId}
        WHERE command_id = ${input.commandId} AND state = 'pending' AND owner_epoch = ${input.epoch}
        RETURNING command_id
      `,
    );
  });
  const renew = Effect.fn("PlacementReservations.renew")(function* (
    input: Owned & { readonly now: number },
  ) {
    return yield* conditional(
      "renew",
      sql`
        UPDATE placement_reservations SET lease_until = ${input.now + LEASE_MS}
        WHERE command_id = ${input.commandId} AND state = 'pending' AND owner_epoch = ${input.epoch}
        RETURNING command_id
      `,
    );
  });
  const finalize = Effect.fn("PlacementReservations.finalize")(function* (
    input: Owned & { readonly reason: string },
  ) {
    return yield* conditional(
      "finalize",
      sql`
        UPDATE placement_reservations SET state = 'fenced', reason = ${input.reason}
        WHERE command_id = ${input.commandId} AND state = 'pending' AND owner_epoch = ${input.epoch}
        RETURNING command_id
      `,
    );
  });
  const sweep = Effect.fn("PlacementReservations.sweep")(function* (now: number) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const lapsed = yield* sql`
            UPDATE placement_reservations SET state = 'fenced', reason = 'lease lapsed'
            WHERE state = 'pending' AND lease_until < ${now}
            RETURNING command_id
          `;
          const capped = yield* sql`
            UPDATE placement_reservations
            SET state = 'fenced', reason = 'launch took longer than 60 minutes'
            WHERE state = 'pending' AND admitted_at < ${now - PENDING_CAP_MS}
            RETURNING command_id
          `;
          return lapsed.length + capped.length;
        }),
      )
      .pipe(failed("sweep"));
  });
  const fenceStale = Effect.fn("PlacementReservations.fenceStale")(function* (epoch: string) {
    const rows = yield* sql`
      UPDATE placement_reservations SET state = 'fenced', reason = 'restarted'
      WHERE state = 'pending' AND owner_epoch <> ${epoch}
      RETURNING command_id
    `.pipe(failed("fenceStale"));
    return rows.length;
  });
  const prune = Effect.fn("PlacementReservations.prune")(function* (now: number) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* watermark("prune");
          const deleted = yield* sql<{ readonly issued_at: number }>`
            DELETE FROM placement_reservations
            WHERE state IN ('counted', 'fenced') AND issued_at < ${now - RETAIN_MS}
            RETURNING issued_at
          `;
          const next = deleted.reduce((max, row) => Math.max(max, row.issued_at), current);
          if (next !== current)
            yield* sql`UPDATE placement_watermark SET issued_at = ${next} WHERE id = 1`;
          return { deleted: deleted.length, watermark: next };
        }),
      )
      .pipe(failed("prune"));
  });

  return PlacementReservations.of({
    admit,
    lookup,
    get,
    bindThread,
    markCounted,
    renew,
    finalize,
    sweep,
    fenceStale,
    prune,
  });
});

export const layer = Layer.effect(PlacementReservations, make);
