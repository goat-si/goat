import * as M from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as ProviderRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import migration from "../persistence/Migrations/077_Memory.ts";
import lastReadyMigration from "../persistence/Migrations/087_MemoryLastReadySpace.ts";
import hubMigration from "../persistence/Migrations/078_MemoryHubSync.ts";
import lineageMigration from "../persistence/Migrations/081_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/082_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/094_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/083_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/084_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/085_MemoryRevertResults.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Client from "./MemoryHubClient.ts";
import * as Sync from "./MemorySyncService.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";

export const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const space = M.MemorySpaceId.make(id(1));
export const local = M.EnvironmentId.make("fixture-member");
export const remote = M.EnvironmentId.make("fixture-hub");
export const selection = { instanceId: M.ProviderInstanceId.make("P"), model: "P" };
// Memory falls back from disabled instances, so the fixture models need enabled instances.
export const fixtureInstances = Object.fromEntries(
  ["P", "Q"].map((id) => [
    M.ProviderInstanceId.make(id),
    { driver: M.ProviderDriverKind.make("codex"), enabled: true, config: {} },
  ]),
);
export const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export const decodeStatus = Schema.decodeUnknownEffect(M.MemorySyncStatus);
export const pushDecode = Schema.decodeUnknownSync(Schema.fromJsonString(M.MemoryHubPushInput));
export const timestamp = "1970-01-01T00:00:00.000Z";
export const member = {
  mode: "member" as const,
  memorySpaceId: space,
  hubEnvironmentId: remote,
  endpoint: M.MemoryHubEndpoint.make("https://fixture.invalid"),
  secretName: "memory-hub-fixture",
};
export const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
  getEnvironmentId: Effect.succeed(local),
});
const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* migration;
    yield* hubMigration;
    yield* lineageMigration;
    yield* checkpointMigration;
    yield* revisionSizeMigration;
    yield* reportMigration;
    yield* usageMigration;
    yield* revertMigration;
    yield* lastReadyMigration;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE orchestration_events (sequence INTEGER PRIMARY KEY,event_id TEXT,stream_id TEXT,event_type TEXT,payload_json TEXT,occurred_at TEXT,application_event_version INTEGER,aggregate_kind TEXT)`;
    yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY,deleted_at TEXT)`;
  }),
).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })));
export const storage = Store.layer.pipe(Layer.provideMerge(setup));
const quota = Quota.layer.pipe(Layer.provideMerge(storage));
const coreFor = (environmentIdentity = identity, quotaLayer = quota) =>
  Service.layer.pipe(
    Layer.provide(
      Layer.succeed(Settings.MemoryHubCommittedSettings, {
        read: Effect.succeed({
          provenance: null,
          settings: { mode: "hub" as const, memorySpaceId: space },
          version: 1,
        }),
      }),
    ),
    Layer.provideMerge(quotaLayer),
    Layer.provide(environmentIdentity),
    Layer.provide(
      Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
  );
export const core = coreFor();
const hubFor = (serviceCore = core) =>
  Hub.layer.pipe(
    Layer.provideMerge(serviceCore),
    Layer.provide(Hub.activityLayer),
    Layer.provide(Layer.succeed(Hub.MemoryHubConfiguration, { read: Effect.succeed(null) })),
  );
// Real Store ports; the fixture Settings authority below is a SQL-free Ref.
export const runtimeBase = Layer.effect(
  Sync.MemorySyncRuntime,
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const settings = yield* Settings.ServerSettingsService;
    return Sync.MemorySyncRuntime.of({
      cwd: "/tmp/memory-sync-fixture",
      readIntentBinding: settings.getSettings.pipe(
        Effect.map((s) => ({
          memorySpaceId: s.memoryHub.mode === "disabled" ? null : s.memoryHub.memorySpaceId,
          coordinatorEpoch: s.memoryHubVersion,
          enabled: s.memoryHub.mode !== "disabled",
        })),
        Effect.mapError(() => new Service.MemoryAccessError({ code: "fenced" })),
      ),
      available: () => Effect.void,
      ownerPermit: () => Effect.void,
      ownerReader: {
        readCommitted: () => Effect.succeed({ kind: "unavailable", code: "source_unavailable" }),
      },
      readBootstrap: (s, h) => store.readBootstrap({ memorySpaceId: s, hubEnvironmentId: h }),
      discardBootstrap: (s, h, token) =>
        store.transact(
          Effect.gen(function* () {
            const progress = yield* store.readBootstrap({ memorySpaceId: s, hubEnvironmentId: h });
            if (progress.snapshotToken !== token || !progress.checkpointId) return;
            yield* store.discardBootstrapTx({
              memorySpaceId: s,
              hubEnvironmentId: h,
              expectedSnapshotToken: token,
              expectedCheckpointId: progress.checkpointId,
              expectedCheckpointSequence: progress.checkpointSequence,
            });
          }),
        ),
      readUnboundStorage: Effect.fail(
        new Store.MemoryStorageError({ stage: "fixture-unbound", cause: "L5 adapter pending" }),
      ),
      readProcessing: (s, h) =>
        s && h
          ? store.readProcessing({ memorySpaceId: s, hubEnvironmentId: h })
          : Effect.fail(
              new Store.MemoryStorageError({
                stage: "fixture-unbound",
                cause: "L1 nullable status port pending",
              }),
            ),
    });
  }),
);

