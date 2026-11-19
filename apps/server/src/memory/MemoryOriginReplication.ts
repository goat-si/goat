import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Client from "./MemoryHubClient.ts";
import type * as Hub from "./MemoryHubService.ts";
import type * as Store from "./MemoryStore.ts";
import type * as Service from "./MemoryService.ts";
import { recordCanonicalMemoryOrigin } from "./MemoryRevisionMarks.ts";
import { stored } from "./store/StoreCodecs.ts";
import { MEMORY_ORIGIN_PAGE_ROW_BYTES, memoryOriginRowBytes } from "./store/OriginCatchup.ts";
import { Transaction } from "./store/StoreModel.ts";

const settledCreation = (
  sql: SqlClient.SqlClient,
  space: M.MemorySpaceId,
  createOperationId: import("effect/sql/Statement").Fragment,
) => sql`EXISTS (
  SELECT 1 FROM memory_compact_receipts c WHERE c.space=${space} AND c.operation_id=${createOperationId}
    AND json_extract(c.receipt_json,'$.outcome')='accepted'
  UNION ALL
  SELECT 1 FROM memory_events e WHERE e.memory_space_id=${space} AND e.operation_id=${createOperationId}
    AND json_extract(e.receipt_json,'$.hubSequence')>0 AND json_extract(e.receipt_json,'$.outcome')='accepted'
)`;

const applyMemoryOriginUpdateTx = Effect.fn("MemoryStore.applyOriginUpdateTx")(function* (
  sql: SqlClient.SqlClient,
  {
    memorySpaceId: space,
    environmentId,
  }: Pick<M.MemoryHubPushInput, "memorySpaceId" | "environmentId">,
  { memoryId, createOperationId, threadId }: M.MemoryOriginUpdate,
) {
  const settled = yield* stored(
    "memory-origin-settled",
    sql`SELECT 1 WHERE ${settledCreation(sql, space, sql`${createOperationId}`)}`,
  );
  return (
    settled.length > 0 &&
    (yield* recordCanonicalMemoryOrigin(
      space,
      memoryId,
      { environmentId, threadId },
      createOperationId,
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql)))
  );
});

export const publishMemoryOriginUpdatesTx = Effect.fn("MemoryStore.publishOriginUpdatesTx")(
  function* (
    sql: SqlClient.SqlClient,
    input: Parameters<typeof applyMemoryOriginUpdateTx>[1],
    updates: readonly M.MemoryOriginUpdate[],
  ) {
    yield* Transaction;
    const { memorySpaceId: space, environmentId } = input;
    const [row] = yield* stored(
      "memory-origin-counter",
      sql<{
        sequence: number;
      }>`SELECT origin_update_sequence AS sequence FROM memory_space_counters WHERE space=${space}`,
    );
    const previous = row?.sequence ?? 0;
    let sequence = previous;
    for (const update of updates) {
      if (
        memoryOriginRowBytes({ ...update, environmentId, sequence: sequence + 1 }) >
        MEMORY_ORIGIN_PAGE_ROW_BYTES
      )
        continue;
      if (!(yield* applyMemoryOriginUpdateTx(sql, input, update))) continue;
      sequence++;
      yield* stored(
        "memory-origin-publish",
        sql`UPDATE memory_origins SET origin_sequence=${sequence}
          WHERE space=${space} AND memory_id=${update.memoryId}`,
      );
    }
    if (sequence === previous) return;
    yield* stored(
      "memory-origin-next-sequence",
      sql`INSERT INTO memory_space_counters(space,forget_generation,origin_update_sequence)
        VALUES (${space},0,${sequence})
        ON CONFLICT(space) DO UPDATE SET origin_update_sequence=excluded.origin_update_sequence`,
    );
    // A new join needs the latest identity metadata. Existing handles keep their pinned pages.
    yield* stored(
      "memory-origin-stale-checkpoint",
      sql`UPDATE memory_hub_retention SET checkpoint_id=NULL
        WHERE space=${space} AND checkpoint_id IS NOT NULL`,
    );
  },
);

const encodePull = Schema.encodeEffect(Schema.fromJsonString(M.MemoryHubPullResult));

