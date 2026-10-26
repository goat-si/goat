import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Settings from "../serverSettings.ts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import migration from "../persistence/Migrations/077_Memory.ts";
import hubMigration from "../persistence/Migrations/078_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/085_MemoryRevertResults.ts";
import readyMigration from "../persistence/Migrations/087_MemoryLastReadySpace.ts";
import adminMigration from "../persistence/Migrations/088_MemoryHubAdministered.ts";
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
export const otherEnv = M.EnvironmentId.make("member");
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
    Effect.andThen(readyMigration),
    Effect.andThen(adminMigration),
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
export const configuration = Layer.succeed(Hub.MemoryHubConfiguration, {
  read: Effect.succeed({ memorySpaceId: space, hubEnvironmentId: hubEnv }),
});
export const live = Layer.merge(Hub.layer, Compactor.layer).pipe(
  Layer.provideMerge(core),
  Layer.provideMerge(Hub.activityLayer),
  Layer.provide(configuration),
);
export const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${"a".repeat(64)},1,'active',0),(${space},${otherEnv},${"b".repeat(64)},1,'active',0)`;
});
export const operation = (
  n = 10,
  env = hubEnv,
): Extract<M.MemoryOperation, { kind: "upsert" }> => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  originEnvironmentId: env,
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
    provenance: { environmentId: env },
  },
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
});
export const pushInput = (...operations: M.MemoryOperation[]): M.MemoryHubPushInput => ({
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId: hubEnv,
  operations,
});
export const pullInput: M.MemoryHubPullInput = {
  protocolVersion: 1,
  memorySpaceId: space,
  environmentId: hubEnv,
  afterSequence: 0,
  limit: 100,
};
export const conflict = Effect.gen(function* () {
  const hub = yield* Hub.MemoryHubService;
  const first = operation();
  yield* hub.push(pushInput(first), principal());
  const sibling = (n: number) => {
    const op = operation(n);
    return {
      ...op,
      expectedHeads: [first.revision.revisionId],
      revision: { ...op.revision, parents: [first.revision.revisionId] },
    };
  };
  yield* hub.push(pushInput(sibling(11), sibling(12)), principal());
  const store = yield* Store.MemoryStore;
  const current = yield* store.loadAggregate(space, memoryId);
  const [conflict] = current.conflicts;
  if (conflict === undefined) throw new Error("Expected a fixture memory conflict");
  const claim: M.MemoryHubClaimInput = {
    protocolVersion: 1,
    memorySpaceId: space,
    memoryId,
    holderEnvironmentId: hubEnv,
    conflictId: conflict.conflictId,
    conflictHeadSet: current.heads,
    attemptId: M.MemoryOperationId.make(id(50)),
    frozenDefaultModelSelection: {
      instanceId: M.ProviderInstanceId.make("synthetic-provider"),
      model: "synthetic-model",
    },
  };
  return { hub, store, claim };
});
