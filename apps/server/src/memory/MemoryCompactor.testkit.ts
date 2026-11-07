import * as Settings from "../serverSettings.ts";
import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/088_Memory.ts";
import hubMigration from "../persistence/Migrations/089_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/092_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/093_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/105_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/094_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/095_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/096_MemoryRevertResults.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const space = M.MemorySpaceId.make(id(1));
export const memoryId = M.MemoryId.make(id(2));
export const hubEnv = M.EnvironmentId.make("hub");
export const memberEnv = M.EnvironmentId.make("member");
export const principal = (environmentId = hubEnv): M.MemoryHubPrincipal => ({
  memorySpaceId: space,
  environmentId,
  credentialVersion: 1,
  scopes: ["memory:sync"],
});
const database = Layer.effectDiscard(
  migration.pipe(
    Effect.andThen(hubMigration),
    Effect.andThen(lineageMigration),
    Effect.andThen(checkpointMigration),
    Effect.andThen(revisionSizeMigration),
    Effect.andThen(reportMigration),
    Effect.andThen(usageMigration),
    Effect.andThen(revertMigration),
  ),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
const storeLayer = Store.layer.pipe(Layer.provideMerge(database));
export const core = Service.layer.pipe(
  Layer.provide(
    Layer.succeed(Settings.MemoryHubCommittedSettings, {
      read: Effect.succeed({
        provenance: null,
        settings: { mode: "hub" as const, memorySpaceId: space },
        version: 1,
      }),
    }),
  ),
  Layer.provide(
    Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
      resolve: () => Effect.succeed(null),
    }),
  ),
  Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(storeLayer))),
  Layer.provide(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(hubEnv),
    }),
  ),
);
export const live = Layer.merge(Hub.layer, Compactor.layer).pipe(
  Layer.provideMerge(core),
  Layer.provideMerge(Hub.activityLayer),
  Layer.provide(
    Layer.succeed(Hub.MemoryHubConfiguration, {
      read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
    }),
  ),
);
export const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${"a".repeat(64)},1,'active',0),(${space},${memberEnv},${"b".repeat(64)},1,'active',0)`;
});
export const operation = (n = 10): Extract<M.MemoryOperation, { kind: "upsert" }> => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  originEnvironmentId: hubEnv,
  operationId: M.MemoryOperationId.make(id(n)),
  expectedHeads: [],
  revision: {
    memorySpaceId: space,
    memoryId,
    operationId: M.MemoryOperationId.make(id(n)),
    revisionId: M.MemoryRevisionId.make(id(n + 100)),
    parents: [],
    scope: { kind: "user" },
    payloadRef: M.MemoryRevisionId.make(id(n + 100)),
    assertionKind: "inference",
    createdAtUtc: M.MemoryUtcTimestamp.make("2026-10-14T00:00:00.000Z"),
    provenance: { environmentId: hubEnv },
  },
  payload: { text: "synthetic durable memory", evidence: [], derivedFromMemoryRevisions: [] },
});
export const push = (op = operation()) =>
  Effect.gen(function* () {
    return yield* (yield* Hub.MemoryHubService).push(
      { protocolVersion: 1, memorySpaceId: space, environmentId: hubEnv, operations: [op] },
      principal(),
    );
  });
export const pull = (afterSequence: number, environmentId = hubEnv): M.MemoryHubPullInput => ({
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId,
  afterSequence,
  limit: 100,
});

export const escapedOperation = () => {
  const base = operation(15);
  const sourceThread = {
    environmentId: hubEnv,
    threadId: M.ThreadId.make("\u0000".repeat(1024)),
  };
  const op = {
    ...base,
    revision: {
      ...base.revision,
      scope: { kind: "thread" as const, thread: sourceThread },
      provenance: {
        environmentId: hubEnv,
        upsertRequestDigest: "d".repeat(64),
        sourceThread,
        sourceWatermark: {
          fromEventId: M.EventId.make('"'.repeat(1024)),
          toEventId: M.EventId.make("\\".repeat(1024)),
          throughSequence: Number.MAX_SAFE_INTEGER,
        },
        importSource: {
          sourceId: M.MemoryImportSourceId.make(id(8000)),
          format: "codex" as const,
          parserVersion: '"'.repeat(1024),
          sourceLocator: "\u0000".repeat(1024),
          sourceItemKey: "\u0000".repeat(512),
          sourceFingerprint: "a".repeat(64),
          contentFingerprint: "b".repeat(64),
          sourceAliases: Array.from({ length: 3 }, (_, i) => ({
            environmentId: hubEnv,
            sourceId: M.MemoryImportSourceId.make(id(8100 + i)),
            sourceItemKey: "\u0000".repeat(512),
          })),
          acceptedContentFingerprints: Array.from({ length: 100 }, (_, i) =>
            String(i).padStart(64, "0"),
          ),
        },
      },
    },
    payload: {
      text: '\u0000\u0001"\\한🙂'.repeat(100),
      evidence: [],
      derivedFromMemoryRevisions: [],
    },
  };
  return op;
};