export const peer = (
  overrides: Partial<Client.MemoryHubClient["Service"]> = {},
  // The Hub ends a lease on release, so a released attempt can no longer renew or release again.
  {
    releaseEndsLease = false,
    lostReleaseResponses = 0,
  }: { releaseEndsLease?: boolean; lostReleaseResponses?: number } = {},
) => {
  let lost = lostReleaseResponses;
  const issued = new Map<string, M.MemoryResolutionLease>();
  const defaultClaim: Client.MemoryHubClient["Service"]["claim"] = (
    _c,
    { protocolVersion: _protocol, ...claim },
  ) =>
    Effect.succeed({
      ...claim,
      fencingToken: 1,
      claimedAtHubTime: timestamp,
      expiresAtHubTime: "1970-01-01T00:02:00.000Z",
      attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
    });
  const claim = overrides.claim ?? defaultClaim;
  return Layer.mock(Client.MemoryHubClient)({
    pull: (_c, i) =>
      Effect.succeed({
        highWatermark: i.highWatermark ?? i.afterSequence,
        throughSequence: i.afterSequence,
        hasMore: false,
        entries: [],
      }),
    collectSourceReads: () => Effect.succeed({ requests: [] }),
    push: (_c, i) =>
      Effect.succeed({
        receipts: i.operations.map((operation, index) => ({
          operationId: operation.operationId,
          memoryId: operation.memoryId,
          operationDigest: memoryOperationDigest(operation),
          hubSequence: index + 1,
          outcome: "accepted" as const,
        })),
      }),
    release: (_c, i) =>
      Effect.suspend(() => {
        if (!releaseEndsLease) return Effect.succeed({ released: true });
        if (!issued.delete(i.attemptId))
          return Effect.fail(new M.MemoryHubError({ code: "fenced" }));
        // The Hub committed the release, but its answer never arrived.
        if (lost-- > 0) return Effect.fail(new M.MemoryHubError({ code: "unavailable" }));
        return Effect.succeed({ released: true });
      }),
    ...overrides,
    claim: (c, i) =>
      claim(c, i).pipe(
        Effect.tap((ticket) =>
          Effect.sync(() => {
            issued.set(ticket.attemptId, ticket);
          }),
        ),
      ),
    renew:
      overrides.renew ??
      ((_c, i) => {
        const ticket = issued.get(i.attemptId);
        return ticket
          ? Effect.succeed(ticket)
          : Effect.fail(new M.MemoryHubError({ code: "lease_expired" }));
      }),
  });
};
export const realGeneration = (overrides: Partial<Generation.TextGeneration["Service"]>) => {
  const provider = Generation.TextGeneration.of({
    generateCommitMessage: () => Effect.die("unexpected fixture operation"),
    generatePrContent: () => Effect.die("unexpected fixture operation"),
    generateBranchName: () => Effect.die("unexpected fixture operation"),
    generateThreadTitle: () => Effect.die("unexpected fixture operation"),
    generateReviewGuide: () => Effect.die("unexpected fixture operation"),
    ...overrides,
  });
  return Layer.effect(Generation.TextGeneration, Generation.make).pipe(
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderInstanceRegistry)({
        getInstance: (instanceId) =>
          Effect.succeed({
            instanceId,
            driverKind: M.ProviderDriverKind.make("codex"),
            continuationIdentity: {
              driverKind: M.ProviderDriverKind.make("codex"),
              continuationKey: "synthetic-provider",
            },
            displayName: undefined,
            enabled: true,
            snapshot: {} as ProviderInstance["snapshot"],
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: provider,
          } satisfies ProviderInstance),
      }),
    ),
    Layer.provide(
      Layer.mock(SourceControl.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("memory resolution does not read source control"),
      }),
    ),
  );
};
// Preserve real settings CAS/normalization, adding the production-style subscribed stream.
const changingSettings = (disabled: boolean) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const base = yield* Settings.ServerSettingsService;
      const committed = Option.getOrThrow(
        yield* Effect.serviceOption(Settings.MemoryHubCommittedSettings),
      );
      const transitions = Option.getOrThrow(
        yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
      );
      const changes =
        yield* PubSub.bounded<
          Effect.Success<Settings.ServerSettingsService["Service"]["getSettings"]>
        >(16);
      const publish = base.getSettings.pipe(Effect.flatMap((s) => PubSub.publish(changes, s)));
      return Layer.mergeAll(
        Layer.succeed(Settings.MemoryHubCommittedSettings, committed),
        Layer.succeed(Settings.ServerSettingsService, {
          ...base,
          subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
          streamChanges: Stream.fromPubSub(changes),
          updateSettings: (patch) => base.updateSettings(patch).pipe(Effect.tap(() => publish)),
        }),
        Layer.succeed(Settings.MemoryHubSettingsTransitions, {
          applyMemoryHubTransition: (input, permit) =>
            transitions.applyMemoryHubTransition(input, permit).pipe(Effect.tap(() => publish)),
        }),
      );
    }).pipe(
      Effect.provide(
        Settings.layerTest(
          {
            memoryHub: disabled ? { mode: "disabled" } : member,
            memoryHubVersion: 1,
            memoryModelSelection: selection,
            providerInstances: fixtureInstances,
          },
          "memoryHub",
        ),
      ),
    ),
  );