export const withOriginCatchupPage = Effect.fn("MemoryHubService.attachOriginPage")(function* (
  store: Pick<Store.MemoryStore["Service"], "readOriginPageTx">,
  request: M.MemoryHubPullInput,
  tail: M.MemoryHubPullResult,
) {
  if (
    !tail.derivedCap ||
    tail.hasMore ||
    request.afterOriginSequence === undefined ||
    !M.supportsMemoryFloor2(request.features)
  )
    return tail;
  // Origin updates can describe creations after a pinned log watermark.
  if (request.highWatermark === undefined) {
    const originPage = yield* store
      .readOriginPageTx(request.memorySpaceId, request.afterOriginSequence)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Memory origin catch-up could not be read", error._tag).pipe(
            Effect.as(null),
          ),
        ),
      );
    if (!originPage) return tail;
    const combined = { ...tail, originPage };
    if (yield* Effect.isSuccess(encodePull(combined))) return combined;
  }
  const pending = { ...tail, originCatchupPending: true as const };
  return (yield* Effect.isSuccess(encodePull(pending))) ? pending : tail;
});

type Route = {
  readonly space: M.MemorySpaceId | null;
  readonly connection: Client.HubConnection | null;
  readonly principal: M.MemoryHubPrincipal | null;
  readonly settings: { readonly memoryHubVersion: number };
};

export const makeMemoryOriginReplication = (
  sql: SqlClient.SqlClient,
  options: {
    store: Store.MemoryStore["Service"];
    local: M.EnvironmentId;
    hub: Hub.MemoryHubService["Service"];
    client: Client.MemoryHubClient["Service"];
    ensureEpoch: (epoch: number) => Effect.Effect<void, Service.MemoryAccessError>;
  },
) => {
  const { store, local, hub, client, ensureEpoch } = options;
  return Effect.fn("MemorySyncService.replicateOrigins")(
    function* (route: Route) {
      const space = route.space;
      if (space === null) return;
      const creation = sql`json_extract(i.identity_json,'$.createOperationId')`;
      const updates = yield* stored(
        "memory-origin-backfill",
        sql<M.MemoryOriginUpdate>`
        SELECT o.memory_id AS memoryId,o.thread_id AS threadId,${creation} AS createOperationId
        FROM memory_origins o JOIN memory_identity_ledger i ON i.space=o.space AND i.memory_id=o.memory_id
        WHERE o.space=${space} AND o.environment_id=${local}
          AND EXISTS (SELECT 1 FROM memory_space_features f WHERE f.space=${space} AND f.derived_cap >= ${M.MEMORY_DERIVED_REVISIONS_MAX})
          AND json_extract(i.identity_json,'$.creatingEnvironmentId')=${local}
          AND json_type(i.identity_json,'$.origin') IS NULL AND ${settledCreation(sql, space, creation)}
          AND NOT EXISTS (SELECT 1 FROM memory_tombstones t WHERE t.space=o.space AND t.memory_id=o.memory_id)
          AND NOT EXISTS (SELECT 1 FROM memory_pending_forget_intents f WHERE f.space=o.space AND f.memory_id=o.memory_id)
          AND length(CAST(json_object(
            'sequence',1,'memoryId',o.memory_id,'environmentId',o.environment_id,
            'threadId',o.thread_id,'createOperationId',${creation}
          ) AS BLOB))+1 <= ${MEMORY_ORIGIN_PAGE_ROW_BYTES}
        ORDER BY o.memory_id LIMIT ${M.MEMORY_ORIGIN_UPDATE_MAX}`,
      );
      let bytes = 0;
      const page = [];
      for (const update of updates) {
        const size = memoryOriginRowBytes({ ...update, environmentId: local, sequence: 1 });
        if (size > MEMORY_ORIGIN_PAGE_ROW_BYTES) continue;
        if (bytes + size > MEMORY_ORIGIN_PAGE_ROW_BYTES) break;
        page.push(update);
        bytes += size;
      }
      if (!page.length) return;
      const epoch = route.settings.memoryHubVersion;
      const input = {
        protocolVersion: 1 as const,
        memorySpaceId: space,
        environmentId: local,
        operations: [],
        originUpdates: page,
      };
      yield* ensureEpoch(epoch);
      const accepted = yield* (
        route.connection
          ? client.push(route.connection, input)
          : route.principal
            ? hub.push({ ...input, features: M.MEMORY_FLOOR_2 }, route.principal)
            : Effect.fail(new M.MemoryHubError({ code: "bootstrap_required" }))
      ).pipe(
        Effect.as(true),
        Effect.catchTags({
          MemoryHubError: (error) =>
            error.code === "hub_upgrade_required" ? Effect.succeed(false) : Effect.fail(error),
        }),
      );
      if (accepted)
        yield* store.transact(
          ensureEpoch(epoch).pipe(
            Effect.andThen(
              Effect.forEach(page, (update) => applyMemoryOriginUpdateTx(sql, input, update), {
                discard: true,
              }),
            ),
          ),
        );
    },
    Effect.catch((error) =>
      Effect.logWarning("Memory origin updates could not be pushed", error._tag),
    ),
  );
};
