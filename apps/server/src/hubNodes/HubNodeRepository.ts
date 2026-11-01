import {
  EnvironmentId,
  HubNodeAddedBy,
  HubNodeRouteTarget,
  HubNodeStatus,
  HubNodesError,
  HubNodesImportResult,
  IsoDateTime,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const Registration = Schema.Struct({
  routeId: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  label: Schema.NullOr(Schema.String),
  target: HubNodeRouteTarget,
  addedBy: HubNodeAddedBy,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Registration = typeof Registration.Type;
export const RouteState = Schema.Struct({
  routeId: Schema.String,
  environmentId: Schema.NullOr(EnvironmentId),
  status: HubNodeStatus,
  checkedAt: Schema.NullOr(IsoDateTime),
  lastSeenAt: Schema.NullOr(IsoDateTime),
  lastError: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
});
export type RouteState = typeof RouteState.Type;
const ImportRecord = Schema.Struct({
  source: Schema.Literal("desktop-catalog"),
  outcome: HubNodesImportResult.fields.outcome,
  imported: HubNodesImportResult.fields.imported,
  at: IsoDateTime,
  noticeDismissedAt: Schema.NullOr(IsoDateTime),
});
type ImportRecord = typeof ImportRecord.Type;

export class HubNodeRepository extends Context.Service<
  HubNodeRepository,
  {
    readonly listRegistrations: Effect.Effect<ReadonlyArray<Registration>, HubNodesError>;
    readonly upsertRegistration: (row: Registration) => Effect.Effect<void, HubNodesError>;
    readonly deleteRegistration: (routeId: string) => Effect.Effect<void, HubNodesError>;
    readonly listRouteState: Effect.Effect<ReadonlyArray<RouteState>, HubNodesError>;
    readonly upsertRouteState: (row: RouteState) => Effect.Effect<void, HubNodesError>;
    readonly deleteRouteState: (routeId: string) => Effect.Effect<void, HubNodesError>;
    readonly getImport: Effect.Effect<ImportRecord | undefined, HubNodesError>;
    readonly putImport: (row: ImportRecord) => Effect.Effect<void, HubNodesError>;
    readonly dismissImportNotice: (at: string) => Effect.Effect<boolean, HubNodesError>;
    readonly transaction: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | HubNodesError, R>;
  }
>()("goat/hubNodes/HubNodeRepository") {}

const encodeTarget = Schema.encodeEffect(Schema.fromJsonString(HubNodeRouteTarget));
const encodeAddedBy = Schema.encodeEffect(Schema.fromJsonString(HubNodeAddedBy));

const storageError = () =>
  new HubNodesError({
    reason: "storage_failed",
    detail: "This hub could not read or save its nodes.",
  });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const storedRegistration = Schema.Struct({
    ...Registration.fields,
    target: Schema.fromJsonString(HubNodeRouteTarget),
    addedBy: Schema.fromJsonString(HubNodeAddedBy),
  });
  const listRegistrations =
    sql`SELECT route_id AS "routeId", environment_id AS "environmentId", label,
    target_json AS target, added_by_json AS "addedBy", created_at AS "createdAt", updated_at AS "updatedAt"
    FROM hub_node_registrations ORDER BY created_at, route_id`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(storedRegistration))),
      Effect.mapError(storageError),
    );
  const listRouteState =
    sql`SELECT route_id AS "routeId", environment_id AS "environmentId", status,
    checked_at AS "checkedAt", last_seen_at AS "lastSeenAt", last_error AS "lastError" FROM hub_node_route_state`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RouteState))),
      Effect.mapError(storageError),
    );
  const getImport =
    sql`SELECT source, outcome, imported, at, notice_dismissed_at AS "noticeDismissedAt"
    FROM hub_node_imports WHERE source = 'desktop-catalog'`.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ImportRecord))),
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageError),
    );
  return HubNodeRepository.of({
    listRegistrations,
    listRouteState,
    getImport,
    upsertRegistration: (row) =>
      Effect.gen(function* () {
        const target = yield* encodeTarget(row.target);
        const addedBy = yield* encodeAddedBy(row.addedBy);
        yield* sql`INSERT INTO hub_node_registrations (route_id, environment_id, label, target_json, added_by_json, created_at, updated_at)
        VALUES (${row.routeId}, ${row.environmentId}, ${row.label}, ${target}, ${addedBy}, ${row.createdAt}, ${row.updatedAt})
        ON CONFLICT(route_id) DO UPDATE SET environment_id = excluded.environment_id, label = excluded.label,
        target_json = excluded.target_json, updated_at = excluded.updated_at`;
      }).pipe(Effect.mapError(storageError)),
    deleteRegistration: (id) =>
      sql`DELETE FROM hub_node_registrations WHERE route_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    upsertRouteState: (row) =>
      sql`INSERT INTO hub_node_route_state (route_id, environment_id, status, checked_at, last_seen_at, last_error)
      VALUES (${row.routeId}, ${row.environmentId}, ${row.status}, ${row.checkedAt}, ${row.lastSeenAt}, ${row.lastError})
      ON CONFLICT(route_id) DO UPDATE SET environment_id = excluded.environment_id, status = excluded.status,
      checked_at = excluded.checked_at, last_seen_at = excluded.last_seen_at, last_error = excluded.last_error`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    deleteRouteState: (id) =>
      sql`DELETE FROM hub_node_route_state WHERE route_id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    putImport: (row) =>
      sql`INSERT INTO hub_node_imports (source, outcome, imported, at, notice_dismissed_at)
      VALUES (${row.source}, ${row.outcome}, ${row.imported}, ${row.at}, ${row.noticeDismissedAt})
      ON CONFLICT(source) DO UPDATE SET outcome = excluded.outcome, imported = excluded.imported,
      at = excluded.at, notice_dismissed_at = excluded.notice_dismissed_at`.pipe(
        Effect.asVoid,
        Effect.mapError(storageError),
      ),
    dismissImportNotice: (at) =>
      sql`UPDATE hub_node_imports SET notice_dismissed_at = ${at}
      WHERE source = 'desktop-catalog' AND outcome = 'skipped_locked' AND notice_dismissed_at IS NULL
      RETURNING source`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(storageError),
      ),
    transaction: (effect) =>
      sql
        .withTransaction(effect)
        .pipe(Effect.catchTags({ SqlError: () => Effect.fail(storageError()) })),
  });
});
export const layer = Layer.effect(HubNodeRepository, make);
