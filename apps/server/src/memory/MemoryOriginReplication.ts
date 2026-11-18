import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Client from "./MemoryHubClient.ts";
import type * as Hub from "./MemoryHubService.ts";
import type * as Store from "./MemoryStore.ts";
import type * as Service from "./MemoryService.ts";
import { recordCanonicalMemoryOrigin } from "./MemoryRevisionMarks.ts";
import { stored } from "./store/StoreCodecs.ts";
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

const applyMemoryOriginUpdatesTx = Effect.fn("MemoryStore.applyOriginUpdatesTx")(function* (
  sql: SqlClient.SqlClient,
  input: Pick<M.MemoryHubPushInput, "memorySpaceId" | "environmentId">,
  updates: readonly M.MemoryOriginUpdate[],
) {
  yield* Transaction;
  const { memorySpaceId: space, environmentId } = input;
  let changed = false;
  for (const { memoryId, createOperationId, threadId } of updates) {
    const settled = yield* stored(
      "memory-origin-settled",
      sql`SELECT 1 WHERE ${settledCreation(sql, space, sql`${createOperationId}`)}`,
    );
    if (!settled.length) continue;
    const recorded = yield* recordCanonicalMemoryOrigin(
      space,
      memoryId,
      { environmentId, threadId },
      createOperationId,
    ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
    changed ||= recorded;
  }
  return changed;
});

export const publishMemoryOriginUpdatesTx = Effect.fn("MemoryStore.publishOriginUpdatesTx")(
  function* (...args: Parameters<typeof applyMemoryOriginUpdatesTx>) {
    const [sql, { memorySpaceId }] = args;
    if (yield* applyMemoryOriginUpdatesTx(...args))
      // A new join needs the latest identity metadata. Existing handles keep their pinned pages.
      yield* stored(
        "memory-origin-stale-checkpoint",
        sql`UPDATE memory_hub_retention SET checkpoint_id=NULL
          WHERE space=${memorySpaceId} AND checkpoint_id IS NOT NULL`,
      );
  },
);

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
  return Effect.fn("MemorySyncService.replicateOrigins")(function* (route: Route) {
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
        ORDER BY o.memory_id LIMIT ${M.MEMORY_ORIGIN_UPDATE_MAX}`,
    );
    if (!updates.length) return;
    const epoch = route.settings.memoryHubVersion;
    const input = {
      protocolVersion: 1 as const,
      memorySpaceId: space,
      environmentId: local,
      operations: [],
      originUpdates: updates,
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
        ensureEpoch(epoch).pipe(Effect.andThen(applyMemoryOriginUpdatesTx(sql, input, updates))),
      );
  });
};