export const fixture = (
  client: Layer.Layer<Client.MemoryHubClient, never, Settings.ServerSettingsService> = peer(),
  generation = realGeneration({ resolveMemoryConflict: () => Effect.never }),
  disabled = false,
  changing = false,
  environmentId = local,
  quotaLayer = quota,
) => {
  const environmentIdentity =
    environmentId === local
      ? identity
      : Layer.succeed(Environment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        });
  const serviceCore =
    environmentId === local && quotaLayer === quota
      ? core
      : coreFor(environmentIdentity, quotaLayer);
  const sharedSettings = changing
    ? changingSettings(disabled)
    : Settings.layerTest(
        {
          memoryHub: disabled ? { mode: "disabled" } : member,
          memoryHubVersion: 1,
          memoryModelSelection: selection,
          providerInstances: fixtureInstances,
        },
        "memoryHub",
      );
  // layerTest supplies this tag at runtime but its declared output still hides it (L5 handoff).
  const committed = Layer.effect(
    Settings.MemoryHubCommittedSettings,
    Effect.serviceOption(Settings.MemoryHubCommittedSettings).pipe(Effect.map(Option.getOrThrow)),
  ).pipe(Layer.provide(sharedSettings));
  const shared = Layer.mergeAll(
    hubFor(serviceCore),
    runtimeBase.pipe(Layer.provide(serviceCore)),
    environmentIdentity,
    generation,
  ).pipe(Layer.provideMerge(Layer.merge(sharedSettings, committed)));
  return Sync.layer.pipe(Layer.provideMerge(client.pipe(Layer.provideMerge(shared))));
};
export const ready = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},${remote},0,'ready')`;
});
export const operation = (n: number, memory = M.MemoryId.make(id(2))): M.MemoryOperation => {
  const operationId = M.MemoryOperationId.make(id(n + 100));
  const revisionId = M.MemoryRevisionId.make(id(n + 200));
  return {
    protocolVersion: 1,
    operationId,
    memorySpaceId: space,
    memoryId: memory,
    originEnvironmentId: local,
    expectedHeads: [],
    kind: "upsert",
    revision: {
      memorySpaceId: space,
      memoryId: memory,
      operationId,
      revisionId,
      payloadRef: revisionId,
      parents: [],
      scope: { kind: "user" },
      assertionKind: "inference",
      provenance: { environmentId: local },
      createdAtUtc: timestamp,
    },
    payload: { text: `synthetic fact ${n}`, evidence: [], derivedFromMemoryRevisions: [] },
  };
};
export const commit = (op: M.MemoryOperation) =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    yield* store.apply(
      decideMemoryOperation(
        yield* store.loadAggregate(op.memorySpaceId, op.memoryId),
        op,
        Store.hubAdmission,
        { kind: "allowed" },
      ),
    );
  });
export const conflict = (n = 1, targetSpace = space) =>
  Effect.gen(function* () {
    const original = operation(n * 3, M.MemoryId.make(id(n + 2)));
    if (original.kind !== "upsert") throw new Error("fixture");
    const first = {
      ...original,
      memorySpaceId: targetSpace,
      revision: { ...original.revision, memorySpaceId: targetSpace },
    };
    if (first.kind !== "upsert") throw new Error("fixture");
    yield* commit(first);
    for (const next of [
      operation(n * 3 + 1, first.memoryId),
      operation(n * 3 + 2, first.memoryId),
    ]) {
      if (next.kind !== "upsert") throw new Error("fixture");
      yield* commit({
        ...next,
        memorySpaceId: targetSpace,
        expectedHeads: [first.revision.revisionId],
        revision: {
          ...next.revision,
          memorySpaceId: targetSpace,
          parents: [first.revision.revisionId],
        },
      });
    }
    return first.memoryId;
  });
export const sourceFixture = Effect.gen(function* () {
  const sourceThread = { environmentId: local, threadId: M.ThreadId.make("deadline-thread") };
  const watermark = {
    fromEventId: M.EventId.make("from"),
    toEventId: M.EventId.make("to"),
    throughSequence: 2,
  };
  const messageIds = [M.MessageId.make("completed-message")];
  const base = operation(8000);
  if (base.kind !== "upsert") throw new Error("fixture");
  const op = {
    ...base,
    revision: {
      ...base.revision,
      provenance: { environmentId: local, sourceThread, sourceWatermark: watermark },
    },
    payload: {
      text: "synthetic linked summary",
      evidence: [{ origin: "thread" as const, sourceThread, watermark, messageIds }],
      derivedFromMemoryRevisions: [],
    },
  };
  const store = yield* Store.MemoryStore;
  yield* store.apply(
    decideMemoryOperation(yield* store.loadAggregate(space, op.memoryId), op, Store.localIntent, {
      kind: "allowed",
    }),
  );
  return yield* (yield* Service.MemoryService).prepareSourceRead(
    { memorySpaceId: space, memoryId: op.memoryId, sourceThread, messageIds, limit: 10 },
    Effect.void,
  );
});
