import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Cordon and drain per host, in fleet_host_states. Draining implies cordoned. This machine is
 * stored as "local". Read on demand: the table holds one row per host anyone cordoned.
 */
export const LOCAL_HOST = "local";

export interface FleetHostState {
  readonly host: string;
  readonly cordoned: boolean;
  readonly draining: boolean;
  readonly reason: string | null;
  readonly changedBy: string | null;
  readonly changedAt: string;
}

export interface FleetHostStatesShape {
  readonly get: (host: string) => Effect.Effect<FleetHostState | null>;
  readonly cordon: (input: {
    readonly host: string;
    readonly draining: boolean;
    readonly reason: string | null;
    readonly changedBy: string | null;
  }) => Effect.Effect<FleetHostState>;
  readonly uncordon: (host: string) => Effect.Effect<void>;
  /** Cordoned and draining hosts, with null for this machine, as placement reads them. */
  readonly cordonedHosts: Effect.Effect<ReadonlySet<string | null>>;
}

export class FleetHostStates extends Context.Service<FleetHostStates, FleetHostStatesShape>()(
  "goat/fleet/health/FleetHostStates",
) {}

interface Row {
  readonly host: string;
  readonly cordoned: number;
  readonly draining: number;
  readonly reason: string | null;
  readonly changed_by: string | null;
  readonly changed_at: string;
}

const fromRow = (row: Row): FleetHostState => ({
  host: row.host,
  cordoned: row.cordoned === 1,
  draining: row.draining === 1,
  reason: row.reason,
  changedBy: row.changed_by,
  changedAt: row.changed_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A store that cannot be read must not look like "nothing cordoned" to placement.
  const get: FleetHostStatesShape["get"] = (host) =>
    sql<Row>`SELECT * FROM fleet_host_states WHERE host = ${host}`.pipe(
      Effect.orDie,
      Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))),
    );

  return FleetHostStates.of({
    get,
    cordon: (input) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        // A drain stays a drain when someone cordons again; uncordon clears both.
        const rows = yield* sql<Row>`
          INSERT INTO fleet_host_states (host, cordoned, draining, reason, changed_by, changed_at)
          VALUES (${input.host}, 1, ${input.draining ? 1 : 0}, ${input.reason}, ${input.changedBy}, ${at})
          ON CONFLICT(host) DO UPDATE SET
            cordoned = 1,
            draining = MAX(fleet_host_states.draining, excluded.draining),
            reason = COALESCE(excluded.reason, fleet_host_states.reason),
            changed_by = excluded.changed_by,
            changed_at = excluded.changed_at
          RETURNING *
        `.pipe(Effect.orDie);
        return fromRow(rows[0]!);
      }),
    cordonedHosts: sql<{
      readonly host: string;
    }>`SELECT host FROM fleet_host_states WHERE cordoned = 1 OR draining = 1`.pipe(
      Effect.orDie,
      Effect.map((rows) => new Set(rows.map((row) => (row.host === LOCAL_HOST ? null : row.host)))),
    ),
    uncordon: (host) =>
      sql`DELETE FROM fleet_host_states WHERE host = ${host}`.pipe(Effect.orDie, Effect.asVoid),
  });
});

export const layer = Layer.effect(FleetHostStates, make);

/**
 * A launch this machine started for one reschedule request, written before the remote launch so a
 * lost answer or a restart never starts the same attempt twice. threadId is set once the launch is
 * known; until then the attempt may only be retried on target, after its absence is confirmed.
 */
export interface RescheduleClaim {
  readonly clientRequestId: string;
  readonly ownerKey: string;
  readonly targetHost: string;
  readonly title: string;
  readonly branch: string;
  readonly threadId: string | null;
  readonly claimedAt: string;
}

export interface FleetRescheduleClaimsShape {
  readonly get: (clientRequestId: string) => Effect.Effect<RescheduleClaim | null>;
  /** Records the launch target; a retry on the same target keeps the claim. */
  readonly claim: (claim: Omit<RescheduleClaim, "threadId" | "claimedAt">) => Effect.Effect<void>;
  readonly settle: (clientRequestId: string, threadId: string) => Effect.Effect<void>;
  /** The launch provably never started; the request may place again anywhere. */
  readonly release: (clientRequestId: string) => Effect.Effect<void>;
}

export class FleetRescheduleClaims extends Context.Service<
  FleetRescheduleClaims,
  FleetRescheduleClaimsShape
>()("goat/fleet/health/FleetHostStates/FleetRescheduleClaims") {}

interface ClaimRow {
  readonly client_request_id: string;
  readonly owner_key: string;
  readonly target_host: string;
  readonly title: string;
  readonly branch: string;
  readonly thread_id: string | null;
  readonly claimed_at: string;
}

const makeClaims = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return FleetRescheduleClaims.of({
    get: (id) =>
      sql<ClaimRow>`SELECT * FROM fleet_reschedule_claims WHERE client_request_id = ${id}`.pipe(
        Effect.orDie,
        Effect.map((rows) => {
          const row = rows[0];
          return row === undefined
            ? null
            : {
                clientRequestId: row.client_request_id,
                ownerKey: row.owner_key,
                targetHost: row.target_host,
                title: row.title,
                branch: row.branch,
                threadId: row.thread_id,
                claimedAt: row.claimed_at,
              };
        }),
      ),
    claim: (input) =>
      Effect.gen(function* () {
        const at = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO fleet_reschedule_claims (client_request_id, owner_key, target_host, title, branch, thread_id, claimed_at)
          VALUES (${input.clientRequestId}, ${input.ownerKey}, ${input.targetHost}, ${input.title}, ${input.branch}, NULL, ${at})
          ON CONFLICT(client_request_id) DO UPDATE SET target_host = excluded.target_host, claimed_at = excluded.claimed_at
          WHERE fleet_reschedule_claims.thread_id IS NULL
        `.pipe(Effect.orDie);
      }),
    settle: (id, threadId) =>
      sql`UPDATE fleet_reschedule_claims SET thread_id = ${threadId} WHERE client_request_id = ${id}`.pipe(
        Effect.orDie,
        Effect.asVoid,
      ),
    release: (id) =>
      sql`DELETE FROM fleet_reschedule_claims WHERE client_request_id = ${id} AND thread_id IS NULL`.pipe(
        Effect.orDie,
        Effect.asVoid,
      ),
  });
});

export const layerClaims = Layer.effect(FleetRescheduleClaims, makeClaims);
