import { legacySyncStatusRpc } from "./MemorySyncStatusLegacy.testkit.ts";
import * as Hold from "./MemoryGenerationHold.ts";
import { MemoryGenerationRunnerError } from "@goat/provider-core/server/memoryGenerationRunner";
import * as Rpc from "effect/rpc/Rpc";
import * as Exit from "effect/Exit";
import { McpServer } from "effect/ai";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpAccess from "../mcp/McpToolAccess.testkit.ts";
import * as McpFixture from "../mcp/toolkits/memory/handlers.testkit.ts";
import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Statement from "effect/sql/Statement";
import * as ServerConfig from "../config.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as ProviderRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Events from "../orchestration-v2/EventSink.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import migration from "../persistence/Migrations/076_Memory.ts";
import lastReadyMigration from "../persistence/Migrations/086_MemoryLastReadySpace.ts";
import hubMigration from "../persistence/Migrations/077_MemoryHubSync.ts";
import searchMigration from "../persistence/Migrations/078_MemorySearchCounters.ts";
import lineageMigration from "../persistence/Migrations/080_MemoryImportLineage.ts";
import checkpointMigration from "../persistence/Migrations/081_MemoryCheckpointAccounting.ts";
import revisionSizeMigration from "../persistence/Migrations/093_MemoryRevisionCheckpointSize.ts";
import reportMigration from "../persistence/Migrations/082_MemoryReportLifecycle.ts";
import usageMigration from "../persistence/Migrations/083_MemoryUsageCounters.ts";
import revertMigration from "../persistence/Migrations/084_MemoryRevertResults.ts";
import * as Store from "./MemoryStore.ts";
import * as Service from "./MemoryService.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Client from "./MemoryHubClient.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Worker from "./MemoryWorker.ts";
import { sourceReadLocatorDigest } from "./MemoryOwnerSourceReader.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import { decideMemoryOperation, memoryOperationDigest } from "./MemoryDecider.ts";
const decodeReplayReceipt = Schema.decodeUnknownEffect(M.MemoryMutationReceipt);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const local = M.EnvironmentId.make("fixture-member");
const remote = M.EnvironmentId.make("fixture-hub");
const selection = { instanceId: M.ProviderInstanceId.make("P"), model: "P" };
// Memory falls back from disabled instances, so the fixture models need enabled instances.
const fixtureInstances = Object.fromEntries(
  ["P", "Q"].map((id) => [
    M.ProviderInstanceId.make(id),
    { driver: M.ProviderDriverKind.make("codex"), enabled: true, config: {} },
  ]),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeStatus = Schema.decodeUnknownEffect(M.MemorySyncStatus);
const pushDecode = Schema.decodeUnknownSync(Schema.fromJsonString(M.MemoryHubPushInput));
const timestamp = "1970-01-01T00:00:00.000Z";
const member = {
  mode: "member" as const,
  memorySpaceId: space,
  hubEnvironmentId: remote,
  endpoint: M.MemoryHubEndpoint.make("https://fixture.invalid"),
  secretName: "memory-hub-fixture",
};
const identity = Layer.succeed(Environment.ServerEnvironmentIdentity, {
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
const storage = Store.layer.pipe(Layer.provideMerge(setup));
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
const core = coreFor();
const hubFor = (serviceCore = core) =>
  Hub.layer.pipe(
    Layer.provideMerge(serviceCore),
    Layer.provide(Hub.activityLayer),
    Layer.provide(Layer.succeed(Hub.MemoryHubConfiguration, { read: Effect.succeed(null) })),
  );
// Real Store ports; the fixture Settings authority below is a SQL-free Ref.
const runtimeBase = Layer.effect(
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

const peer = (
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
const realGeneration = (overrides: Partial<Generation.TextGeneration["Service"]>) => {
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
const fixture = (
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
const ready = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},${remote},0,'ready')`;
});
const operation = (n: number, memory = M.MemoryId.make(id(2))): M.MemoryOperation => {
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
const commit = (op: M.MemoryOperation) =>
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
const conflict = (n = 1, targetSpace = space) =>
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
const tailEntries = (from: number, to: number): M.MemoryHubEntry[] =>
  Array.from({ length: to - from }, (_, index) => {
    const sequence = from + index + 1;
    const op = operation(sequence + 500, M.MemoryId.make(id(sequence + 500)));
    if (op.kind !== "upsert") throw new Error("fixture");
    const foreign = {
      ...op,
      originEnvironmentId: remote,
      revision: { ...op.revision, provenance: { environmentId: remote } },
    };
    return {
      kind: "operation",
      hubSequence: sequence,
      operation: foreign,
      receipt: {
        operationId: foreign.operationId,
        memoryId: foreign.memoryId,
        operationDigest: memoryOperationDigest(foreign),
        hubSequence: sequence,
        outcome: "accepted",
      },
    };
  });
const enqueue = (
  n: number,
  memory = M.MemoryId.make(id(2)),
  parents: readonly M.MemoryRevisionId[] = [],
) =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    const original = operation(n, memory);
    const op =
      original.kind === "upsert"
        ? { ...original, expectedHeads: parents, revision: { ...original.revision, parents } }
        : original;
    yield* commit(op);
    yield* store.enqueueWork({
      id: `sync:${n}`,
      space,
      memoryId: op.memoryId,
      kind: "sync",
      status: "pending",
      metadata: {
        protocolVersion: 1,
        kind: op.kind,
        operationId: op.operationId,
        memoryId: op.memoryId,
        memorySpaceId: op.memorySpaceId,
        originEnvironmentId: op.originEnvironmentId,
        expectedHeads: op.expectedHeads,
        ...(op.kind === "upsert" ? { revision: op.revision } : {}),
      },
      payloadRef: null,
      attempt: 0,
      nextAttemptAt: 0,
      claimedBy: null,
      claimedUntil: null,
    });
    return op;
  });

it.effect("disabled start and syncOnce perform no transport", () =>
  Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    yield* sync.start;
    yield* sync.syncOnce;
    assert.deepStrictEqual(yield* sync.readLocalReadiness(), {
      memorySpaceId: null,
      bootstrap: "unbound",
    });
  }).pipe(Effect.provide(fixture(Layer.mock(Client.MemoryHubClient)({}), undefined, true))),
);

it.effect.each(["start", "syncOnce"] as const)(
  "%s automatically starts a frozen conflict without waiting for generation",
  (method) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Deferred.succeed(entered, input).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const memory = yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync[method];
          const input = yield* Deferred.await(entered);
          assert.strictEqual(input.memoryId, memory);
          assert.deepStrictEqual(input.modelSelection, selection);
          assert.strictEqual(yield* sync.activeResolutions, 1);
          yield* sync.shutdown;
          assert.strictEqual(yield* sync.activeResolutions, 0);
        }).pipe(Effect.provide(fixture(peer(), model))),
      );
    }),
);

it.effect("claim_busy persists backoff and TestClock releases a due candidate", () =>
  Effect.gen(function* () {
    let claims = 0;
    const entered = yield* Deferred.make<void>();
    const client = peer({
      claim: () =>
        Effect.sync(() => {
          claims++;
        }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "claim_busy" })))),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        const store = yield* Store.MemoryStore;
        yield* sync.syncOnce;
        assert.strictEqual(claims, 1);
        assert.strictEqual((yield* store.readDueClaimCandidates(100, 29999, space)).length, 0);
        yield* sync.syncOnce;
        assert.strictEqual(claims, 1);
        yield* TestClock.adjust("30 seconds");
        yield* sync.syncOnce;
        assert.strictEqual(claims, 2);
        yield* Deferred.succeed(entered, undefined);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect(
  "saved claim survives a lost response and a changed default across coordinator restart",
  () =>
    Effect.gen(function* () {
      const claims: M.MemoryHubClaimInput[] = [];
      const client = peer({
        claim: (_c, claim) =>
          Effect.sync(() => {
            claims.push(claim);
          }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "unavailable" })))),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* sync.shutdown;
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({
            memoryModelSelection: { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" },
          });
          yield* TestClock.adjust("5 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(claims.length, 2);
          assert.deepStrictEqual(claims[1], claims[0]);
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("blocked generation leaves unrelated push and cursor movement free", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    let pushes = 0;
    let phase = 0;
    const client = peer({
      push: (_c, i) =>
        Effect.sync(() => {
          pushes++;
        }).pipe(
          Effect.as({
            receipts: i.operations.map((op) => ({
              operationId: op.operationId,
              memoryId: op.memoryId,
              operationDigest: memoryOperationDigest(op),
              hubSequence: 1,
              outcome: "accepted" as const,
            })),
          }),
        ),
      pull: (_c, i) =>
        Effect.succeed({
          highWatermark: i.highWatermark ?? phase,
          throughSequence: phase,
          hasMore: false,
          entries: tailEntries(i.afterSequence, phase),
        }),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        yield* enqueue(20);
        phase = 7;
        yield* sync.syncOnce;
        assert.strictEqual(pushes, 1);
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* store.readCursor(space, remote), 7);
        assert.strictEqual(yield* sync.activeResolutions, 1);
        yield* sync.shutdown;
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

it.effect("four slots bound five conflicts and the fifth starts after finalization", () =>
  Effect.gen(function* () {
    const allEntered = yield* Deferred.make<void>();
    const finishFirst = yield* Deferred.make<void>();
    const fifthEntered = yield* Deferred.make<void>();
    let calls = 0;
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.gen(function* () {
          calls++;
          if (calls === 4) yield* Deferred.succeed(allEntered, undefined);
          if (calls === 5) yield* Deferred.succeed(fifthEntered, undefined);
          if (calls === 1) {
            yield* Deferred.await(finishFirst);
            return yield* new M.TextGenerationError({
              operation: "resolveMemoryConflict",
              detail: "generation_failed",
            });
          }
          return yield* Effect.never;
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        for (let n = 1; n <= 5; n++) yield* conflict(n);
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(allEntered);
        assert.strictEqual(calls, 4);
        assert.strictEqual(yield* sync.activeResolutions, 4);
        yield* sync.syncOnce;
        assert.strictEqual(calls, 4);
        yield* Deferred.succeed(finishFirst, undefined);
        yield* Deferred.await(fifthEntered);
        assert.strictEqual(calls, 5);
        assert.strictEqual(yield* sync.activeResolutions, 4);
        yield* sync.shutdown;
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect("push failure stores retry and restart sends the identical operation", () =>
  Effect.gen(function* () {
    const sent: M.MemoryOperation[] = [];
    const client = peer({
      push: (_c, i) =>
        Effect.sync(() => {
          sent.push(i.operations[0]!);
        }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "unavailable" })))),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* enqueue(40);
        const sync = yield* Sync.MemorySyncService;
        const store = yield* Store.MemoryStore;
        yield* sync.syncOnce;
        assert.strictEqual(sent.length, 1);
        assert.strictEqual((yield* store.readEligibleOutbox(space, 999, 100)).length, 0);
        yield* sync.shutdown;
        yield* TestClock.adjust("1 second");
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* Sync.MemorySyncService;
            yield* restarted.syncOnce;
          }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
        );
        assert.strictEqual(sent.length, 2);
        assert.deepStrictEqual(sent[1], sent[0]);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("fixed watermark and shared ten-page budget stop a perpetually growing tail", () =>
  Effect.gen(function* () {
    const requests: M.MemoryHubPullInput[] = [];
    const client = peer({
      pull: (_c, i) =>
        Effect.sync(() => {
          requests.push(i);
          return {
            highWatermark: i.highWatermark ?? 10000,
            throughSequence: i.afterSequence + 1,
            hasMore: true,
            entries: tailEntries(i.afterSequence, i.afterSequence + 1),
          };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual(requests.length, 10);
        assert.deepStrictEqual(
          requests.slice(1).map((r) => r.highWatermark),
          Array(9).fill(10000),
        );
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* store.readCursor(space, remote), 10);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("epoch changes discard a delayed pull before cursor commit", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const resume = yield* Deferred.make<void>();
    const client = peer({
      pull: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(resume)),
          Effect.as({ highWatermark: 7, throughSequence: 7, hasMore: false, entries: [] }),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const sync = yield* Sync.MemorySyncService;
        const pending = yield* Effect.result(sync.syncOnce).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        const transitions = Option.getOrThrow(
          yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
        );
        yield* transitions.applyMemoryHubTransition(
          {
            requestId: M.MemoryOperationId.make(id(999)),
            expectedVersion: 1,
            settings: { mode: "disabled" },
          },
          Effect.void,
        );
        yield* Deferred.succeed(resume, undefined);
        assert.strictEqual((yield* Fiber.join(pending))._tag, "Failure");
        const store = yield* Store.MemoryStore;
        assert.strictEqual(yield* store.readCursor(space, remote), 0);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("real HubClient transmits bounded immutable work and settles ACK", () =>
  Effect.gen(function* () {
    const sent: M.MemoryHubPushInput[] = [];

    const fetch: typeof globalThis.fetch = async (url, init) => {
      const path = new URL(String(url)).pathname;
      let response: unknown;
      if (init?.method === "GET")
        response = {
          environmentId: remote,
          label: "fixture",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "1",
          capabilities: { memoryHubProtocolVersion: 1 },
        };
      else if (path.endsWith("/push")) {
        const input = pushDecode(
          init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : init?.body,
        );
        sent.push(input);
        response = {
          receipts: input.operations.map((o) => ({
            operationId: o.operationId,
            memoryId: o.memoryId,
            operationDigest: memoryOperationDigest(o),
            hubSequence: 1,
            outcome: "accepted",
          })),
        };
      } else if (path.endsWith("/collect")) response = { requests: [] };
      else response = { highWatermark: 0, throughSequence: 0, hasMore: false, entries: [] };
      return new Response(encode(response), { headers: { "content-type": "application/json" } });
    };
    const actualClient = Client.layer.pipe(
      Layer.provide(
        Layer.mock(Secrets.ServerSecretStore)({
          get: () => Effect.succeed(Option.some(new TextEncoder().encode("c".repeat(43)))),
        }),
      ),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const op = yield* enqueue(50);
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual(sent.length, 1);
        assert.deepStrictEqual(sent[0]?.operations, [op]);
        const store = yield* Store.MemoryStore;
        assert.strictEqual((yield* store.readWork("sync:50"))?.status, "completed");
      }).pipe(
        Effect.provide(fixture(actualClient)),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      ),
    );
  }),
);

it.effect.each(["unavailable", "unauthorized"] as const)(
  "%s resolution submission persists bytes and restart replays without a second generation",
  (refusal) =>
    Effect.gen(function* () {
      const submitted = yield* Deferred.make<void>();
      const replayed = yield* Deferred.make<void>();
      const submissions: M.MemoryHubApplyResolutionInput[] = [];
      let generated = 0;
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            submissions.push(input);
            yield* Deferred.succeed(submitted, undefined);
            if (submissions.length === 2) yield* Deferred.succeed(replayed, undefined);
            return yield* refusal === "unauthorized"
              ? new M.MemoryHubUnauthorizedError({})
              : new M.MemoryHubError({ code: "unavailable" });
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.sync(() => {
            generated++;
            return {
              result: {
                text: "synthetic resolved fact",
                assertionKind: "inference" as const,
                evidence: [],
                judgment: "combine synthetic facts",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* Deferred.await(submitted);
          // shutdown waits for registered execution and its durable finalization.
          yield* sync.shutdown;
          const store = yield* Store.MemoryStore;
          const tickets = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          });
          assert.strictEqual(tickets.length, 1);
          assert.deepStrictEqual(tickets[0]?.submission, submissions[0]);
          assert.strictEqual(tickets[0]?.state, "submitting");
          yield* TestClock.adjust("30 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              // provider is never called for the durable submission on recovery.
              yield* Deferred.await(replayed);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(generated, 1);
          assert.strictEqual(submissions.length, 2);
          assert.deepStrictEqual(submissions[1], submissions[0]);
          assert.strictEqual((yield* store.pendingReports(100)).length, 0);
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect(
  "actual Worker joint start never claims resolve work while registry owns generation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let resolveClaims = 0;
      let generated = 0;
      const model = realGeneration({
        resolveMemoryConflict: () =>
          Effect.sync(() => {
            generated++;
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
          ),
      });
      const observedStorage = Layer.effect(
        Store.MemoryStore,
        Effect.map(Store.MemoryStore, (store) =>
          Store.MemoryStore.of({
            ...store,
            claimWork: (id, owner, now, until) => {
              if (id.startsWith("resolve:")) resolveClaims++;
              return store.claimWork(id, owner, now, until);
            },
          }),
        ),
      );
      const joint = Worker.layer.pipe(
        Layer.provideMerge(Maintenance.layer.pipe(Layer.provideMerge(core))),
        Layer.provideMerge(observedStorage.pipe(Layer.provideMerge(fixture(peer(), model)))),
        Layer.provide(NodeServices.layer),
        Layer.provide(
          Layer.succeed(RuntimeIdentity.RuntimeIdentity, { instanceId: "synthetic-worker" }),
        ),
        Layer.provide(Layer.mock(Events.EventSinkV2)({ stream: () => Stream.empty })),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const worker = yield* Worker.MemoryWorker;
          yield* sync.start;
          yield* Deferred.await(entered);
          yield* worker.start();
          yield* worker.drain;
          const store = yield* Store.MemoryStore;
          assert.isFalse(
            (yield* store.dueWork(yield* Clock.currentTimeMillis, 100)).some(
              (work) => work.kind === "resolve",
            ),
          );
          assert.strictEqual(resolveClaims, 0);
          assert.strictEqual(generated, 1);
          yield* sync.shutdown;
        }).pipe(Effect.provide(joint)),
      );
    }),
);

const checkpointPeer = (overrides: Partial<Client.MemoryHubClient["Service"]> = {}) =>
  peer({
    join: () =>
      Effect.succeed({
        protocolVersion: 1,
        memorySpaceId: space,
        hubEnvironmentId: remote,
        checkpointSequence: 0,
        retentionFloor: 0,
        snapshotToken: "fixture-token",
        causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
      }),
    pull: (_c, input) =>
      Effect.succeed(
        input.snapshotToken
          ? {
              highWatermark: 0,
              throughSequence: 0,
              hasMore: false,
              entries: [],
              checkpoint: {
                memorySpaceId: space,
                checkpointSequence: 0,
                retentionFloor: 0,
                causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
                pageOrdinal: 0,
                items: [],
                revisions: [],
                tombstones: [],
                conflicts: [],
                resolutions: [],
                compactReceipts: [],
                identities: [],
                fences: [],
                suppressions: [],
                importLineage: [],
                nextCursor: null,
                bootstrapComplete: true,
              },
            }
          : { highWatermark: 0, throughSequence: 0, hasMore: false, entries: [] },
      ),
    ...overrides,
  });

it.effect("member checkpoint completes before pushing and supplies local replica identity", () =>
  Effect.gen(function* () {
    let pushed = 0;
    const client = checkpointPeer({
      push: () =>
        Effect.sync(() => {
          pushed++;
          return { receipts: [] };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sync = yield* Sync.MemorySyncService;
        assert.deepStrictEqual(yield* sync.readLocalReadiness(), {
          memorySpaceId: space,
          bootstrap: "unbound",
        });
        yield* sync.syncOnce;
        assert.deepStrictEqual(yield* sync.readLocalReadiness(), {
          memorySpaceId: space,
          bootstrap: "ready",
        });
        assert.strictEqual(pushed, 0);
        yield* sync.requireBootstrap(space);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("partial member checkpoint preserves token and keeps push blocked across restart", () =>
  Effect.gen(function* () {
    const requests: M.MemoryHubPullInput[] = [];
    let joins = 0;
    const client = peer({
      join: () =>
        Effect.sync(() => {
          joins++;
          return {
            protocolVersion: 1 as const,
            memorySpaceId: space,
            hubEnvironmentId: remote,
            checkpointSequence: 0,
            retentionFloor: 0,
            snapshotToken: "fixture-partial-token",
            causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
          };
        }),
      pull: (_c, input) =>
        Effect.sync(() => {
          requests.push(input);
          const ordinal = input.cursor ? Number(input.cursor) : 0;
          return {
            highWatermark: 0,
            throughSequence: 0,
            hasMore: true,
            entries: [],
            checkpoint: {
              memorySpaceId: space,
              checkpointSequence: 0,
              retentionFloor: 0,
              causalBoundary: { checkpointSequence: 0, boundaryId: "fixture-boundary" },
              pageOrdinal: ordinal,
              items: [],
              revisions: [],
              tombstones: [],
              conflicts: [],
              resolutions: [],
              compactReceipts: [],
              identities: [
                {
                  memorySpaceId: space,
                  memoryId: M.MemoryId.make(id(ordinal + 800)),
                  scope: { kind: "user" as const },
                  creatingEnvironmentId: remote,
                  createOperationId: M.MemoryOperationId.make(id(ordinal + 900)),
                  createdAtUtc: timestamp,
                },
              ],
              fences: [],
              suppressions: [],
              importLineage: [],
              nextCursor: String(ordinal + 1),
              bootstrapComplete: false,
            },
          };
        }),
      push: () => Effect.die("partial bootstrap must never push"),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual(requests.length, 10);
        assert.strictEqual((yield* sync.readLocalReadiness()).bootstrap, "staging");
        yield* sync.shutdown;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* Sync.MemorySyncService;
            yield* restarted.syncOnce;
          }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
        );
        assert.strictEqual(joins, 1);
        assert.strictEqual(requests.length, 20);
        assert.strictEqual(requests[10]?.cursor, "10");
        assert.isTrue(requests.every((r) => r.snapshotToken === "fixture-partial-token"));
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect.each(["permit", "reader", "recheck"] as const)(
  "owner %s denial completes the relay while other responses and push move",
  (boundary) =>
    Effect.gen(function* () {
      const requested = (n: number): M.MemorySourceReadRequest => ({
        requestId: M.MemorySourceReadRequestId.make(id(n)),
        memorySpaceId: space,
        memoryId: M.MemoryId.make(id(2)),
        requesterEnvironmentId: remote,
        sourceThread: { environmentId: local, threadId: M.ThreadId.make("synthetic-thread") },
        sourceWatermark: {
          fromEventId: M.EventId.make("e1"),
          toEventId: M.EventId.make("e2"),
          throughSequence: 2,
        },
        messageIds: [M.MessageId.make("synthetic-message")],
        limit: 10,
        authorizedScopes: ["memory:read", "orchestration:read"],
        expiresAtHubTime: "1970-01-01T00:01:15.000Z",
      });
      const responses: M.MemoryHubSourceReadNormalRespondInput[] = [];
      let pushes = 0;
      let permits = 0;
      let reads = 0;
      const client = peer({
        collectSourceReads: () => Effect.succeed({ requests: [requested(801), requested(802)] }),
        respondSourceRead: (_c, input) =>
          Effect.sync(() => {
            if (input.kind !== "normal") throw new Error("Expected normal response");
            responses.push(input);
            return { kind: "normal" as const, accepted: true };
          }),
        push: (_c, input) =>
          Effect.sync(() => {
            pushes++;
            return {
              receipts: input.operations.map((op) => ({
                operationId: op.operationId,
                memoryId: op.memoryId,
                operationDigest: memoryOperationDigest(op),
                hubSequence: 1,
                outcome: "accepted" as const,
              })),
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* enqueue(60);
          const base = yield* Sync.MemorySyncRuntime;
          const owner = Sync.MemorySyncRuntime.of({
            ...base,
            ownerPermit: (request) =>
              Effect.suspend(() => {
                if (request.requestId !== id(801)) return Effect.void;
                permits++;
                return boundary === "permit" || (boundary === "recheck" && permits === 2)
                  ? Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" }))
                  : Effect.void;
              }),
            ownerReader: {
              readCommitted: (request) =>
                Effect.suspend(() => {
                  reads++;
                  return request.requestId === id(801) && boundary === "reader"
                    ? Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" }))
                    : Effect.succeed({ kind: "unavailable", code: "source_unavailable" } as const);
                }),
            },
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              yield* sync.syncOnce;
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, owner)),
                ),
              ),
            ),
          );
          assert.strictEqual(pushes, 1);
          assert.deepStrictEqual(
            responses.map((r) => r.requestId),
            [id(801), id(802)],
          );
          assert.deepStrictEqual(responses[0]?.outcome, {
            kind: "denied",
            requiredPermission: "orchestration:read",
          });
          assert.deepStrictEqual(responses[1]?.outcome, {
            kind: "unavailable",
            code: "source_unavailable",
          });
          assert.strictEqual(reads, boundary === "permit" ? 1 : 2);
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect(
  "known approval survives a real canonical SQL failure and repairs without generation",
  () =>
    Effect.gen(function* () {
      const firstReleased = yield* Deferred.make<void>();
      const secondReleased = yield* Deferred.make<void>();
      let releases = 0;
      let generated = 0;
      let applied = 0;
      let submission: M.MemoryHubApplyResolutionInput | undefined;
      let database: SqlClient.SqlClient | undefined;
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            applied++;
            submission = input;
            if (!database) return yield* new M.MemoryHubError({ code: "storage_failed" });
            yield* database`CREATE TRIGGER fixture_canonical_failure BEFORE INSERT ON memory_revisions BEGIN SELECT RAISE(ABORT, 'fixture canonical unavailable'); END`.pipe(
              Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
            );
            if (input.operation.kind !== "resolve") throw new Error("fixture");
            return {
              operationId: input.operation.operationId,
              memoryId: input.operation.memoryId,
              operationDigest: memoryOperationDigest(input.operation),
              hubSequence: 1,
              outcome: "accepted" as const,
              resolutionApproval: {
                resolutionId: input.operation.resolution.resolutionId,
                appliedAtUtc: timestamp,
                revertDeadlineUtc: "1970-01-31T00:00:00.000Z",
              },
            };
          }),
        release: () =>
          Effect.gen(function* () {
            releases++;
            yield* Deferred.succeed(releases === 1 ? firstReleased : secondReleased, undefined);
            return { released: true };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.sync(() => {
            generated++;
            return {
              result: {
                text: "synthetic approved fact",
                assertionKind: "inference" as const,
                evidence: [],
                judgment: "synthetic judgment",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          database = yield* SqlClient.SqlClient;
          const memory = yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* Deferred.await(firstReleased);
          yield* sync.shutdown;
          const store = yield* Store.MemoryStore;
          const saved = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          });
          assert.strictEqual(saved[0]?.approval?.outcome, "accepted");
          assert.strictEqual((yield* store.loadAggregate(space, memory)).heads.length, 2);
          const sql = yield* SqlClient.SqlClient;
          yield* sql`DROP TRIGGER fixture_canonical_failure`;
          yield* TestClock.adjust("30 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              yield* Deferred.await(secondReleased);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(generated, 1);
          assert.strictEqual(applied, 1);
          const repaired = yield* store.loadAggregate(space, memory);
          assert.strictEqual(repaired.heads.length, 1);
          if (submission?.operation.kind !== "resolve") throw new Error("fixture");
          assert.deepStrictEqual(repaired.heads, [submission.operation.revision.revisionId]);
          assert.strictEqual((yield* store.pendingReports(10)).length, 1);
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect("disabling the epoch cancels a registered model immediately", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        const transitions = Option.getOrThrow(
          yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
        );
        yield* transitions.applyMemoryHubTransition(
          {
            requestId: M.MemoryOperationId.make(id(998)),
            expectedVersion: 1,
            settings: { mode: "disabled" },
          },
          Effect.void,
        );
        yield* sync.syncOnce;
        yield* Deferred.await(cancelled);
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect(
  "hub claim success before ticket SQL failure recovers the same lease with a null default",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
      const claims: M.MemoryHubClaimInput[] = [];
      let database: SqlClient.SqlClient | undefined;
      const client = peer({
        claim: (_c, input) =>
          Effect.gen(function* () {
            claims.push(input);
            if (!database) return yield* new M.MemoryHubError({ code: "storage_failed" });
            if (claims.length === 1)
              yield* database`CREATE TRIGGER fixture_ticket_failure BEFORE INSERT ON memory_outbox WHEN NEW.kind='resolve' BEGIN SELECT RAISE(ABORT, 'fixture ticket unavailable'); END`.pipe(
                Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
              );
            const { protocolVersion: _protocolVersion, ...claim } = input;
            return {
              ...claim,
              fencingToken: 41,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Deferred.succeed(entered, input).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          database = yield* SqlClient.SqlClient;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          yield* sync.syncOnce;
          assert.strictEqual(
            (yield* store.readRecoverableResolutionTickets({
              memorySpaceId: space,
              now: 0,
              limit: 100,
            })).length,
            0,
          );
          assert.strictEqual(yield* sync.activeResolutions, 0);
          yield* sync.shutdown;
          yield* database`DROP TRIGGER fixture_ticket_failure`;
          const settings = yield* Settings.ServerSettingsService;
          yield* settings.updateSettings({ memoryModelSelection: null });
          yield* TestClock.adjust("5 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              assert.deepStrictEqual((yield* Deferred.await(entered)).modelSelection, selection);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(claims.length, 2);
          assert.deepStrictEqual(claims[1], claims[0]);
          const tickets = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 35000,
            limit: 100,
          });
          assert.strictEqual(tickets[0]?.ticket.fencingToken, 41);
          assert.strictEqual(tickets[0]?.ticket.attemptId, claims[0]?.attemptId);
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect("expired recovered lease never exposes input to the provider", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let executions = 0;
    let renews = 0;
    const client = peer({
      renew: () =>
        Effect.sync(() => {
          renews++;
        }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "lease_expired" })))),
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: false })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.sync(() => {
          executions++;
        }).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(released);
        yield* sync.shutdown;
        assert.strictEqual(renews, 1);
        assert.strictEqual(executions, 0);
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

const changeHub = (expectedVersion: number, settings: M.MemoryHubSettings) =>
  Effect.gen(function* () {
    const transitions = Option.getOrThrow(
      yield* Effect.serviceOption(Settings.MemoryHubSettingsTransitions),
    );
    yield* transitions.applyMemoryHubTransition(
      {
        requestId: M.MemoryOperationId.make(id(9000 + expectedVersion)),
        expectedVersion,
        settings,
      },
      Effect.void,
    );
  });

it.effect.each(["pull", "owner relay", "claim"] as const)(
  "settings listener interrupts blocked %s and the model before the next epoch cycle",
  (kind) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const modelCancelled = yield* Deferred.make<void>();
      const transportEntered = yield* Deferred.make<void>();
      const transportCancelled = yield* Deferred.make<void>();
      const oldResponse = yield* Deferred.make<void>();
      const newCycle = yield* Deferred.make<number>();
      const finishNew = yield* Deferred.make<void>();
      let phase = 0;
      let calls = 0;
      let sync: Sync.MemorySyncService["Service"] | undefined;
      const block = Deferred.succeed(transportEntered, undefined).pipe(
        Effect.andThen(Deferred.await(oldResponse)),
        Effect.ensuring(Deferred.succeed(transportCancelled, undefined)),
      );
      const empty = (i: M.MemoryHubPullInput): M.MemoryHubPullResult => ({
        highWatermark: i.highWatermark ?? i.afterSequence,
        throughSequence: i.afterSequence,
        hasMore: false,
        entries: [],
      });
      const client = peer({
        pull: (c, i) =>
          Effect.gen(function* () {
            if (c.epoch === 3) {
              yield* Deferred.succeed(newCycle, yield* sync!.activeResolutions);
              yield* Deferred.await(finishNew);
            }
            if (phase === 1 && kind === "pull") {
              yield* block;
              return {
                highWatermark: 1,
                throughSequence: 1,
                hasMore: false,
                entries: tailEntries(0, 1),
              };
            }
            return empty(i);
          }),
        collectSourceReads: () =>
          phase === 1 && kind === "owner relay"
            ? block.pipe(Effect.as({ requests: [] }))
            : Effect.succeed({ requests: [] }),
        claim: (_c, input) =>
          Effect.gen(function* () {
            if (kind === "claim" && input.memoryId === id(4)) {
              phase = 1;
              yield* block;
            }
            const { protocolVersion: _protocol, ...claim } = input;
            return {
              ...claim,
              fencingToken: 1,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: () =>
          Effect.sync(() => {
            calls++;
          }).pipe(
            Effect.andThen(Deferred.succeed(entered, undefined)),
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(modelCancelled, undefined)),
          ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          if (kind === "claim") yield* conflict(2);
          sync = yield* Sync.MemorySyncService;
          if (kind === "claim") yield* sync.start.pipe(Effect.forkScoped);
          else yield* sync.start;
          yield* Deferred.await(entered);
          phase = 1;
          const manual = yield* sync.syncOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(transportEntered);
          // Only the Settings stream triggers cancellation; no direct sync/shutdown call.
          yield* changeHub(1, { mode: "disabled" });
          yield* Deferred.await(transportCancelled);
          yield* Deferred.await(modelCancelled);
          yield* Fiber.join(manual);
          phase = 2;
          yield* changeHub(2, member);
          assert.strictEqual(yield* Deferred.await(newCycle), 0);
          yield* Deferred.succeed(oldResponse, undefined);
          const store = yield* Store.MemoryStore;
          assert.strictEqual(yield* store.readCursor(space, remote), 0);
          assert.strictEqual(calls, 1);
          assert.strictEqual(yield* sync.activeResolutions, 0);
          yield* Deferred.succeed(finishNew, undefined);
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client, model, false, true))),
      );
    }),
);

it.effect("periodic renewal failure preserves the renewed expiry retry floor", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let renews = 0;
    let issued: M.MemoryResolutionLease | undefined;
    const client = peer({
      claim: (_c, { protocolVersion: _p, ...claim }) =>
        Effect.sync(() => {
          issued = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return issued;
        }),
      renew: () =>
        Effect.gen(function* () {
          renews++;
          if (renews === 1) return { ...issued!, expiresAtHubTime: "1970-01-01T00:03:00.000Z" };
          return yield* new M.MemoryHubError({ code: "unavailable" });
        }),
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: false })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(cancelled);
        yield* Deferred.await(released);
        yield* sync.shutdown;
        const tickets = yield* (yield* Store.MemoryStore).readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 180000,
          limit: 100,
        });
        assert.strictEqual(renews, 2);
        assert.strictEqual(tickets[0]?.nextAttemptAt, 180000);
        assert.strictEqual(tickets[0]?.ticket.expiresAtHubTime, "1970-01-01T00:03:00.000Z");
        const reopened = yield* Effect.service(Store.MemoryStore).pipe(Effect.provide(Store.layer));
        const recovered = yield* reopened.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 180000,
          limit: 100,
        });
        assert.strictEqual(recovered[0]?.ticket.expiresAtHubTime, "1970-01-01T00:03:00.000Z");
        assert.strictEqual(
          (yield* reopened.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 179999,
            limit: 100,
          })).length,
          0,
        );
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

const sourceFixture = Effect.gen(function* () {
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

it.effect.each(["owner permit", "owner read"] as const)(
  "requester absolute deadline interrupts %s crossing the persisted 75s expiry",
  (boundary) =>
    Effect.gen(function* () {
      const firstResult = yield* Deferred.make<void>();
      const resumeResult = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const cancelled = yield* Deferred.make<void>();
      let requested: M.MemorySourceReadRequest | undefined;
      let collects = 0;
      let responses = 0;
      const client = peer({
        requestSourceRead: (_c, { protocolVersion: _p, ...input }) =>
          Effect.sync(() => {
            requested = {
              ...input,
              requesterEnvironmentId: local,
              stamp: {
                requesterCredentialVersion: 1,
                locatorDigest: sourceReadLocatorDigest({ protocolVersion: 1, ...input }),
              },
              expiresAtHubTime: "1970-01-01T00:01:15.000Z",
            };
            return { request: requested };
          }),
        collectSourceReads: () =>
          Effect.sync(() => ({ requests: ++collects === 1 ? [] : [requested!] })),
        resultSourceRead: () =>
          Deferred.succeed(firstResult, undefined).pipe(
            Effect.andThen(Deferred.await(resumeResult)),
            Effect.as({ state: "pending", expiresAtHubTime: "1970-01-01T00:01:15.000Z" } as const),
          ),
        respondSourceRead: () =>
          Effect.sync(() => {
            responses++;
            return { kind: "normal" as const, accepted: true };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const validated = yield* sourceFixture;
          const base = yield* Sync.MemorySyncRuntime;
          const blocked = Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(cancelled, undefined)),
          );
          const owner = Sync.MemorySyncRuntime.of({
            ...base,
            ownerPermit: () => (boundary === "owner permit" ? blocked : Effect.void),
            ownerReader: { readCommitted: () => blocked },
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              const read = yield* sync.readSource(validated, Effect.void).pipe(Effect.forkScoped);
              yield* Deferred.await(firstResult);
              yield* TestClock.adjust("70 seconds");
              yield* Deferred.succeed(resumeResult, undefined);
              yield* TestClock.adjust("1 second");
              yield* Deferred.await(entered);
              yield* TestClock.adjust("4 seconds");
              assert.deepStrictEqual(yield* Fiber.join(read), {
                kind: "unavailable",
                code: "source_unavailable",
              });
              yield* Deferred.await(cancelled);
              assert.strictEqual(yield* Clock.currentTimeMillis, 75000);
              assert.strictEqual(responses, 0);
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, owner)),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect.each(["denied", "epoch", "revoked", "result epoch", "result revoked"] as const)(
  "owner refusal has terminal denial only while responder authority remains current: %s",
  (mode) =>
    Effect.gen(function* () {
      let requested: M.MemorySourceReadRequest | undefined;
      let completed: M.MemorySourceReadOutcome | undefined;
      let attempted = 0;
      let pushes = 0;
      const pushedMemories: M.MemoryId[] = [];
      const client = peer({
        requestSourceRead: (_c, { protocolVersion: _p, ...input }) =>
          Effect.sync(() => {
            requested = {
              ...input,
              requesterEnvironmentId: local,
              stamp: {
                requesterCredentialVersion: 1,
                locatorDigest: sourceReadLocatorDigest({ protocolVersion: 1, ...input }),
              },
              expiresAtHubTime: "1970-01-01T00:01:15.000Z",
            };
            return { request: requested };
          }),
        collectSourceReads: () => Effect.succeed({ requests: requested ? [requested] : [] }),
        respondSourceRead: (_c, input) =>
          Effect.suspend(() => {
            attempted++;
            if (mode === "revoked") return Effect.fail(new M.MemoryHubUnauthorizedError({}));
            if (input.kind !== "normal") throw new Error("Expected normal response");
            completed = input.outcome;
            return Effect.succeed({ kind: "normal" as const, accepted: true });
          }),
        resultSourceRead: () =>
          Effect.gen(function* () {
            if (mode === "result epoch")
              yield* changeHub(1, { ...member, secretName: "late-fixture" }).pipe(Effect.orDie);
            if (mode === "result revoked") return yield* new M.MemoryHubUnauthorizedError({});
            return completed
              ? { state: "completed" as const, outcome: completed }
              : { state: "expired" as const, code: "source_unavailable" as const };
          }),
        push: (_c, input) =>
          Effect.sync(() => {
            pushes++;
            pushedMemories.push(...input.operations.map((op) => op.memoryId));
            return {
              receipts: input.operations.map((op) => ({
                operationId: op.operationId,
                memoryId: op.memoryId,
                operationDigest: memoryOperationDigest(op),
                hubSequence: 1,
                outcome: "accepted" as const,
              })),
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const validated = yield* sourceFixture;
          const base = yield* Sync.MemorySyncRuntime;
          const owner = Sync.MemorySyncRuntime.of({
            ...base,
            ownerPermit: () =>
              Effect.gen(function* () {
                if (mode === "epoch")
                  yield* changeHub(1, { ...member, secretName: "next-fixture" }).pipe(Effect.orDie);
                return yield* new Service.MemoryAccessError({ code: "route_unavailable" });
              }),
            ownerReader: { readCommitted: () => Effect.die("denied source must never be read") },
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              const result = yield* Effect.result(sync.readSource(validated, Effect.void));
              if (mode === "epoch" || mode === "result epoch" || mode === "result revoked") {
                assert.strictEqual(result._tag, "Failure");
                if (result._tag === "Failure")
                  assert.deepStrictEqual(
                    result.failure,
                    new Service.MemoryAccessError({
                      code: mode === "result revoked" ? "route_unavailable" : "fenced",
                    }),
                  );
                assert.strictEqual(attempted, mode === "epoch" ? 0 : 1);
              } else {
                assert.strictEqual(result._tag, "Success");
                if (result._tag === "Success")
                  assert.deepStrictEqual(
                    result.success,
                    mode === "denied"
                      ? { kind: "denied", requiredPermission: "orchestration:read" }
                      : { kind: "unavailable", code: "source_unavailable" },
                  );
                assert.strictEqual(attempted, 1);
              }
              assert.strictEqual(
                completed?.kind,
                mode === "epoch" || mode === "revoked" ? undefined : "denied",
              );
              requested = undefined;
              yield* enqueue(806, M.MemoryId.make(id(807)));
              yield* sync.syncOnce;
              assert.strictEqual(pushes, 2);
              assert.deepStrictEqual(pushedMemories.toSorted(), [
                M.MemoryId.make(id(2)),
                M.MemoryId.make(id(807)),
              ]);
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, owner)),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("requester deadline includes the initial requester permit", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    let requests = 0;
    yield* Effect.scoped(
      Effect.gen(function* () {
        const validated = yield* sourceFixture;
        const sync = yield* Sync.MemorySyncService;
        const permit = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        );
        const read = yield* sync.readSource(validated, permit).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("75 seconds");
        assert.deepStrictEqual(yield* Fiber.join(read), {
          kind: "unavailable",
          code: "source_unavailable",
        });
        yield* Deferred.await(cancelled);
        assert.strictEqual(requests, 0);
      }).pipe(
        Effect.provide(
          fixture(
            peer({
              requestSourceRead: () =>
                Effect.sync(() => {
                  requests++;
                }).pipe(Effect.andThen(Effect.never)),
            }),
          ),
        ),
      ),
    );
  }),
);

it.effect("a fenced relay cannot assign an old-space local intent", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      const store = yield* Store.MemoryStore;
      yield* store.putLocalIntent({
        intentId: "epoch-intent",
        memoryId: M.MemoryId.make(id(8800)),
        environmentId: local,
        scope: { kind: "user" },
        provenance: { environmentId: local },
        assertionKind: "inference",
        createdAtUtc: timestamp,
        payload: { text: "synthetic unsent fact", evidence: [], derivedFromMemoryRevisions: [] },
      });
      const sync = yield* Sync.MemorySyncService;
      const result = yield* Effect.result(sync.syncOnce);
      assert.strictEqual(result._tag, "Failure");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{
        mapping: string | null;
      }>`SELECT json_extract(metadata_json,'$.mapping') AS mapping FROM memory_outbox WHERE id=${`local:${local}:epoch-intent`}`;
      assert.strictEqual(rows[0]?.mapping, null);
      assert.strictEqual(yield* store.readCursor(space, remote), 0);
    }).pipe(
      Effect.provide(
        fixture(
          peer({
            collectSourceReads: () =>
              changeHub(1, { mode: "disabled" }).pipe(
                Effect.mapError(() => new M.MemoryHubError({ code: "fenced" })),
                Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "fenced" }))),
              ),
          }),
        ),
      ),
    ),
  ),
);

it.effect("recovered attempt uses only the remaining fixed 600s cap", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const cancelled = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    let ticket: M.MemoryResolutionLease | undefined;
    const client = peer({
      claim: (_c, { protocolVersion: _p, ...claim }) =>
        Effect.sync(() => {
          ticket = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:10:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return ticket;
        }),
      renew: () => Effect.succeed(ticket!),
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(cancelled, undefined)),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        yield* TestClock.adjust("550 seconds");
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(entered);
        yield* TestClock.adjust("49 seconds");
        assert.isTrue(Option.isNone(yield* Deferred.poll(cancelled)));
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(cancelled);
        yield* Deferred.await(released);
        assert.strictEqual(yield* Clock.currentTimeMillis, 600000);
        const reports = yield* (yield* Store.MemoryStore).pendingReports(100);
        assert.strictEqual(reports.length, 1);
        assert.strictEqual(reports[0]?.outcome, "failed");
        assert.strictEqual(reports[0]?.failureCode, "lease_expired");
        yield* sync.shutdown;
        assert.strictEqual(yield* sync.activeResolutions, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

// Empty fixture snapshot is explicit. Production counter-backed reads belong to L1/L5.
const emptyProcessing: M.MemoryProcessingStatus = {
  lastReceivedHubSequence: 0,
  receiveLag: null,
  deferred: 0,
  oldestDeferredAtUtc: null,
  unindexedItems: 0,
  scannerHeldItems: 0,
  scannerPendingItems: 0,
  missingParentItems: 0,
  pendingCleanupItems: 0,
  reportBacklog: 0,
  reportFailed: 0,
  hubAdmissionFailures: 0,
  indexCoverage: {
    status: "available",
    eligibleItems: 0,
    indexedItems: 0,
    unindexedItems: 0,
    projectionWatermark: 0,
  },
};
const statusRuntime = Effect.gen(function* () {
  const base = yield* Sync.MemorySyncRuntime;
  const quota = yield* Quota.MemoryQuotaService;
  return Sync.MemorySyncRuntime.of({
    ...base,
    readProcessing: () =>
      Effect.succeed({ processing: emptyProcessing, pendingSync: 0, quarantined: 0, parked: 0 }),
    readUnboundStorage: quota.readStorageStatus({ memorySpaceId: space, environmentId: local }),
  });
});

it.effect.each([
  "single",
  "multiple",
  "no-sync-time",
  "empty-newer-sync",
  "memory-activity",
  "tied-memory-activity",
] as const)(
  "081 upgrade recovers a retained ready space with sharing already disabled: %s",
  (candidates) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "memory-081-upgrade-" });
        const filename = `${directory}/state.sqlite`;
        const database = (through: number) =>
          Quota.layer.pipe(
            Layer.provideMerge(
              Store.layer.pipe(
                Layer.provideMerge(
                  Layer.effectDiscard(
                    runMigrations({ toMigrationInclusive: through }).pipe(
                      // The current store reads cached revision sizes on any schema.
                      Effect.andThen(revisionSizeMigration),
                      Effect.orDie,
                    ),
                  ).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename }))),
                ),
              ),
            ),
          );
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const settings = yield* Settings.ServerSettingsService;
            assert.deepStrictEqual((yield* settings.getSettings).memoryHub, { mode: "disabled" });
            yield* ready;
            yield* commit(operation(98010));
            if (candidates !== "single") {
              // Later empty cursors must not hide a space with retained memories.
              yield* sql`UPDATE memory_sync_cursors SET last_success_at=200 WHERE space=${space}`;
              yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state,last_success_at) VALUES (${id(999)},${remote},0,'ready',100),(${id(998)},${remote},0,'staging',300)`;
              if (candidates === "empty-newer-sync")
                yield* sql`UPDATE memory_sync_cursors SET last_success_at=300 WHERE space=${id(999)}`;
              if (
                candidates === "multiple" ||
                candidates === "memory-activity" ||
                candidates === "tied-memory-activity"
              ) {
                const other = operation(98011);
                if (other.kind !== "upsert") throw new Error("fixture");
                const otherSpace = M.MemorySpaceId.make(id(999));
                yield* commit({
                  ...other,
                  memorySpaceId: otherSpace,
                  revision: { ...other.revision, memorySpaceId: otherSpace },
                });
              }
              if (candidates === "memory-activity")
                yield* sql`UPDATE memory_revisions SET created_at=300 WHERE space=${space}`;
              if (
                candidates === "no-sync-time" ||
                candidates === "memory-activity" ||
                candidates === "tied-memory-activity"
              )
                yield* sql`UPDATE memory_sync_cursors SET last_success_at=NULL`;
            }
            assert.isEmpty(
              yield* sql`SELECT name FROM sqlite_master WHERE name='memory_last_ready_space'`,
            );
            assert.deepStrictEqual(yield* runMigrations(), [
              [86, "MemoryLastReadySpace"],
              [87, "MemoryHubAdministered"],
              [88, "MemoryCheckpointLifecycle"],
              [89, "FleetGoals"],
              [90, "FleetHealth"],
              [91, "ThreadRunObservedChecks"],
              [92, "RemoteDispatchObservation"],
              [93, "MemoryRevisionCheckpointSize"],
              [94, "HubNodes"],
              [95, "MemorySummaryWorkThreadIndex"],
              [96, "ThreadHistoryArchives"],
              [97, "PermissionProfiles"],
              [98, "DecisionInbox"],
            ]);
            const adapter = yield* statusRuntime;
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const sync = yield* Sync.MemorySyncService;
                return yield* sync.syncStatus({ includeRetainedLocalSpaceId: true }, Effect.void);
              }).pipe(
                Effect.provide(
                  Layer.fresh(Sync.layer).pipe(
                    Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
                  ),
                ),
              ),
            );
            assert.strictEqual(result.state, "disabled");
            assert.strictEqual(result.retainedLocalSpaceId, space);
          }).pipe(Effect.provide(fixture(peer(), undefined, true, false, local, database(85)))),
        );
        // Close the SQLite connection and rebuild the service, preserving only the upgraded file.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(yield* runMigrations(), []);
            const expected = space;
            assert.deepStrictEqual(yield* sql`SELECT space FROM memory_last_ready_space`, [
              { space: expected },
            ]);
            // Recovery must be one-time: later legacy sync evidence cannot change the saved destination.
            yield* sql`UPDATE memory_sync_cursors SET last_success_at=999 WHERE space!=${expected}`;
            const adapter = yield* statusRuntime;
            const result = yield* Effect.scoped(
              Effect.gen(function* () {
                const sync = yield* Sync.MemorySyncService;
                return yield* sync.syncStatus({ includeRetainedLocalSpaceId: true }, Effect.void);
              }).pipe(
                Effect.provide(
                  Layer.fresh(Sync.layer).pipe(
                    Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
                  ),
                ),
              ),
            );
            assert.strictEqual(result.retainedLocalSpaceId, expected);
            const service = yield* Service.MemoryService;
            const listed = yield* service.list(
              {
                memorySpaceId: result.retainedLocalSpaceId!,
                scope: { kind: "user" },
                limit: 20,
                includeQuarantined: false,
              },
              Effect.void,
            );
            assert.lengthOf(listed.items, 1);
            const item = listed.items[0];
            if (item?.status !== "active") throw new Error("retained memory missing");
            assert.strictEqual(item.payload.text, "synthetic fact 98010");
          }).pipe(Effect.provide(fixture(peer(), undefined, true, false, local, database(86)))),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.effect.each(["unbound", "staging"] as const)(
  "repeated retained status reads without ready candidates do not transact: %s",
  (bootstrap) =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (bootstrap === "staging")
          yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},${remote},0,'staging')`;
        const store = yield* Store.MemoryStore;
        const adapter = yield* statusRuntime;
        let transactions = 0;
        const observed = Store.MemoryStore.of({
          ...store,
          transact: (effect, options) =>
            Effect.suspend(() => {
              transactions++;
              return store.transact(effect, options);
            }),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            for (let i = 0; i < 3; i++) {
              const result = yield* sync.syncStatus(
                { includeRetainedLocalSpaceId: true },
                Effect.void,
              );
              assert.strictEqual(result.retainedLocalSpaceId, null);
            }
            assert.strictEqual(transactions, 0);
            // A later ready candidate must still be recoverable after the read-only misses.
            yield* sql`DELETE FROM memory_sync_cursors`;
            yield* ready;
            const recovered = yield* sync.syncStatus(
              { includeRetainedLocalSpaceId: true },
              Effect.void,
            );
            assert.strictEqual(recovered.retainedLocalSpaceId, space);
            assert.strictEqual(transactions, 1);
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Store.MemoryStore, observed)),
                Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture(peer(), undefined, true))),
    ),
);

it.effect(
  "checkpoint completion retains its space atomically before immediate disable and restart",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* Store.MemoryStore;
        const adapter = yield* statusRuntime;
        const previous = id(999);
        yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${previous})`;
        let disabled = false;
        const boundary = Store.MemoryStore.of({
          ...store,
          transact: (effect, options) =>
            store.transact(effect, options).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (disabled) return;
                  const state = yield* store.readBootstrap({
                    memorySpaceId: space,
                    hubEnvironmentId: remote,
                  });
                  if (state.state !== "ready") return;
                  disabled = true;
                  // First instruction after the completion transaction commits; no status read.
                  yield* changeHub(1, { mode: "disabled" }).pipe(Effect.orDie);
                }),
              ),
            ),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.syncOnce.pipe(Effect.ignore);
            assert.isTrue(disabled);
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Store.MemoryStore, boundary)),
              ),
            ),
          ),
        );
        assert.deepStrictEqual(yield* sql`SELECT space FROM memory_last_ready_space`, [{ space }]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            const result = yield* sync.syncStatus(
              { includeRetainedLocalSpaceId: true },
              Effect.void,
            );
            assert.strictEqual(result.state, "disabled");
            assert.strictEqual(result.retainedLocalSpaceId, space);
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture(checkpointPeer()))),
    ),
);

it.effect(
  "failed retained-space write rolls checkpoint readiness back with its browsing destination",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const sync = yield* Sync.MemorySyncService;
        const store = yield* Store.MemoryStore;
        const previous = id(999);
        yield* sql`INSERT INTO memory_last_ready_space(singleton,space) VALUES (1,${previous})`;
        yield* sql`CREATE TEMP TRIGGER reject_retained_space BEFORE UPDATE ON memory_last_ready_space BEGIN SELECT RAISE(ABORT,'synthetic retained-space failure'); END`;
        yield* sync.syncOnce.pipe(Effect.ignore);
        assert.strictEqual(
          (yield* store.readBootstrap({ memorySpaceId: space, hubEnvironmentId: remote })).state,
          "staging",
        );
        assert.deepStrictEqual(yield* sql`SELECT space FROM memory_last_ready_space`, [
          { space: previous },
        ]);
        assert.isEmpty(yield* sql`SELECT space FROM memory_compaction_state WHERE published=1`);
        yield* sql`DROP TRIGGER reject_retained_space`;
        yield* TestClock.adjust(1000);
        yield* sync.syncOnce;
        assert.strictEqual(
          (yield* store.readBootstrap({ memorySpaceId: space, hubEnvironmentId: remote })).state,
          "ready",
        );
        assert.deepStrictEqual(yield* sql`SELECT space FROM memory_last_ready_space`, [{ space }]);
      }).pipe(Effect.provide(fixture(checkpointPeer()))),
    ),
);

it.effect("status selects disabled and bootstrapping without requiring a bound route", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const adapter = yield* statusRuntime;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          const status = () =>
            sync
              .syncStatus({ includeRetainedLocalSpaceId: true }, Effect.void)
              .pipe(Effect.tap((s) => decodeStatus(s)));
          assert.strictEqual((yield* status()).state, "disabled");
          assert.isNull((yield* status()).retainedLocalSpaceId);
          assert.strictEqual((yield* sync.hubDiagnostics({}, Effect.void)).readiness, "disabled");
          yield* changeHub(1, { ...member, memorySpaceId: null });
          const unbound = yield* status();
          assert.strictEqual(unbound.state, "bootstrapping");
          assert.strictEqual(unbound.memorySpaceId, null);
          assert.strictEqual((yield* sync.hubDiagnostics({}, Effect.void)).readiness, "unbound");
          yield* changeHub(2, member);
          assert.strictEqual((yield* status()).state, "bootstrapping");
          yield* ready;
          yield* sync.syncOnce;
          assert.strictEqual((yield* status()).state, "online");
          assert.strictEqual((yield* status()).lastSuccessfulSyncAtUtc, timestamp);
          const latestSpace = M.MemorySpaceId.make(id(999));
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${latestSpace},${remote},0,'ready')`;
          yield* changeHub(3, { ...member, memorySpaceId: latestSpace });
          assert.strictEqual((yield* status()).retainedLocalSpaceId, latestSpace);
          yield* changeHub(4, { mode: "disabled" });
          const disabled = yield* status();
          assert.strictEqual(disabled.state, "disabled");
          assert.isNull(disabled.memorySpaceId);
          assert.strictEqual(disabled.retainedLocalSpaceId, latestSpace);
          const restarted = yield* Effect.scoped(
            Effect.gen(function* () {
              const fresh = yield* Sync.MemorySyncService;
              return yield* fresh.syncStatus({ includeRetainedLocalSpaceId: true }, Effect.void);
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
                ),
              ),
            ),
          );
          assert.strictEqual(restarted.state, "disabled");
          assert.strictEqual(restarted.retainedLocalSpaceId, latestSpace);
          assert.strictEqual(disabled.lastSuccessfulSyncAtUtc, null);
          assert.strictEqual(disabled.failureCode, undefined);
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(fixture(peer(), undefined, true))),
  ),
);

it.effect(
  "late old-epoch failure cannot contaminate new status and a status read is epoch fenced",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const statusEntered = yield* Deferred.make<void>();
      const statusResume = yield* Deferred.make<void>();
      let blockStatus = false;
      let failPull = false;
      const client = peer({
        pull: (_c, i) =>
          failPull
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(resume)),
                Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "unavailable" }))),
              )
            : Effect.succeed({
                highWatermark: i.afterSequence,
                throughSequence: i.afterSequence,
                hasMore: false,
                entries: [],
              }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const base = yield* statusRuntime;
          const adapter = Sync.MemorySyncRuntime.of({
            ...base,
            readProcessing: (s, h) =>
              blockStatus
                ? Deferred.succeed(statusEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(statusResume)),
                    Effect.andThen(base.readProcessing(s, h)),
                  )
                : base.readProcessing(s, h),
          });
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              yield* sync.syncOnce;
              failPull = true;
              const old = yield* Effect.result(sync.syncOnce).pipe(Effect.forkScoped);
              yield* Deferred.await(entered);
              yield* changeHub(1, { mode: "disabled" });
              yield* Deferred.succeed(resume, undefined);
              assert.strictEqual((yield* Fiber.join(old))._tag, "Failure");
              const fresh = yield* sync.syncStatus({}, Effect.void);
              assert.strictEqual(fresh.state, "disabled");
              assert.strictEqual(fresh.failureCode, undefined);
              assert.strictEqual(fresh.lastSuccessfulSyncAtUtc, null);
              blockStatus = true;
              const stale = yield* Effect.result(sync.syncStatus({}, Effect.void)).pipe(
                Effect.forkScoped,
              );
              yield* Deferred.await(statusEntered);
              yield* changeHub(2, member);
              yield* Deferred.succeed(statusResume, undefined);
              const result = yield* Fiber.join(stale);
              assert.strictEqual(result._tag, "Failure");
              if (result._tag === "Failure")
                assert.deepStrictEqual(result.failure, new M.MemoryHubError({ code: "fenced" }));
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("settings cancels local-hub pull without an HTTP timeout", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const next = yield* Deferred.make<void>();
    yield* Effect.scoped(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${local},${"a".repeat(64)},1,'active')`;
        yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},${local},0,'ready')`;
        yield* changeHub(1, { mode: "hub", memorySpaceId: space });
        const actual = yield* Hub.MemoryHubService;
        const localHub = Hub.MemoryHubService.of({
          ...actual,
          pull: () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(Deferred.succeed(interrupted, undefined)),
            ),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            const start = yield* sync.start.pipe(Effect.forkScoped);
            yield* Deferred.await(entered);
            yield* changeHub(2, { mode: "disabled" });
            yield* Deferred.await(interrupted);
            yield* Fiber.join(start);
            assert.strictEqual(yield* sync.activeResolutions, 0);
            assert.strictEqual(yield* (yield* Store.MemoryStore).readCursor(space, local), 0);
            yield* ready;
            yield* changeHub(3, member);
            yield* Deferred.await(next);
            yield* sync.shutdown;
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Hub.MemoryHubService, localHub)),
              ),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          fixture(
            peer({
              pull: (_c, i) =>
                Deferred.succeed(next, undefined).pipe(
                  Effect.as({
                    highWatermark: i.afterSequence,
                    throughSequence: i.afterSequence,
                    hasMore: false,
                    entries: [],
                  }),
                ),
            }),
            undefined,
            false,
            true,
          ),
        ),
      ),
    );
  }),
);

it.effect("settings finalization bounds a blocked matching release before freeing the slot", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const releaseEntered = yield* Deferred.make<void>();
    const releaseInterrupted = yield* Deferred.make<void>();
    const next = yield* Deferred.make<number>();
    let sync: Sync.MemorySyncService["Service"] | undefined;
    const client = peer({
      release: () =>
        Deferred.succeed(releaseEntered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(releaseInterrupted, undefined)),
        ),
      pull: (c, i) =>
        Effect.gen(function* () {
          if (c.epoch === 3) yield* Deferred.succeed(next, yield* sync!.activeResolutions);
          return {
            highWatermark: i.afterSequence,
            throughSequence: i.afterSequence,
            hasMore: false,
            entries: [],
          };
        }),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        sync = yield* Sync.MemorySyncService;
        yield* sync.start;
        yield* Deferred.await(entered);
        yield* changeHub(1, { mode: "disabled" });
        yield* Deferred.await(releaseEntered);
        assert.strictEqual(yield* sync.activeResolutions, 1);
        yield* TestClock.adjust("15 seconds");
        yield* Deferred.await(releaseInterrupted);
        yield* changeHub(2, member);
        assert.strictEqual(yield* Deferred.await(next), 0);
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client, model, false, true))),
    );
  }),
);

it.effect("current space enters generation behind 100 old-space candidates and tickets", () =>
  Effect.gen(function* () {
    const oldSpace = M.MemorySpaceId.make(id(9900));
    const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
    const model = realGeneration({
      resolveMemoryConflict: (i) => Deferred.succeed(entered, i).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const store = yield* Store.MemoryStore;
        for (let n = 1; n <= 100; n++) {
          const memoryId = yield* conflict(n, oldSpace);
          const snapshot = yield* store.readResolutionSnapshot(oldSpace, memoryId);
          yield* store.persistResolutionTicket({
            memorySpaceId: oldSpace,
            memoryId,
            conflictId: M.MemoryConflictId.make(id(10000 + n)),
            holderEnvironmentId: local,
            attemptId: M.MemoryOperationId.make(id(11000 + n)),
            conflictHeadSet: snapshot.heads,
            frozenDefaultModelSelection: selection,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          });
        }
        yield* store.recoverClaimCandidates(0);
        const memory = yield* conflict(101);
        yield* store.recoverClaimCandidates(0);
        assert.strictEqual((yield* store.readDueClaimCandidates(100, 0, oldSpace)).length, 100);
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        assert.strictEqual((yield* Deferred.await(entered)).memoryId, memory);
        assert.strictEqual(
          (yield* store.readRecoverableResolutionTickets({
            memorySpaceId: oldSpace,
            now: 0,
            limit: 100,
          })).length,
          100,
        );
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect("recovery discovers a new conflict while an unrelated ticket is running", () =>
  Effect.gen(function* () {
    const first = yield* Deferred.make<void>();
    const second = yield* Deferred.make<void>();
    let executions = 0;
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.gen(function* () {
          executions++;
          yield* Deferred.succeed(executions === 1 ? first : second, undefined);
          return yield* Effect.never;
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(first);
        yield* conflict(2);
        yield* sync.syncOnce;
        yield* Deferred.await(second);
        assert.strictEqual(yield* sync.activeResolutions, 2);
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(peer(), model))),
    );
  }),
);

it.effect.each([0, 80])("eligibility uses bounded ports with %s historical revisions", (history) =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const renewed = yield* Deferred.make<void>();
    let renews = 0;
    let issued: M.MemoryResolutionLease | undefined;
    const client = peer({
      claim: (_c, { protocolVersion: _p, ...claim }) =>
        Effect.sync(() => {
          issued = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return issued;
        }),
      renew: () =>
        Effect.gen(function* () {
          renews++;
          const ticket = issued!;
          if (renews === 2) yield* Deferred.succeed(renewed, undefined);
          return ticket;
        }),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const store = yield* Store.MemoryStore;
        const memory = M.MemoryId.make(id(28000));
        let parent: M.MemoryRevisionId | undefined;
        for (let n = 0; n <= history; n++) {
          const op = operation(29000 + n, memory);
          if (op.kind !== "upsert") throw new Error("fixture");
          yield* commit({
            ...op,
            expectedHeads: parent ? [parent] : [],
            revision: { ...op.revision, parents: parent ? [parent] : [] },
          });
          parent = op.revision.revisionId;
        }
        for (let n = 0; n < 2; n++) {
          const op = operation(30000 + n, memory);
          if (op.kind !== "upsert") throw new Error("fixture");
          yield* commit({
            ...op,
            expectedHeads: [parent!],
            revision: { ...op.revision, parents: [parent!] },
          });
        }
        let aggregates = 0;
        let snapshots = 0;
        let heads = 0;
        const observed = Store.MemoryStore.of({
          ...store,
          loadAggregate: (...args) => {
            aggregates++;
            return store.loadAggregate(...args);
          },
          readResolutionSnapshot: (...args) => {
            snapshots++;
            return store.readResolutionSnapshot(...args);
          },
          readResolutionHeads: (input) => {
            heads++;
            return store.readResolutionHeads(input);
          },
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.syncOnce;
            yield* Deferred.await(entered);
            assert.strictEqual(heads, 1);
            const before = snapshots;
            yield* TestClock.adjust("30 seconds");
            yield* Deferred.await(renewed);
            yield* sync.syncOnce;
            assert.strictEqual(aggregates, 0);
            assert.strictEqual(heads, 1);
            assert.strictEqual(snapshots - before, 2);
            yield* sync.shutdown;
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Store.MemoryStore, observed)),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

it.effect(
  "published bootstrap commits 100 exact intents then advances and replays identical retry",
  () =>
    Effect.gen(function* () {
      let observedStore: Store.MemoryStore["Service"] | undefined;
      const sent: M.MemoryOperation[] = [];
      let failed = false;
      let nextSequence = 2;
      const client = peer({
        join: () =>
          Effect.succeed({
            protocolVersion: 1,
            memorySpaceId: space,
            hubEnvironmentId: remote,
            checkpointSequence: 0,
            retentionFloor: 0,
            snapshotToken: "intent-snapshot",
            causalBoundary: { checkpointSequence: 0, boundaryId: "intent-boundary" },
          }),
        pull: (_c, input) =>
          Effect.succeed(
            input.snapshotToken
              ? {
                  highWatermark: 0,
                  throughSequence: 0,
                  hasMore: false,
                  entries: [],
                  checkpoint: {
                    memorySpaceId: space,
                    checkpointSequence: 0,
                    retentionFloor: 0,
                    causalBoundary: { checkpointSequence: 0, boundaryId: "intent-boundary" },
                    pageOrdinal: 0,
                    items: [],
                    revisions: [],
                    tombstones: [],
                    conflicts: [],
                    resolutions: [],
                    compactReceipts: [],
                    identities: [],
                    fences: [],
                    suppressions: [],
                    importLineage: [],
                    nextCursor: null,
                    bootstrapComplete: true,
                  },
                }
              : {
                  highWatermark: Math.max(1, input.afterSequence),
                  throughSequence: Math.max(1, input.afterSequence),
                  hasMore: false,
                  entries: input.afterSequence === 0 ? tailEntries(0, 1) : [],
                },
          ),
        push: (_c, input) =>
          Effect.gen(function* () {
            assert.isAtLeast(yield* observedStore!.readCursor(space, remote).pipe(Effect.orDie), 1);
            sent.push(...input.operations);
            if (!failed) {
              failed = true;
              return yield* new M.MemoryHubError({ code: "unavailable" });
            }
            return {
              receipts: input.operations.map((op) => ({
                operationId: op.operationId,
                memoryId: op.memoryId,
                operationDigest: memoryOperationDigest(op),
                hubSequence: nextSequence++,
                outcome: "accepted" as const,
              })),
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const store = yield* Store.MemoryStore;
          observedStore = store;
          for (let n = 0; n < 101; n++)
            yield* store.putLocalIntent({
              intentId: `exact-${String(n).padStart(3, "0")}`,
              memoryId: M.MemoryId.make(id(31000 + n)),
              environmentId: local,
              scope: { kind: "user" },
              provenance: { environmentId: local },
              assertionKind: "inference",
              createdAtUtc: timestamp,
              payload: {
                text: `synthetic local ${n}`,
                evidence: [],
                derivedFromMemoryRevisions: [],
              },
            });
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          assert.strictEqual((yield* store.listMaterializableIntents(local, 100)).length, 1);
          assert.strictEqual(sent.length, 100);
          yield* sync.syncOnce;
          assert.strictEqual((yield* store.listMaterializableIntents(local, 100)).length, 0);
          assert.strictEqual(sent.length, 101);
          yield* TestClock.adjust("1 second");
          yield* sync.syncOnce;
          assert.strictEqual(sent.length, 102);
          assert.deepStrictEqual(sent[101], sent[0]);
          assert.strictEqual(memoryOperationDigest(sent[101]!), memoryOperationDigest(sent[0]!));
          assert.strictEqual(
            (yield* store.readOperation(space, sent[0]!.operationId))?.operationId,
            sent[0]!.operationId,
          );
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect("intent binding is rechecked inside commit and rejects a changed space", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      const store = yield* Store.MemoryStore;
      yield* store.putLocalIntent({
        intentId: "space-fence",
        memoryId: M.MemoryId.make(id(32000)),
        environmentId: local,
        scope: { kind: "user" },
        provenance: { environmentId: local },
        assertionKind: "inference",
        createdAtUtc: timestamp,
        payload: { text: "synthetic fenced", evidence: [], derivedFromMemoryRevisions: [] },
      });
      const base = yield* Sync.MemorySyncRuntime;
      const adapter = Sync.MemorySyncRuntime.of({
        ...base,
        readIntentBinding: Effect.succeed({
          memorySpaceId: M.MemorySpaceId.make(id(32001)),
          coordinatorEpoch: 1,
          enabled: true,
        }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          const result = yield* Effect.result(sync.syncOnce);
          assert.strictEqual(result._tag, "Failure");
          if (result._tag === "Failure" && "code" in result.failure)
            assert.strictEqual(result.failure.code, "fenced");
          assert.strictEqual((yield* store.listMaterializableIntents(local, 100)).length, 1);
          assert.strictEqual((yield* store.readEligibleOutbox(space, 0, 100)).length, 0);
          yield* sync.shutdown;
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, adapter)),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(fixture())),
  ),
);

it.effect("ticketless definitive refusal rotates the frozen attempt but uncertainty does not", () =>
  Effect.gen(function* () {
    const claims: M.MemoryHubClaimInput[] = [];
    let code: M.MemoryFailureCode = "conflict_changed";
    const client = peer({
      claim: (_c, input) =>
        Effect.sync(() => {
          claims.push(input);
        }).pipe(Effect.andThen(Effect.suspend(() => Effect.fail(new M.MemoryHubError({ code }))))),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        code = "unavailable";
        yield* TestClock.adjust("30 seconds");
        yield* sync.syncOnce;
        assert.strictEqual(claims.length, 2);
        assert.notStrictEqual(claims[1]!.attemptId, claims[0]!.attemptId);
        yield* TestClock.adjust("30 seconds");
        yield* sync.syncOnce;
        assert.strictEqual(claims.length, 3);
        assert.deepStrictEqual(claims[2], claims[1]);
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect.each(["rejected", "uncertain"] as const)(
  "%s apply preserves its retirement contract and new-conflict discovery",
  (outcome) =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      let generations = 0;
      let submitted: M.MemoryHubApplyResolutionInput | undefined;
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            submitted = input;
            if (outcome === "uncertain")
              return yield* new M.MemoryHubError({ code: "unavailable" });
            return {
              operationId: input.operation.operationId,
              memoryId: input.operation.memoryId,
              operationDigest: memoryOperationDigest(input.operation),
              hubSequence: null,
              outcome: "rejected" as const,
              failureCode: "conflict_changed" as const,
            };
          }),
        release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.gen(function* () {
            generations++;
            if (generations === 2) {
              yield* Deferred.succeed(second, undefined);
              return yield* Effect.never;
            }
            return {
              result: {
                text: "synthetic resolution",
                evidence: [],
                assertionKind: "inference" as const,
                judgment: "synthetic judgment",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          yield* sync.syncOnce;
          yield* Deferred.await(released);
          yield* sync.shutdown;
          const saved = yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          });
          if (outcome === "rejected") {
            assert.strictEqual(generations, 1);
            assert.strictEqual((yield* store.readDueClaimCandidates(100, 0, space)).length, 0);
            assert.strictEqual((yield* store.readDueClaimCandidates(100, 29999, space)).length, 0);
            assert.strictEqual((yield* store.readDueClaimCandidates(100, 30000, space)).length, 1);
            assert.strictEqual(saved.length, 0);
            assert.isNull(
              yield* store.findClaimCandidate({
                memorySpaceId: space,
                attemptId: submitted!.attemptId,
              }),
            );
          } else {
            assert.deepStrictEqual(saved[0]?.submission, submitted);
            assert.isNotNull(
              yield* store.findClaimCandidate({
                memorySpaceId: space,
                attemptId: submitted!.attemptId,
              }),
            );
          }
          const other = yield* conflict(2);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              yield* Deferred.await(second);
              assert.strictEqual(generations, 2);
              assert.strictEqual(
                (yield* store.readResolutionSnapshot(space, other)).status,
                "quarantined",
              );
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect("a missing selected head body never exposes a partial frontier to generation", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let calls = 0;
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.sync(() => {
          calls++;
        }).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const memory = yield* conflict();
        const op = operation(6, memory);
        const root = operation(3, memory);
        if (op.kind !== "upsert" || root.kind !== "upsert") throw new Error("fixture");
        yield* commit({
          ...op,
          expectedHeads: [root.revision.revisionId],
          revision: { ...op.revision, parents: [root.revision.revisionId] },
        });
        const store = yield* Store.MemoryStore;
        const observed = Store.MemoryStore.of({
          ...store,
          readResolutionHeads: (input) =>
            store
              .readResolutionHeads(input)
              .pipe(
                Effect.map((heads) =>
                  heads.map((head, i) => (i === 0 ? { ...head, payload: null } : head)),
                ),
              ),
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.syncOnce;
            yield* Deferred.await(released);
            yield* sync.shutdown;
            assert.strictEqual(calls, 0);
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(Layer.succeed(Store.MemoryStore, observed)),
              ),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          fixture(
            peer({
              release: () =>
                Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
            }),
            model,
          ),
        ),
      ),
    );
  }),
);

it.effect(
  "discard and new join fence a late final bootstrap page without replacing the new token",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      const client = peer({
        join: () =>
          Effect.succeed({
            protocolVersion: 1,
            memorySpaceId: space,
            hubEnvironmentId: remote,
            checkpointSequence: 0,
            retentionFloor: 0,
            snapshotToken: "old-stage",
            causalBoundary: { checkpointSequence: 0, boundaryId: "old-boundary" },
          }),
        pull: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(resume)),
            Effect.as({
              highWatermark: 0,
              throughSequence: 0,
              hasMore: false,
              entries: [],
              checkpoint: {
                memorySpaceId: space,
                checkpointSequence: 0,
                retentionFloor: 0,
                causalBoundary: { checkpointSequence: 0, boundaryId: "old-boundary" },
                pageOrdinal: 0,
                items: [],
                revisions: [],
                tombstones: [],
                conflicts: [],
                resolutions: [],
                compactReceipts: [],
                identities: [],
                fences: [],
                suppressions: [],
                importLineage: [],
                nextCursor: null,
                bootstrapComplete: true,
              },
            }),
          ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          const run = yield* sync.syncOnce.pipe(Effect.forkScoped);
          yield* Deferred.await(entered);
          yield* store.transact(
            Effect.gen(function* () {
              yield* store.discardBootstrapTx({
                memorySpaceId: space,
                hubEnvironmentId: remote,
                expectedSnapshotToken: "old-stage",
                expectedCheckpointId: "hub:old-stage",
                expectedCheckpointSequence: 0,
              });
              yield* store.advanceBootstrapTx({
                memorySpaceId: space,
                hubEnvironmentId: remote,
                expectedState: "unbound",
                nextState: "staging",
                checkpointId: "hub:new-stage",
                snapshotToken: "new-stage",
                checkpointSequence: 1,
                nextCursor: null,
              });
            }),
          );
          yield* Deferred.succeed(resume, undefined);
          yield* Fiber.join(run);
          const progress = yield* store.readBootstrap({
            memorySpaceId: space,
            hubEnvironmentId: remote,
          });
          assert.strictEqual(progress.snapshotToken, "new-stage");
          assert.strictEqual(progress.checkpointId, "hub:new-stage");
          assert.strictEqual(progress.checkpointSequence, 1);
          assert.strictEqual(progress.state, "staging");
          assert.strictEqual(progress.pageCount, 0);
          assert.strictEqual(yield* store.readCursor(space, remote), 0);
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect(
  "hung first relay read sends its failure and the healthy pending successor before push",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const collectEntered = yield* Deferred.make<void>();
      const resumeCollect = yield* Deferred.make<void>();
      const pushed = yield* Deferred.make<void>();
      const pending = new Map<string, M.MemorySourceReadRequest>();
      for (const n of [9101, 9102])
        pending.set(id(n), {
          requestId: M.MemorySourceReadRequestId.make(id(n)),
          memorySpaceId: space,
          memoryId: M.MemoryId.make(id(2)),
          requesterEnvironmentId: remote,
          sourceThread: { environmentId: local, threadId: M.ThreadId.make("healthy-source") },
          sourceWatermark: {
            fromEventId: M.EventId.make("e1"),
            toEventId: M.EventId.make("e2"),
            throughSequence: 2,
          },
          messageIds: [],
          limit: 10,
          authorizedScopes: ["memory:read", "orchestration:read"],
          expiresAtHubTime: "1970-01-01T00:01:15.000Z",
        });
      const responses: M.MemoryHubSourceReadNormalRespondInput[] = [];
      const client = peer({
        collectSourceReads: () =>
          Deferred.succeed(collectEntered, undefined).pipe(
            Effect.andThen(Deferred.await(resumeCollect)),
            Effect.andThen(Effect.sync(() => ({ requests: [...pending.values()] }))),
          ),
        respondSourceRead: (_c, response) =>
          Effect.sync(() => {
            if (response.kind !== "normal") throw new Error("Expected normal response");
            responses.push(response);
            pending.delete(response.requestId);
            return { kind: "normal" as const, accepted: true };
          }),
        push: (_c, input) =>
          Deferred.succeed(pushed, undefined).pipe(
            Effect.as({
              receipts: input.operations.map((op) => ({
                operationId: op.operationId,
                memoryId: op.memoryId,
                operationDigest: memoryOperationDigest(op),
                hubSequence: 1,
                outcome: "accepted" as const,
              })),
            }),
          ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* enqueue(910);
          const base = yield* Sync.MemorySyncRuntime;
          const owner = {
            ...base,
            ownerReader: {
              readForRelay: (request: M.MemorySourceReadRequest) =>
                request.requestId === id(9101)
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed({
                      outcome: {
                        kind: "available" as const,
                        page: {
                          sourceThread: request.sourceThread,
                          watermark: request.sourceWatermark,
                          messages: [],
                          nextCursor: null,
                        },
                      },
                      validate: Effect.void,
                    }),
              readCommitted: (request: M.MemorySourceReadRequest) =>
                request.requestId === id(9101)
                  ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.succeed({
                      kind: "available" as const,
                      page: {
                        sourceThread: request.sourceThread,
                        watermark: request.sourceWatermark,
                        messages: [],
                        nextCursor: null,
                      },
                    }),
            },
          };
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              const run = yield* sync.syncOnce.pipe(Effect.forkScoped);
              yield* Deferred.await(collectEntered);
              yield* TestClock.adjust("1 second");
              yield* Deferred.succeed(resumeCollect, undefined);
              yield* Deferred.await(entered);
              yield* TestClock.adjust("5 seconds");
              yield* TestClock.adjust("9 seconds");
              yield* Fiber.join(run);
              assert.isTrue(Option.isSome(yield* Deferred.poll(pushed)));
              assert.deepStrictEqual(
                responses.map((r) => r.requestId),
                [id(9101), id(9102)],
              );
              assert.deepStrictEqual(responses[0]?.outcome, {
                kind: "unavailable",
                code: "source_unavailable",
              });
              assert.strictEqual(responses[1]?.outcome.kind, "available");
              assert.strictEqual(pending.size, 0);
              yield* sync.syncOnce;
              assert.strictEqual(responses.length, 2);
              const store = yield* Store.MemoryStore;
              assert.strictEqual((yield* store.readEligibleOutbox(space, 5000, 100)).length, 0);
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, owner)),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect(
  "completion batches keep the active cycle scope bounded without accumulating waiters",
  () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      let releases = 0;
      let claims = 0;
      const batches = yield* Effect.forEach([0, 1, 2, 3, 4], () => Deferred.make<void>());
      let appScope: Scope.Scope | undefined;
      let currentSync: Sync.MemorySyncService["Service"] | undefined;
      const client = peer({
        claim: (_c, { protocolVersion: _p, ...input }) =>
          Effect.gen(function* () {
            claims++;
            if (claims % 4 === 0) {
              yield* Deferred.await(batches[claims / 4 - 1]!);
              yield* Effect.yieldNow;
            }
            return {
              ...input,
              fencingToken: 1,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            };
          }),
        applyResolution: (_c, input) =>
          Effect.succeed({
            operationId: input.operation.operationId,
            memoryId: input.operation.memoryId,
            operationDigest: memoryOperationDigest(input.operation),
            hubSequence: null,
            outcome: "rejected",
            failureCode: "conflict_changed",
          }),
        release: () =>
          Effect.gen(function* () {
            releases++;
            if (releases % 4 === 3)
              yield* Deferred.succeed(batches[Math.floor(releases / 4)]!, undefined);
            return { released: true };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.succeed({
            result: {
              text: "synthetic resolution",
              evidence: [],
              assertionKind: "inference",
              judgment: "synthetic judgment",
            },
            execution: {
              requestedModelSelection: input.modelSelection,
              effectiveProvider: M.ProviderDriverKind.make("codex"),
              effectiveModel: input.modelSelection.model,
              providerInstanceId: input.modelSelection.instanceId,
              environmentId: local,
            },
          }),
      });
      const count = () =>
        appScope?.state._tag === "Open"
          ? (appScope.state.finalizer ? 1 : 0) + (appScope.state.finalizers?.size ?? 0)
          : 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          for (let n = 1; n <= 20; n++) yield* conflict(n);
          const settings = yield* Settings.ServerSettingsService;
          const store = yield* Store.MemoryStore;
          const callerScope = yield* Scope.Scope;
          const control = Layer.fresh(Sync.layer).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(Settings.ServerSettingsService, {
                  ...settings,
                  getSettings: Effect.gen(function* () {
                    if (!appScope)
                      appScope = Option.getOrUndefined(yield* Effect.serviceOption(Scope.Scope));
                    return yield* settings.getSettings;
                  }),
                }),
                Layer.succeed(Store.MemoryStore, {
                  ...store,
                  readDueClaimCandidates: (limit, now, s) =>
                    releases >= 12
                      ? Deferred.succeed(gate, undefined).pipe(Effect.andThen(Effect.never))
                      : Effect.gen(function* () {
                          // An external coalesced hint keeps this cycle open across batches.
                          const hint = yield* currentSync!.scheduleConflictResolution.pipe(
                            Effect.forkIn(callerScope),
                          );
                          yield* Effect.yieldNow;
                          yield* Fiber.interrupt(hint);
                          return yield* store.readDueClaimCandidates(limit, now, s);
                        }),
                }),
              ),
            ),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              currentSync = sync;
              assert.isDefined(appScope);
              const baseline = count();
              const run = yield* sync.syncOnce.pipe(Effect.forkScoped);
              yield* Deferred.await(gate);
              yield* Effect.yieldNow;
              assert.isAtLeast(releases, 12);
              assert.isAtLeast(count(), baseline + 1);
              assert.isAtMost(count(), baseline + 6);
              yield* sync.shutdown;
              yield* Fiber.await(run);
            }).pipe(Effect.provide(control)),
          );
          assert.strictEqual(appScope!.state._tag, "Closed");
          assert.strictEqual(count(), 0);
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect.each(["bootstrap", "tail"] as const)(
  "durable %s retry survives coordinator restart and resets only after successful pull",
  (phase) =>
    Effect.gen(function* () {
      let pulls = 0;
      let unavailable = true;
      const client = peer({
        join: () =>
          Effect.succeed({
            protocolVersion: 1,
            memorySpaceId: space,
            hubEnvironmentId: remote,
            checkpointSequence: 0,
            retentionFloor: 0,
            snapshotToken: "durable-stage",
            causalBoundary: { checkpointSequence: 0, boundaryId: "durable-boundary" },
          }),
        pull: (_c, input) =>
          Effect.gen(function* () {
            pulls++;
            if (unavailable) return yield* new M.MemoryHubError({ code: "unavailable" });
            return {
              highWatermark: 0,
              throughSequence: 0,
              hasMore: false,
              entries: [],
              ...(input.snapshotToken
                ? {
                    checkpoint: {
                      memorySpaceId: space,
                      checkpointSequence: 0,
                      retentionFloor: 0,
                      causalBoundary: { checkpointSequence: 0, boundaryId: "durable-boundary" },
                      pageOrdinal: 0,
                      items: [],
                      revisions: [],
                      tombstones: [],
                      conflicts: [],
                      resolutions: [],
                      compactReceipts: [],
                      identities: [],
                      fences: [],
                      suppressions: [],
                      importLineage: [],
                      nextCursor: null,
                      bootstrapComplete: true,
                    },
                  }
                : {}),
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          if (phase === "tail") yield* ready;
          const store = yield* Store.MemoryStore;
          const key = { memorySpaceId: space, hubEnvironmentId: remote };
          const sync = yield* Sync.MemorySyncService;
          assert.strictEqual((yield* Effect.result(sync.syncOnce))._tag, "Failure");
          assert.strictEqual(pulls, 1);
          const retry = yield* store.readPullRetry(key);
          assert.deepStrictEqual(retry, {
            version: 1,
            attempts: 1,
            nextAttemptAt: 1000,
            failureCode: "unavailable",
            holdClass: null,
          });
          const stage = yield* store.readBootstrap(key);
          if (phase === "bootstrap") assert.strictEqual(stage.snapshotToken, "durable-stage");
          yield* sync.shutdown;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              assert.strictEqual(pulls, 1);
              assert.deepStrictEqual(yield* store.readBootstrap(key), stage);
              yield* TestClock.adjust("999 millis");
              yield* restarted.syncOnce;
              assert.strictEqual(pulls, 1);
              unavailable = false;
              yield* TestClock.adjust("1 millis");
              yield* restarted.syncOnce;
              assert.strictEqual(pulls, phase === "bootstrap" ? 4 : 3);
              assert.deepStrictEqual(yield* store.readPullRetry(key), {
                version: 2,
                attempts: 0,
                nextAttemptAt: 0,
                failureCode: null,
                holdClass: null,
              });
              assert.strictEqual((yield* store.readBootstrap(key)).state, "ready");
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect.each(["epoch", "hub"] as const)(
  "rearm observation crossing an adapter handoff cannot release current holds: %s",
  (mismatch) =>
    Effect.gen(function* () {
      const observed = yield* Deferred.make<void>();
      const deliver = yield* Deferred.make<void>();
      const consumed = yield* Deferred.make<void>();
      let pushes = 0;
      const client = peer({
        push: () =>
          Effect.sync(() => {
            pushes++;
          }).pipe(Effect.andThen(Effect.fail(new M.MemoryHubUnauthorizedError({})))),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const store = yield* Store.MemoryStore;
          const base = yield* Sync.MemorySyncRuntime;
          // Observe under epoch 1, then pause strictly between adapter observation and Sync delivery.
          const rearmEvents = Stream.fromEffect(
            Effect.gen(function* () {
              const event = {
                epoch: 1,
                memorySpaceId: space,
                hubEnvironmentId: remote,
                holdClass: "authorization" as const,
              };
              yield* Deferred.succeed(observed, undefined);
              yield* Deferred.await(deliver);
              return mismatch === "hub"
                ? { ...event, hubEnvironmentId: M.EnvironmentId.make("foreign-hub") }
                : event;
            }),
          ).pipe(Stream.ensuring(Deferred.succeed(consumed, undefined)));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              yield* sync.start;
              yield* Deferred.await(observed);
              if (mismatch === "epoch")
                yield* changeHub(1, { ...member, secretName: "new-binding" });
              yield* enqueue(95001);
              yield* sync.syncOnce;
              assert.strictEqual(pushes, 1);
              assert.strictEqual(
                (yield* store.readWorkHold("sync:95001"))?.holdClass,
                "authorization",
              );
              yield* store.transact(
                store.writePullRetryTx({
                  memorySpaceId: space,
                  hubEnvironmentId: remote,
                  expectedVersion: 0,
                  retry: {
                    attempts: 1,
                    nextAttemptAt: Number.MAX_SAFE_INTEGER,
                    failureCode: "route_unavailable",
                    holdClass: "authorization",
                  },
                }),
              );
              yield* Deferred.succeed(deliver, undefined);
              yield* Deferred.await(consumed);
              yield* sync.syncOnce;
              assert.strictEqual(pushes, 1, "stale observation cannot retry the new hold");
              assert.strictEqual(
                (yield* store.readWorkHold("sync:95001"))?.holdClass,
                "authorization",
              );
              assert.strictEqual(
                (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
                  .holdClass,
                "authorization",
              );
              yield* sync.shutdown;
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(Layer.succeed(Sync.MemorySyncRuntime, { ...base, rearmEvents })),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect(
  "authorization observation rearms 101 held pushes with continuation and preserves other classes and spaces",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.bounded<{
        epoch: number;
        hubEnvironmentId: M.EnvironmentId;
        memorySpaceId: M.MemorySpaceId;
        holdClass: Store.MemoryHoldClass;
      }>(4);
      const done = yield* Deferred.make<void>();
      let rejected = true;
      let accepted = 0;
      const client = peer({
        push: (_c, input) =>
          Effect.gen(function* () {
            if (rejected) return yield* new M.MemoryHubUnauthorizedError({});
            accepted++;
            if (accepted === 101) yield* Deferred.succeed(done, undefined);
            return {
              receipts: input.operations.map((op) => ({
                operationId: op.operationId,
                memoryId: op.memoryId,
                operationDigest: memoryOperationDigest(op),
                hubSequence: accepted,
                outcome: "accepted" as const,
              })),
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          for (let n = 9000; n < 9102; n++) yield* enqueue(n, M.MemoryId.make(id(n + 10000)));
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          const base = yield* Sync.MemorySyncRuntime;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              yield* sync.start;
              yield* sync.syncOnce;
              assert.strictEqual(
                (yield* sql`SELECT id FROM memory_outbox WHERE hold_class='authorization' AND kind='sync'`)
                  .length,
                102,
              );
              yield* sql`UPDATE memory_outbox SET hold_class='protocol',failure_code='invalid_output' WHERE id='sync:9101'`;
              const otherSpace = M.MemorySpaceId.make(id(9800));
              for (const s of [space, otherSpace])
                yield* store.transact(
                  store.writePullRetryTx({
                    memorySpaceId: s,
                    hubEnvironmentId: remote,
                    expectedVersion: 0,
                    retry: {
                      attempts: 1,
                      nextAttemptAt: Number.MAX_SAFE_INTEGER,
                      failureCode: "route_unavailable",
                      holdClass: "authorization",
                    },
                  }),
                );
              rejected = false;
              yield* PubSub.publish(events, {
                epoch: 1,
                hubEnvironmentId: remote,
                memorySpaceId: otherSpace,
                holdClass: "authorization" as const,
              });
              yield* sync.syncOnce;
              assert.strictEqual(accepted, 0);
              yield* PubSub.publish(events, {
                epoch: 1,
                hubEnvironmentId: remote,
                memorySpaceId: space,
                holdClass: "authorization" as const,
              });
              yield* Deferred.await(done);
              yield* sync.syncOnce;
              assert.strictEqual(accepted, 101);
              assert.deepStrictEqual(yield* store.readWorkHold("sync:9101"), {
                holdClass: "protocol",
                failureCode: "invalid_output",
              });
              assert.strictEqual(
                (yield* store.readPullRetry({
                  memorySpaceId: otherSpace,
                  hubEnvironmentId: remote,
                })).holdClass,
                "authorization",
              );
              assert.strictEqual(
                (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
                  .holdClass,
                null,
              );
              yield* sync.shutdown;
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(
                    Layer.succeed(Sync.MemorySyncRuntime, {
                      ...base,
                      rearmEvents: Stream.fromPubSub(events),
                    }),
                  ),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect(
  "permanent claim refusal holds its frozen attempt until the matching authorization observation",
  () =>
    Effect.gen(function* () {
      const events = yield* PubSub.bounded<{
        epoch: number;
        hubEnvironmentId: M.EnvironmentId;
        memorySpaceId: M.MemorySpaceId;
        holdClass: Store.MemoryHoldClass;
      }>(4);
      const retried = yield* Deferred.make<void>();
      const claims: M.MemoryHubClaimInput[] = [];
      const client = peer({
        claim: (_c, input) =>
          Effect.gen(function* () {
            claims.push(input);
            if (claims.length === 2) yield* Deferred.succeed(retried, undefined);
            return yield* new M.MemoryHubUnauthorizedError({});
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const base = yield* Sync.MemorySyncRuntime;
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              yield* sync.start;
              assert.strictEqual(claims.length, 1);
              const held = (yield* sql<{
                id: string;
              }>`SELECT id FROM memory_outbox WHERE kind='claim' AND hold_class='authorization'`)[0];
              assert.isDefined(held);
              yield* sync.syncOnce;
              assert.strictEqual(claims.length, 1);
              yield* PubSub.publish(events, {
                epoch: 1,
                hubEnvironmentId: remote,
                memorySpaceId: space,
                holdClass: "protocol" as const,
              });
              yield* sync.syncOnce;
              assert.strictEqual(claims.length, 1);
              yield* PubSub.publish(events, {
                epoch: 1,
                hubEnvironmentId: remote,
                memorySpaceId: space,
                holdClass: "authorization" as const,
              });
              yield* Deferred.await(retried);
              yield* sync.syncOnce;
              assert.deepStrictEqual(claims[1], claims[0]);
              assert.strictEqual((yield* store.readWorkHold(held!.id))?.holdClass, "authorization");
              yield* sync.shutdown;
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(
                    Layer.succeed(Sync.MemorySyncRuntime, {
                      ...base,
                      rearmEvents: Stream.fromPubSub(events),
                    }),
                  ),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

const refusals = [
  {
    shape: "a typed runner refusal",
    error: new M.TextGenerationError({
      operation: "resolveMemoryConflict",
      detail: "Grok did not disclose or support the selected memory model.",
      cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
    }),
  },
  {
    shape: "a provider setup error under a generic detail",
    error: new M.TextGenerationError({
      operation: "resolveMemoryConflict",
      detail: "Antigravity text generation failed.",
      cause: new M.ProviderSetupError({
        instanceId: M.ProviderInstanceId.make("antigravity"),
        operation: "start",
        detail: "Antigravity needs a Gemini API key or Google Cloud project.",
      }),
    }),
  },
];
it.effect.each([
  ...refusals.map((refusal) => ({ ...refusal, lostReleaseResponses: 0 })),
  // The Hub ended the lease but its release answer was lost: the attempt still retires.
  { ...refusals[0]!, shape: "a refusal whose release answer is lost", lostReleaseResponses: 1 },
])(
  "$shape retires the attempt unreported and claims the conflict again once the model is due",
  ({ error, lostReleaseResponses }) =>
    Effect.gen(function* () {
      let calls = 0;
      let claims = 0;
      const model = realGeneration({
        resolveMemoryConflict: () =>
          Effect.suspend(() => {
            calls++;
            return Effect.fail(error);
          }),
      });
      const client = peer(
        {
          claim: (_c, { protocolVersion: _protocol, ...claim }) =>
            Effect.sync(() => {
              claims++;
              return {
                ...claim,
                fencingToken: claims,
                claimedAtHubTime: timestamp,
                expiresAtHubTime: "1970-01-01T00:02:00.000Z",
                attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
              };
            }),
        },
        { releaseEndsLease: true, lostReleaseResponses },
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          const attempt = Effect.gen(function* () {
            yield* sync.syncOnce;
            yield* sync.scheduleConflictResolution;
          });
          yield* attempt;
          assert.deepStrictEqual([calls, claims], [1, 1]);
          // Held: sweeps before the probe neither call the provider nor claim at the Hub.
          for (let n = 0; n < 5; n++) {
            yield* TestClock.adjust("5 seconds");
            yield* attempt;
          }
          assert.deepStrictEqual([calls, claims], [1, 1]);
          // A refusal is not a failed resolution.
          assert.isFalse(
            (yield* store.pendingReports(100)).some((report) => report.outcome === "failed"),
          );
          // Once the hold is due the conflict is claimed afresh, with a new lease.
          yield* TestClock.adjust("1 minute");
          yield* attempt;
          if (lostReleaseResponses > 0) {
            // Recovery first retires the stranded attempt (its lease is fenced), then the
            // conflict waits its ordinary 30 seconds before the next claim.
            assert.strictEqual(claims, 1);
            yield* TestClock.adjust("35 seconds");
            yield* attempt;
          }
          assert.deepStrictEqual([calls, claims], [2, 2]);
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client, model).pipe(Layer.provideMerge(Hold.layer)))),
      );
    }),
);

it.effect("a claim frozen to a healthy model is not blocked by a held default", () =>
  Effect.gen(function* () {
    let claims = 0;
    const frozenModels: string[] = [];
    const client = peer({
      claim: (_c, { protocolVersion: _protocol, ...claim }) =>
        Effect.suspend(() => {
          claims++;
          frozenModels.push(claim.frozenDefaultModelSelection.model);
          // The Hub's answer to the first claim never arrives; the claim stays frozen.
          if (claims === 1) return Effect.fail(new M.MemoryHubError({ code: "unavailable" }));
          return Effect.succeed({
            ...claim,
            fencingToken: claims,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          });
        }),
    });
    const model = realGeneration({ resolveMemoryConflict: () => Effect.never });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        const hold = yield* Hold.MemoryGenerationHold;
        yield* sync.syncOnce;
        yield* sync.scheduleConflictResolution;
        assert.strictEqual(claims, 1);
        // The default moves to a model the provider refuses.
        const next = M.MemoryModelSelection.make({
          instanceId: M.ProviderInstanceId.make("Q"),
          model: "Q",
        });
        yield* (yield* Settings.ServerSettingsService).updateSettings({
          memoryModelSelection: next,
        });
        yield* hold
          .guard(
            yield* hold.keyFor(next),
            Effect.fail(
              new M.TextGenerationError({
                operation: "resolveMemoryConflict",
                detail: 'Codex CLI command failed: {"code":"invalid_json_schema","status":400}',
              }),
            ),
          )
          .pipe(Effect.flip);
        // Still inside the hold on the new default (its first probe is a minute away).
        yield* TestClock.adjust("40 seconds");
        yield* sync.syncOnce;
        yield* sync.scheduleConflictResolution;
        // The frozen claim retries with its own model while the new default is held.
        assert.strictEqual(claims, 2);
        assert.deepStrictEqual(frozenModels, [frozenModels[0], frozenModels[0]]);
        assert.notStrictEqual(frozenModels[0], "Q");
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client, model).pipe(Layer.provideMerge(Hold.layer)))),
    );
  }),
);

it.effect(
  "conflicts waiting on a held model do not crowd a healthy frozen claim off the page",
  () =>
    Effect.gen(function* () {
      const frozenModels: string[] = [];
      const client = peer({
        claim: (_c, { protocolVersion: _protocol, ...claim }) =>
          Effect.suspend(() => {
            frozenModels.push(claim.frozenDefaultModelSelection.model);
            // The Hub's answer to the first claim never arrives; that claim stays frozen to P.
            if (frozenModels.length === 1)
              return Effect.fail(new M.MemoryHubError({ code: "unavailable" }));
            return Effect.succeed({
              ...claim,
              fencingToken: frozenModels.length,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            });
          }),
      });
      const model = realGeneration({ resolveMemoryConflict: () => Effect.never });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const hold = yield* Hold.MemoryGenerationHold;
          yield* sync.syncOnce;
          yield* sync.scheduleConflictResolution;
          const next = M.MemoryModelSelection.make({
            instanceId: M.ProviderInstanceId.make("Q"),
            model: "Q",
          });
          yield* (yield* Settings.ServerSettingsService).updateSettings({
            memoryModelSelection: next,
          });
          yield* hold
            .guard(
              yield* hold.keyFor(next),
              Effect.fail(
                new M.TextGenerationError({
                  operation: "resolveMemoryConflict",
                  detail: 'Codex CLI command failed: {"code":"invalid_json_schema","status":400}',
                }),
              ),
            )
            .pipe(Effect.flip);
          // A full page of conflicts that would use the held default, all due before P's retry.
          for (let n = 2; n <= 110; n++) yield* conflict(n);
          // Candidate discovery is paged too; a few passes queue them all.
          for (let n = 0; n < 3; n++) yield* sync.syncOnce;
          // Still inside the hold on Q; P's frozen claim is due by now.
          yield* TestClock.adjust("40 seconds");
          for (let n = 0; n < 2; n++) {
            yield* sync.syncOnce;
            yield* sync.scheduleConflictResolution;
          }
          assert.deepStrictEqual(frozenModels, [frozenModels[0], frozenModels[0]]);
          assert.notStrictEqual(frozenModels[0], "Q");
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client, model).pipe(Layer.provideMerge(Hold.layer)))),
      );
    }),
);

it.effect("a fenced release after the Hub binding changed keeps the attempt for recovery", () =>
  Effect.gen(function* () {
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.fail(
          new M.TextGenerationError({
            operation: "resolveMemoryConflict",
            detail: "Grok did not disclose or support the selected memory model.",
            cause: new MemoryGenerationRunnerError({ code: "unavailable" }),
          }),
        ),
    });
    const client = peer({
      // Settings moved to another Hub binding, so the client fences locally: the old lease
      // may still be live at the Hub, and the attempt must not be retired on that answer.
      release: () =>
        changeHub(1, { ...member, secretName: "rebound-fixture" }).pipe(
          Effect.orDie,
          Effect.andThen(Effect.fail(new M.MemoryHubError({ code: "fenced" }))),
        ),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* sync.scheduleConflictResolution;
        const sql = yield* SqlClient.SqlClient;
        const tickets = yield* sql<{
          state: string;
        }>`SELECT json_extract(ticket_json,'$.state') AS state FROM memory_outbox WHERE kind='resolve'`;
        assert.strictEqual(tickets.length, 1);
        assert.notStrictEqual(tickets[0]!.state, "terminal");
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client, model).pipe(Layer.provideMerge(Hold.layer)))),
    );
  }),
);

it.effect(
  "generation failure records one conflict report, retires the attempt, and the next attempt uses Q",
  () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const selections: M.MemoryModelSelection[] = [];
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.gen(function* () {
            selections.push(input.modelSelection);
            if (selections.length === 2) {
              yield* Deferred.succeed(second, undefined);
              return yield* Effect.never;
            }
            // A syntactically valid result with foreign execution identity must fail validation.
            return {
              result: {
                text: "synthetic result",
                evidence: [],
                assertionKind: "inference",
                judgment: "synthetic judgment",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: remote,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          const settings = yield* Settings.ServerSettingsService;
          yield* sync.syncOnce;
          yield* Deferred.await(released);
          yield* sync.scheduleConflictResolution;
          const reports = yield* store.pendingReports(100);
          assert.strictEqual(reports.length, 1);
          assert.strictEqual(reports[0]?.outcome, "failed");
          assert.strictEqual(reports[0]?.failureCode, "invalid_output");
          const next = { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" };
          yield* settings.updateSettings({ memoryModelSelection: next });
          yield* TestClock.adjust("30 seconds");
          yield* sync.syncOnce;
          yield* Deferred.await(second);
          assert.deepStrictEqual(selections, [selection, next]);
          assert.strictEqual((yield* store.pendingReports(100)).length, 1);
          yield* sync.shutdown;
        }).pipe(
          Effect.provide(
            fixture(
              peer({
                release: () =>
                  Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
              }),
              model,
            ),
          ),
        ),
      );
    }),
);

it.effect(
  "scanner policy release reaches conflict discovery only after a successful committed rescan",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let generations = 0;
      const model = realGeneration({
        resolveMemoryConflict: () =>
          Effect.gen(function* () {
            generations++;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const memoryId = yield* conflict();
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          const snapshot = yield* store.readResolutionSnapshot(space, memoryId);
          const row = {
            kind: "scanner" as const,
            state: "pending" as const,
            reason: null,
            revisionId: snapshot.heads[0]!,
            generation: snapshot.generation,
            sinceAtUtc: M.MemoryUtcTimestamp.make(timestamp),
            attempt: 0,
            dueAt: 0,
            lastAttemptAt: null,
            claimedBy: null,
            claimedUntil: null,
          };
          yield* sql`UPDATE memory_items SET deferred_json=${encode([row])},scanner_policy_version=1 WHERE space=${space} AND memory_id=${memoryId}`;
          const target = { ...row, memorySpaceId: space, memoryId, payloadBytes: 0 };
          assert.isTrue(
            yield* store.finishDeferred(target, {
              now: 0,
              failure: "secret_detected",
              scannerPolicyVersion: 1,
            }),
          );
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          assert.strictEqual(generations, 0);
          yield* store.recoverDeferred(1, 0);
          assert.isFalse((yield* store.readDeferred(0, 100)).some((w) => w.kind === "scanner"));
          yield* store.recoverDeferred(2, 0);
          const rescan = (yield* store.readDeferred(0, 100)).find(
            (w) => w.kind === "scanner" && w.memoryId === memoryId,
          );
          assert.isDefined(rescan);
          yield* sync.syncOnce;
          assert.strictEqual(generations, 0);
          assert.isTrue(yield* store.finishDeferred(rescan!, { now: 0, scannerPolicyVersion: 2 }));
          yield* sync.syncOnce;
          yield* Deferred.await(entered);
          assert.strictEqual(generations, 1);
          assert.isFalse(
            (yield* store.readResolutionSnapshot(space, memoryId)).reasons.includes(
              "secret_detected",
            ),
          );
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(peer(), model))),
      );
    }),
);

it.effect(
  "claim response before ticket failure recovers alongside an existing uncertain submission",
  () =>
    Effect.gen(function* () {
      const released = yield* Deferred.make<void>();
      const recovered = yield* Deferred.make<M.MemoryModelSelection>();
      let database: SqlClient.SqlClient | undefined;
      let generations = 0;
      let submitted: M.MemoryHubApplyResolutionInput | undefined;
      const secondClaims: M.MemoryHubClaimInput[] = [];
      const secondMemory = M.MemoryId.make(id(4));
      const client = peer({
        claim: (_c, input) =>
          Effect.gen(function* () {
            if (input.memoryId === secondMemory) {
              secondClaims.push(input);
              if (secondClaims.length === 1)
                yield* database!`CREATE TRIGGER fixture_combined_ticket_failure BEFORE INSERT ON memory_outbox WHEN NEW.kind='resolve' AND NEW.memory_id='00000000-0000-4000-8000-000000000004' BEGIN SELECT RAISE(ABORT,'fixture ticket failure'); END`.pipe(
                  Effect.mapError(() => new M.MemoryHubError({ code: "storage_failed" })),
                );
            }
            const { protocolVersion: _p, ...claim } = input;
            return {
              ...claim,
              fencingToken: 41,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            };
          }),
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            submitted = input;
            return yield* new M.MemoryHubError({ code: "unavailable" });
          }),
        release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.gen(function* () {
            generations++;
            if (input.memoryId === secondMemory) {
              yield* Deferred.succeed(recovered, input.modelSelection);
              return yield* Effect.never;
            }
            return {
              result: {
                text: "synthetic result",
                evidence: [],
                assertionKind: "inference",
                judgment: "synthetic judgment",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          database = yield* SqlClient.SqlClient;
          yield* conflict();
          const store = yield* Store.MemoryStore;
          const settings = yield* Settings.ServerSettingsService;
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* Deferred.await(released);
          yield* sync.shutdown;
          const uncertain = (yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          }))[0]!;
          assert.deepStrictEqual(uncertain.submission, submitted);
          assert.strictEqual((yield* store.pendingReports(100)).length, 0);
          yield* conflict(2);
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              assert.strictEqual(secondClaims.length, 1);
              assert.strictEqual(generations, 1);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          yield* database`DROP TRIGGER fixture_combined_ticket_failure`;
          yield* settings.updateSettings({
            memoryModelSelection: { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" },
          });
          yield* TestClock.adjust("5 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              assert.deepStrictEqual(yield* Deferred.await(recovered), selection);
              assert.deepStrictEqual(secondClaims[1], secondClaims[0]);
              const retained = (yield* store.readRecoverableResolutionTickets({
                memorySpaceId: space,
                now: 30000,
                limit: 100,
              })).find((t) => t.ticket.attemptId === uncertain.ticket.attemptId);
              assert.deepStrictEqual(retained?.submission, submitted);
              assert.strictEqual(generations, 2);
              assert.strictEqual((yield* store.pendingReports(100)).length, 0);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect(
  "settings model change rearms availability pull hold while authorization push hold stays parked",
  () =>
    Effect.gen(function* () {
      const resumed = yield* Deferred.make<void>();
      let watch = false;
      const client = peer({
        pull: (_c, input) =>
          Effect.gen(function* () {
            if (watch) yield* Deferred.succeed(resumed, undefined);
            return {
              highWatermark: input.afterSequence,
              throughSequence: input.afterSequence,
              hasMore: false,
              entries: [],
            };
          }),
        push: () => Effect.fail(new M.MemoryHubUnauthorizedError({})),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          const settings = yield* Settings.ServerSettingsService;
          yield* sync.start;
          yield* enqueue(9900);
          yield* sync.syncOnce;
          assert.strictEqual((yield* store.readWorkHold("sync:9900"))?.holdClass, "authorization");
          const key = { memorySpaceId: space, hubEnvironmentId: remote };
          yield* store.transact(
            store.writePullRetryTx({
              ...key,
              expectedVersion: 0,
              retry: {
                attempts: 1,
                nextAttemptAt: Number.MAX_SAFE_INTEGER,
                failureCode: "route_unavailable",
                holdClass: "availability",
              },
            }),
          );
          watch = true;
          yield* settings.updateSettings({
            memoryModelSelection: { instanceId: M.ProviderInstanceId.make("Q"), model: "Q" },
          });
          yield* Deferred.await(resumed);
          yield* sync.syncOnce;
          assert.strictEqual((yield* store.readPullRetry(key)).holdClass, null);
          assert.strictEqual((yield* store.readWorkHold("sync:9900"))?.holdClass, "authorization");
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client, undefined, false, true))),
      );
    }),
);

it.effect(
  "automatic pull retry wakes at its durable due time instead of waiting for the periodic cycle",
  () =>
    Effect.gen(function* () {
      const retried = yield* Deferred.make<void>();
      let pulls = 0;
      const client = peer({
        pull: (_c, input) =>
          Effect.gen(function* () {
            pulls++;
            if (pulls === 1) return yield* new M.MemoryHubError({ code: "unavailable" });
            yield* Deferred.succeed(retried, undefined);
            return {
              highWatermark: input.afterSequence,
              throughSequence: input.afterSequence,
              hasMore: false,
              entries: [],
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          yield* sync.start;
          assert.strictEqual(pulls, 1);
          assert.strictEqual(
            (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
              .nextAttemptAt,
            1000,
          );
          yield* TestClock.adjust("999 millis");
          assert.strictEqual(pulls, 1);
          yield* TestClock.adjust("1 millis");
          yield* Deferred.await(retried);
          yield* sync.syncOnce;
          assert.strictEqual(
            (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
              .attempts,
            0,
          );
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect(
  "lost resolve response followed by canonical pull reconciles changed heads without regeneration",
  () =>
    Effect.gen(function* () {
      const submitted = yield* Deferred.make<void>();
      const recoveryObserved = yield* Deferred.make<void>();
      let saved: M.MemoryHubApplyResolutionInput | undefined;
      let deliver = false;
      let generated = 0;
      let applies = 0;
      const client = peer({
        release: () =>
          Effect.gen(function* () {
            // Release runs after the outer reconciliation transaction has committed.
            if (deliver) yield* Deferred.succeed(recoveryObserved, undefined);
            return { released: true };
          }),
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            saved = input;
            applies++;
            // Wake on an incorrect replay too, so bypassing reconciliation fails an assertion.
            if (deliver) yield* Deferred.succeed(recoveryObserved, undefined);
            yield* Deferred.succeed(submitted, undefined);
            return yield* new M.MemoryHubError({ code: "unavailable" });
          }),
        pull: (_c, input) =>
          Effect.sync(() => {
            if (!deliver || !saved || input.afterSequence >= 1)
              return {
                highWatermark: input.afterSequence,
                throughSequence: input.afterSequence,
                hasMore: false,
                entries: [],
              };
            const op = saved.operation;
            if (op.kind !== "resolve") throw new Error("fixture");
            const receipt: M.MemoryHubReceipt = {
              operationId: op.operationId,
              memoryId: op.memoryId,
              operationDigest: memoryOperationDigest(op),
              outcome: "accepted",
              hubSequence: 1,
              resolutionApproval: {
                resolutionId: op.resolution.resolutionId,
                appliedAtUtc: op.resolution.appliedAtUtc,
                revertDeadlineUtc: op.resolution.revertDeadlineUtc,
              },
            };
            return {
              highWatermark: 1,
              throughSequence: 1,
              hasMore: false,
              entries: [{ kind: "operation" as const, operation: op, receipt, hubSequence: 1 }],
            };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.sync(() => {
            generated++;
            return {
              result: {
                text: "synthetic reconcile result",
                assertionKind: "inference" as const,
                evidence: [],
                judgment: "combine synthetic facts",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const memoryId = yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* Deferred.await(submitted);
          yield* sync.shutdown;
          const store = yield* Store.MemoryStore;
          const ticket = (yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          }))[0]!;
          assert.deepStrictEqual(ticket.submission, saved);
          deliver = true;
          yield* TestClock.adjust("30 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              yield* Deferred.await(recoveryObserved);
              yield* restarted.shutdown;
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
          assert.strictEqual(generated, 1);
          assert.strictEqual(applies, 1);
          const aggregate = yield* store.loadAggregate(space, memoryId);
          const resolved = saved!.operation;
          if (resolved.kind !== "resolve") throw new Error("fixture");
          assert.deepStrictEqual(aggregate.heads, [resolved.revision.revisionId]);
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            status: string;
            submission_digest: string | null;
          }>`SELECT status,json_extract(ticket_json,'$.submissionDigest') AS submission_digest FROM memory_outbox WHERE kind='resolve' AND memory_id=${memoryId}`;
          assert.deepStrictEqual(rows, [{ status: "completed", submission_digest: null }]);
          assert.strictEqual(
            (yield* store.readRecoverableResolutionTickets({
              memorySpaceId: space,
              now: 30000,
              limit: 100,
            })).length,
            0,
          );
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect("failed renewal SQL write and release retain the authoritative retry floor", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let issued: M.MemoryResolutionLease | undefined;
    let models = 0;
    const client = peer({
      claim: (_c, { protocolVersion: _p, ...claim }) =>
        Effect.sync(() => {
          issued = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return issued;
        }),
      renew: () => Effect.succeed({ ...issued!, expiresAtHubTime: "1970-01-01T00:03:00.000Z" }),
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: false })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.sync(() => {
          models++;
        }).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* conflict();
        const sql = yield* SqlClient.SqlClient;
        yield* sql`CREATE TRIGGER review_renewal_sql_failure BEFORE UPDATE ON memory_outbox WHEN NEW.kind='resolve' AND NEW.ticket_json LIKE '%00:03:00.000Z%' BEGIN SELECT RAISE(ABORT, 'synthetic renewal storage failure'); END`;
        const sync = yield* Sync.MemorySyncService;
        const store = yield* Store.MemoryStore;
        yield* sync.syncOnce;
        yield* Deferred.await(released);
        yield* sync.shutdown;
        const saved = yield* store.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 180000,
          limit: 100,
        });
        assert.strictEqual(saved.length, 1);
        assert.strictEqual(models, 0, "failed persistence must prevent provider input");
        assert.isAtLeast(
          saved[0]!.nextAttemptAt,
          180000,
          "renewal persistence failure must retain known hub expiry",
        );
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

it.effect.each(["pull", "ack"] as const)(
  "commits %s while the real settings provider-history reload is pending",
  (lane) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-l4-settings-" });
        const configLayer = ServerConfig.layerTest(process.cwd(), baseDir);
        const config = yield* ServerConfig.ServerConfig.pipe(Effect.provide(configLayer));
        const defaults = yield* Settings.ServerSettingsService.use((s) => s.getSettings).pipe(
          Effect.provide(Settings.layerTest({}, "memoryHub")),
        );
        const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(M.ServerSettings));
        yield* fs.writeFileString(
          config.settingsPath,
          yield* encodeSettings({ ...defaults, memoryHub: member, memoryHubVersion: 1 }),
        );
        const events = yield* PubSub.bounded<FileSystem.WatchEvent>(4);
        const watching = yield* Deferred.make<void>();
        const eventSeen = yield* Deferred.make<void>();
        const historyRequested = yield* Deferred.make<void>();
        const releaseHistory = yield* Deferred.make<void>();
        let holdHistory = false;
        let completed = 0;
        const controlledFs = FileSystem.FileSystem.of({
          ...fs,
          watch: () =>
            Stream.unwrap(
              PubSub.subscribe(events).pipe(
                Effect.tap(() => Deferred.succeed(watching, undefined)),
                Effect.map(Stream.fromSubscription),
              ),
            ).pipe(Stream.tap(() => Deferred.succeed(eventSeen, undefined))),
        });
        const transformer: Statement.Transformer = (statement) =>
          Effect.gen(function* () {
            if (holdHistory && statement.compile()[0].includes("FROM provider_session_runtime")) {
              yield* Deferred.succeed(historyRequested, undefined);
              yield* Deferred.await(releaseHistory);
            }
            return statement;
          });
        const settingsLayer = Settings.layer.pipe(
          Layer.provideMerge(Secrets.layer),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(configLayer),
        );
        const realCore = Service.layer.pipe(
          Layer.provide(
            Layer.succeed(Settings.MemoryHubCommittedSettings, {
              read: Effect.succeed({
                provenance: null,
                settings: { mode: "hub" as const, memorySpaceId: space },
                version: 1,
              }),
            }),
          ),
          Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
          Layer.provide(identity),
          Layer.provide(
            Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
          Layer.provideMerge(settingsLayer),
        );
        let settings: Settings.ServerSettingsService["Service"];
        const reload = Effect.gen(function* () {
          holdHistory = true;
          const before = yield* settings.getSettings;
          yield* fs.writeFileString(config.settingsPath, yield* encodeSettings(before));
          yield* PubSub.publish(events, { _tag: "Update" as const, path: config.settingsPath });
          yield* Deferred.await(eventSeen);
          yield* TestClock.adjust(100);
          yield* Deferred.await(historyRequested);
        });
        const withReload = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          Effect.gen(function* () {
            yield* reload.pipe(Effect.orDie);
            const result = yield* effect;
            // The real transaction returned before releasing the cache lookup's SQL barrier.
            assert.isTrue(holdHistory);
            completed++;
            holdHistory = false;
            yield* Deferred.succeed(releaseHistory, undefined);
            yield* settings.getSettings.pipe(Effect.orDie);
            return result;
          });
        const observed = Layer.effect(
          Service.MemoryService,
          Effect.gen(function* () {
            const service = yield* Service.MemoryService;
            return Service.MemoryService.of({
              ...service,
              receiveHubPage: (input) =>
                lane === "pull" && completed === 0
                  ? withReload(service.receiveHubPage(input))
                  : service.receiveHubPage(input),
              settleHubAcknowledgement: (input) =>
                lane === "ack" && completed === 0
                  ? withReload(service.settleHubAcknowledgement(input))
                  : service.settleHubAcknowledgement(input),
            });
          }),
        ).pipe(Layer.provide(realCore));
        const realHub = Hub.layer.pipe(
          Layer.provide(realCore),
          Layer.provide(Hub.activityLayer),
          Layer.provide(Layer.succeed(Hub.MemoryHubConfiguration, { read: Effect.succeed(null) })),
        );
        const shared = Layer.mergeAll(
          realCore,
          realHub,
          runtimeBase.pipe(Layer.provide(realCore)),
          identity,
          realGeneration({ resolveMemoryConflict: () => Effect.never }),
          peer(),
        );
        const app = Sync.layer.pipe(
          Layer.provideMerge(observed),
          Layer.provideMerge(shared),
          Layer.provideMerge(
            Layer.merge(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, controlledFs)),
          ),
        );
        const context = yield* Layer.build(app).pipe(
          Effect.provideService(Statement.CurrentTransformer, transformer),
        );
        settings = Context.get(context, Settings.ServerSettingsService);
        yield* settings.start.pipe(
          Effect.provideService(Statement.CurrentTransformer, transformer),
        );
        yield* Deferred.await(watching);
        yield* Effect.gen(function* () {
          yield* ready;
          if (lane === "ack") yield* enqueue(99001);
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* sync.shutdown;
          assert.strictEqual(completed, 1);
          if (lane === "ack")
            assert.strictEqual(
              (yield* (yield* Store.MemoryStore).readWork("sync:99001"))?.status,
              "completed",
            );
        }).pipe(Effect.provideContext(context));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
);

it.effect("resolution rearm passes 100 protected tickets to reach the next held ticket", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.bounded<{
      epoch: number;
      hubEnvironmentId: M.EnvironmentId;
      memorySpaceId: M.MemorySpaceId;
      holdClass: Store.MemoryHoldClass;
    }>(4);
    const entered = yield* Deferred.make<void>();
    const leases = new Map<string, M.MemoryResolutionLease>();
    const client = peer({
      claim: () => Effect.fail(new M.MemoryHubError({ code: "claim_busy" })),
      renew: (_c, input) => Effect.succeed(leases.get(input.attemptId)!),
    });
    let generated = 0;
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.sync(() => {
          generated++;
        }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        const keys: Store.TicketKey[] = [];
        for (let n = 1; n <= 101; n++) {
          const memoryId = yield* conflict(n);
          const aggregate = yield* store.loadAggregate(space, memoryId);
          const ticket: M.MemoryResolutionLease = {
            memorySpaceId: space,
            memoryId,
            conflictId: aggregate.conflicts[0]!.conflictId,
            conflictHeadSet: aggregate.heads,
            attemptId: M.MemoryOperationId.make(id(20000 + n)),
            holderEnvironmentId: local,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            frozenDefaultModelSelection: selection,
          };
          leases.set(ticket.attemptId, ticket);
          yield* store.persistResolutionTicket(ticket);
          const key = { memorySpaceId: space, attemptId: ticket.attemptId };
          keys.push(key);
          if (n <= 100)
            yield* store.transact(
              store.acquireResolutionTicketTx({
                key,
                expectedVersion: 0,
                owner: "protected-fixture-owner",
                coordinatorEpoch: 1,
                now: 0,
                ownedUntil: 120000,
              }),
            );
          // Synthetic scheduling state, with real live ownership and canonical frontiers.
          yield* sql`UPDATE memory_outbox SET hold_class='authorization',failure_code='route_unavailable',next_attempt_at=${Number.MAX_SAFE_INTEGER},ticket_json=json_set(ticket_json,'$.nextAttemptAt',${Number.MAX_SAFE_INTEGER}) WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
        }
        const base = yield* Sync.MemorySyncRuntime;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.start;
            yield* PubSub.publish(events, {
              epoch: 1,
              hubEnvironmentId: remote,
              memorySpaceId: space,
              holdClass: "authorization" as const,
            });
            yield* Deferred.await(entered);
            yield* sync.shutdown;
            assert.strictEqual(generated, 1);
            for (const key of keys.slice(0, 100))
              assert.strictEqual(
                (yield* store.readWorkHold(`resolve:${space}:${key.attemptId}`))?.holdClass,
                "authorization",
              );
            assert.strictEqual(
              (yield* store.readWorkHold(`resolve:${space}:${keys[100]!.attemptId}`))?.holdClass,
              null,
            );
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(
                  Layer.succeed(Sync.MemorySyncRuntime, {
                    ...base,
                    rearmEvents: Stream.fromPubSub(events),
                  }),
                ),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

it.effect("approval metadata without saved bytes never regenerates a resolution", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<void>();
    let generated = 0;
    const client = peer({
      release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
    });
    const model = realGeneration({
      resolveMemoryConflict: () =>
        Effect.sync(() => {
          generated++;
        }).pipe(Effect.andThen(Effect.never)),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const memoryId = yield* conflict();
        const store = yield* Store.MemoryStore;
        const aggregate = yield* store.loadAggregate(space, memoryId);
        const ticket: M.MemoryResolutionLease = {
          memorySpaceId: space,
          memoryId,
          conflictId: aggregate.conflicts[0]!.conflictId,
          conflictHeadSet: aggregate.heads,
          attemptId: M.MemoryOperationId.make(id(50000)),
          holderEnvironmentId: local,
          fencingToken: 1,
          claimedAtHubTime: timestamp,
          expiresAtHubTime: "1970-01-01T00:02:00.000Z",
          attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          frozenDefaultModelSelection: selection,
        };
        yield* store.persistResolutionTicket(ticket);
        const approval: M.MemoryHubReceipt = {
          operationId: M.MemoryOperationId.make(id(50001)),
          memoryId,
          operationDigest: "a".repeat(64),
          outcome: "accepted",
          hubSequence: 1,
          resolutionApproval: {
            resolutionId: M.MemoryResolutionId.make(id(50002)),
            appliedAtUtc: timestamp,
            revertDeadlineUtc: "1970-01-31T00:00:00.000Z",
          },
        };
        const sql = yield* SqlClient.SqlClient;
        // L1 deliberately protects this legacy metadata shape; the coordinator must preserve it too.
        yield* sql`UPDATE memory_outbox SET ticket_json=json_set(ticket_json,'$.state','approved','$.approval',json(${encode(approval)}),'$.reconcileRequired',json('true')) WHERE id=${`resolve:${space}:${ticket.attemptId}`}`;
        const sync = yield* Sync.MemorySyncService;
        yield* sync.syncOnce;
        yield* Deferred.await(released);
        yield* sync.shutdown;
        assert.strictEqual(generated, 0);
        const rows = yield* store.readRecoverableResolutionTickets({
          memorySpaceId: space,
          now: 30000,
          limit: 100,
        });
        assert.strictEqual(rows.length, 1);
        assert.deepStrictEqual(rows[0]!.approval, approval);
        assert.strictEqual(rows[0]!.submission, null);
        assert.strictEqual((yield* store.pendingReports(100)).length, 0);
      }).pipe(Effect.provide(fixture(client, model))),
    );
  }),
);

it.effect.each(["canonical receipt", "saved approval"] as const)(
  "recovered %s rejection preserves retry backoff",
  (source) =>
    Effect.gen(function* () {
      const submitted = yield* Deferred.make<void>();
      const retired = yield* Deferred.make<void>();
      const holdRelease = yield* Deferred.make<void>();
      let saved: M.MemoryHubApplyResolutionInput | undefined;
      let recovering = false;
      let generated = 0;
      let applies = 0;
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            saved = input;
            applies++;
            yield* Deferred.succeed(submitted, undefined);
            return yield* new M.MemoryHubError({ code: "unavailable" });
          }),
        release: () =>
          Effect.gen(function* () {
            if (recovering) {
              yield* Deferred.succeed(retired, undefined);
              yield* Deferred.await(holdRelease);
            }
            return { released: true };
          }),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.sync(() => {
            generated++;
            return {
              result: {
                text: "synthetic canonical rejection",
                assertionKind: "inference" as const,
                evidence: [],
                judgment: "combine synthetic facts",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const memory = yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          yield* Deferred.await(submitted);
          yield* sync.shutdown;
          const store = yield* Store.MemoryStore;
          const original = (yield* store.readRecoverableResolutionTickets({
            memorySpaceId: space,
            now: 30000,
            limit: 100,
          }))[0]!;
          assert.deepStrictEqual(original.submission, saved);
          const op = saved!.operation;
          const receipt: M.MemoryHubReceipt = {
            operationId: op.operationId,
            memoryId: memory,
            operationDigest: memoryOperationDigest(op),
            outcome: "rejected",
            hubSequence: null,
            failureCode: "conflict_changed",
          };
          const sql = yield* SqlClient.SqlClient;
          // Controlled canonical receipt seam; actual Store/Service reconciliation is unchanged.
          if (source === "canonical receipt")
            yield* sql`INSERT INTO memory_import_keys(space,key_kind,key,memory_id,record_json) VALUES(${space},'hubReceipt',${op.operationId},${memory},${encode({ receipt })})`;
          else
            yield* sql`UPDATE memory_outbox SET ticket_json=json_set(ticket_json,'$.approval',json(${encode(receipt)})) WHERE id=${`resolve:${space}:${original.ticket.attemptId}`}`;
          recovering = true;
          yield* TestClock.adjust("30 seconds");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.syncOnce;
              yield* Deferred.await(retired);
              const due = yield* store.readDueClaimCandidates(100, 30000, space);
              assert.strictEqual(generated, 1);
              assert.strictEqual(applies, 1);
              const rows = yield* sql<{
                status: string;
                next_attempt_at: number;
              }>`SELECT status,next_attempt_at FROM memory_outbox WHERE kind='claim' AND memory_id=${memory}`;

              yield* Deferred.succeed(holdRelease, undefined);
              yield* restarted.shutdown;
              assert.strictEqual(due.length, 0, "recovered rejection must retain 30s budget");
              assert.deepStrictEqual(rows, [{ status: "retry", next_attempt_at: 60000 }]);
              assert.strictEqual(
                (yield* store.readDueClaimCandidates(100, 59999, space)).length,
                0,
              );
              assert.strictEqual(
                (yield* store.readDueClaimCandidates(100, 60000, space)).length,
                1,
              );
            }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
          );
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);
it.effect.each([
  ["protocol", "credential"],
  ["authorization", "credential"],
  ["protocol", "hub"],
] as const)(
  "unfinished rearm follows only a valid binding across transition %s",
  ([holdClass, change]) =>
    Effect.gen(function* () {
      const events = yield* PubSub.bounded<{
        epoch: number;
        hubEnvironmentId: M.EnvironmentId;
        memorySpaceId: M.MemorySpaceId;
        holdClass: Store.MemoryHoldClass;
      }>(4);
      const firstPage = yield* Deferred.make<void>();
      const newEpoch = yield* Deferred.make<void>();
      let observing = false;
      let blocked = false;
      const client = peer({
        pull: (_c, input) =>
          Effect.gen(function* () {
            if (observing && !blocked) {
              blocked = true;
              yield* Deferred.succeed(firstPage, undefined);
              return yield* Effect.never;
            }
            if (observing) yield* Deferred.succeed(newEpoch, undefined);
            return {
              highWatermark: input.afterSequence,
              throughSequence: input.afterSequence,
              hasMore: false,
              entries: [],
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          const sql = yield* SqlClient.SqlClient;
          const store = yield* Store.MemoryStore;
          const base = yield* Sync.MemorySyncRuntime;
          // Actual work payloads, synthetic initial permanent holds. The service owns all rearm transitions.
          for (let n = 9200; n < 9303; n++) yield* enqueue(n, M.MemoryId.make(id(n + 10000)));
          yield* sql`UPDATE memory_outbox SET hold_class=${holdClass},failure_code='invalid_output',status='retry',next_attempt_at=${Number.MAX_SAFE_INTEGER} WHERE kind='sync'`;
          yield* sql`UPDATE memory_outbox SET hold_class='identity' WHERE id='sync:9301'`;
          yield* sql`UPDATE memory_outbox SET hold_class='authorization' WHERE id='sync:9302'`;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const sync = yield* Sync.MemorySyncService;
              yield* sync.start;
              observing = true;
              yield* PubSub.publish(events, {
                epoch: 1,
                hubEnvironmentId: remote,
                memorySpaceId: space,
                holdClass,
              });
              yield* Deferred.await(firstPage);
              assert.strictEqual(
                (yield* sql`SELECT id FROM memory_outbox WHERE kind='sync' AND hold_class=${holdClass} AND id<='sync:9300'`)
                  .length,
                1,
              );
              assert.strictEqual((yield* store.readWorkHold("sync:9300"))?.holdClass, holdClass);
              if (change === "hub")
                yield* sql`INSERT INTO memory_sync_cursors(space,hub_environment_id,after_sequence,bootstrap_state) VALUES (${space},'fixture-other-hub',0,'ready')`;
              yield* changeHub(
                1,
                change === "credential"
                  ? { ...member, secretName: "memory-hub-fixture-next" }
                  : { ...member, hubEnvironmentId: M.EnvironmentId.make("fixture-other-hub") },
              );
              yield* Deferred.await(newEpoch);
              yield* sync.syncOnce;
              yield* sync.shutdown;
              assert.strictEqual(
                (yield* store.readWorkHold("sync:9300"))?.holdClass,
                change === "credential" ? null : "protocol",
                "101st row follows the observation only for the same space/hub",
              );
              assert.strictEqual(
                (yield* store.readWorkHold("sync:9302"))?.holdClass,
                null,
                "credential change supplies authorization observation",
              );
              assert.strictEqual(
                (yield* store.readWorkHold("sync:9301"))?.holdClass,
                change === "credential" ? "identity" : null,
              );
              assert.strictEqual(
                (yield* sql`SELECT id FROM memory_outbox WHERE kind='sync' AND status='completed'`)
                  .length,
                102,
              );
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(
                    Layer.succeed(Sync.MemorySyncRuntime, {
                      ...base,
                      rearmEvents: Stream.fromPubSub(events),
                    }),
                  ),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client, undefined, false, true))),
      );
    }),
);

it.effect.each([
  ["authorization", true, false, false],
  ["authorization", false, false, false],
  ["identity", true, false, false],
  ["identity", false, false, false],
  ["authorization", true, true, false],
  ["authorization", false, true, false],
  ["identity", true, true, false],
  ["identity", false, true, false],
  ["authorization", true, false, true],
  ["identity", true, false, true],
] as const)(
  "permanent ticket refusal pairs %s holds (released=%s, parallel=%s) across restart and matching rearm (splitPage=%s)",
  ([holdClass, released, parallel, splitPage]) =>
    Effect.gen(function* () {
      const events = yield* PubSub.bounded<{
        epoch: number;
        hubEnvironmentId: M.EnvironmentId;
        memorySpaceId: M.MemorySpaceId;
        holdClass: Store.MemoryHoldClass;
      }>(4);
      const held = yield* Deferred.make<void>();
      const entered = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<M.ResolveMemoryConflictInput>();
      let lease: M.MemoryResolutionLease | undefined;
      let renews = 0;
      let claims = 0;
      let generations = 0;
      let refused = false;
      let premature = false;
      let sqlObserver: SqlClient.SqlClient | undefined;
      const client = peer({
        claim: (_c, { protocolVersion: _protocol, ...claim }) =>
          Effect.gen(function* () {
            claims++;
            if (claims > 1 && sqlObserver) {
              const rows = yield* sqlObserver<{
                hold_class: string | null;
              }>`SELECT hold_class FROM memory_outbox WHERE kind='resolve'`.pipe(Effect.orDie);
              premature ||= rows.some((row) => row.hold_class !== null);
            }
            lease = {
              ...claim,
              fencingToken: 1,
              claimedAtHubTime: timestamp,
              expiresAtHubTime: "1970-01-01T00:02:00.000Z",
              attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
            };
            return lease;
          }),
        renew: () =>
          Effect.gen(function* () {
            renews++;
            if (!refused && (!parallel || renews === 2)) {
              refused = true;
              return yield* holdClass === "authorization"
                ? new M.MemoryHubUnauthorizedError({})
                : new M.MemoryHubError({ code: "identity_mismatch" });
            }
            return lease!;
          }),
        release: () => Deferred.succeed(held, undefined).pipe(Effect.as({ released })),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.gen(function* () {
            generations++;
            if (parallel && generations === 1) yield* Deferred.succeed(entered, undefined);
            else yield* Deferred.succeed(resumed, input);
            return yield* Effect.never;
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          sqlObserver = sql;
          const first = yield* Sync.MemorySyncService;
          yield* first.syncOnce;
          if (parallel) {
            yield* Deferred.await(entered);
            yield* TestClock.adjust("30 seconds");
          }
          yield* Deferred.await(held);
          yield* first.shutdown;
          const pair = yield* sql<{
            id: string;
            kind: string;
            hold_class: string | null;
            next_attempt_at: number;
            frozen_claim_json: string | null;
            ticket_json: string | null;
            attempt: number;
          }>`SELECT id,kind,hold_class,next_attempt_at,frozen_claim_json,ticket_json,attempt FROM memory_outbox WHERE kind IN ('claim','resolve') AND status!='completed' ORDER BY id`;
          assert.strictEqual(pair.length, 2);
          for (const row of pair) {
            assert.strictEqual(row.hold_class, holdClass);
            assert.strictEqual(row.next_attempt_at, Number.MAX_SAFE_INTEGER);
          }
          assert.strictEqual((yield* store.pendingReports(100)).length, 0);
          const frozen = pair.find((row) => row.kind === "claim")!;
          const attemptId = lease!.attemptId;
          const base = yield* Sync.MemorySyncRuntime;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const restarted = yield* Sync.MemorySyncService;
              yield* restarted.start;
              yield* TestClock.adjust("30 seconds");
              yield* restarted.syncOnce;
              assert.deepStrictEqual(
                yield* sql`SELECT id,kind,hold_class,next_attempt_at,frozen_claim_json,ticket_json,attempt FROM memory_outbox WHERE kind IN ('claim','resolve') AND status!='completed' ORDER BY id`,
                pair,
              );
              yield* PubSub.publish(events, {
                epoch: 1,
                hubEnvironmentId: remote,
                memorySpaceId: space,
                holdClass:
                  holdClass === "authorization"
                    ? ("identity" as const)
                    : ("authorization" as const),
              });
              yield* restarted.syncOnce;
              assert.deepStrictEqual(
                yield* sql`SELECT id,kind,hold_class,next_attempt_at,frozen_claim_json,ticket_json,attempt FROM memory_outbox WHERE kind IN ('claim','resolve') AND status!='completed' ORDER BY id`,
                pair,
              );
              assert.strictEqual(claims, 1);
              if (splitPage) {
                // Completed history consumes the visited-page budget, not eligible work.
                const ticketId = `resolve:${space}:${attemptId}`;
                for (let n = 0; n < 100; n++) {
                  const middleId = `middle:${n.toString().padStart(3, "0")}`;
                  assert.isTrue(frozen.id < middleId && middleId < ticketId);
                  yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,next_attempt_at) SELECT ${middleId},space,memory_id,kind,'completed',metadata_json,0 FROM memory_outbox WHERE id=${frozen.id}`;
                }
                const firstPage = yield* sql<{
                  id: string;
                }>`SELECT id FROM memory_outbox ORDER BY id LIMIT 100`;
                assert.isTrue(firstPage.some((row) => row.id === frozen.id));
                assert.isFalse(firstPage.some((row) => row.id === ticketId));
              }
              yield* PubSub.publish(events, {
                epoch: 1,
                hubEnvironmentId: remote,
                memorySpaceId: space,
                holdClass,
              });
              const input = yield* Deferred.await(resumed);
              yield* restarted.syncOnce;
              assert.deepStrictEqual(input.modelSelection, selection);
              assert.isFalse(premature, "Hub claim occurred while matching ticket remained held");
              assert.strictEqual(claims, 1);
              assert.strictEqual(generations, parallel ? 2 : 1);
              const resumedCandidate = yield* store.findClaimCandidate({
                memorySpaceId: space,
                attemptId,
              });
              assert.strictEqual(resumedCandidate?.id, frozen.id);
              assert.strictEqual(resumedCandidate?.attempt, frozen.attempt);
              assert.strictEqual(
                (yield* sql<{
                  frozen_claim_json: string;
                }>`SELECT frozen_claim_json FROM memory_outbox WHERE id=${frozen.id}`)[0]
                  ?.frozen_claim_json,
                frozen.frozen_claim_json,
              );
              for (const row of pair) assert.isNull((yield* store.readWorkHold(row.id))?.holdClass);
              const ticket = (yield* sql<{
                attemptId: string;
                model: string;
              }>`SELECT json_extract(ticket_json,'$.ticket.attemptId') AS attemptId,json_extract(ticket_json,'$.ticket.frozenDefaultModelSelection') AS model FROM memory_outbox WHERE id=${`resolve:${space}:${attemptId}`}`)[0];
              assert.strictEqual(ticket?.attemptId, attemptId);
              assert.deepStrictEqual(JSON.parse(ticket!.model), selection);
              assert.strictEqual((yield* store.pendingReports(100)).length, 0);
              yield* restarted.shutdown;
            }).pipe(
              Effect.provide(
                Layer.fresh(Sync.layer).pipe(
                  Layer.provide(
                    Layer.succeed(Sync.MemorySyncRuntime, {
                      ...base,
                      rearmEvents: Stream.fromPubSub(events),
                    }),
                  ),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect.each(["stale-candidate", "ticket-write-failure"] as const)(
  "permanent ticket refusal preserves the pair on %s without ticket-only fallback",
  (failure) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const refuse = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const client = peer({
        renew: () =>
          Deferred.succeed(entered, undefined).pipe(
            Effect.andThen(Deferred.await(refuse)),
            Effect.andThen(Effect.fail(new M.MemoryHubUnauthorizedError({}))),
          ),
        release: () => Deferred.succeed(released, undefined).pipe(Effect.as({ released: true })),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          yield* sync.syncOnce;
          yield* Deferred.await(entered);
          if (failure === "stale-candidate") {
            // Simulate a newer acquisition after the coordinator captured its lineage.
            yield* sql`UPDATE memory_outbox SET attempt=attempt+1 WHERE kind='claim'`;
          } else {
            yield* sql`CREATE TEMP TRIGGER fixture_pair_hold_abort BEFORE UPDATE ON memory_outbox WHEN NEW.kind='resolve' AND NEW.hold_class='authorization' BEGIN SELECT RAISE(ABORT,'synthetic pair hold failure'); END`;
          }
          const before =
            yield* sql`SELECT * FROM memory_outbox WHERE kind IN ('claim','resolve') ORDER BY id`;
          yield* Deferred.succeed(refuse, undefined);
          yield* Deferred.await(released);
          yield* sync.shutdown;
          assert.deepStrictEqual(
            yield* sql`SELECT * FROM memory_outbox WHERE kind IN ('claim','resolve') ORDER BY id`,
            before,
          );
          assert.strictEqual((yield* store.pendingReports(100)).length, 0);
          if (failure === "ticket-write-failure") yield* sql`DROP TRIGGER fixture_pair_hold_abort`;
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);

it.effect.each(["bootstrap", "exchange"] as const)(
  "automatic hub initialization bootstraps its own replica without HTTP: %s",
  (phase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const settingsLayer = Settings.layer.pipe(
          Layer.provideMerge(Secrets.layer),
          Layer.provideMerge(Sqlite.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "goat-l4-self-bootstrap-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        );
        const selfCore = Service.layer.pipe(
          Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
          Layer.provideMerge(settingsLayer),
          Layer.provideMerge(identity),
          Layer.provide(
            Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
              resolve: () => Effect.succeed(null),
            }),
          ),
        );
        const selfHub = Layer.merge(Hub.layer, Hub.administratorLayer).pipe(
          Layer.provideMerge(Hub.activityLayer),
          Layer.provide(
            Layer.effect(
              Hub.MemoryHubConfiguration,
              Effect.gen(function* () {
                const committed = yield* Settings.MemoryHubCommittedSettings;
                return Hub.MemoryHubConfiguration.of({
                  read: committed.read.pipe(
                    Effect.map((s) =>
                      s.settings.mode === "hub" && s.settings.memorySpaceId
                        ? { memorySpaceId: s.settings.memorySpaceId, hubEnvironmentId: local }
                        : null,
                    ),
                  ),
                });
              }),
            ),
          ),
          Layer.provideMerge(selfCore),
        );
        const app = Sync.layer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              selfHub,
              runtimeBase.pipe(Layer.provide(selfCore)),
              realGeneration({ resolveMemoryConflict: () => Effect.never }),
              peer({
                join: () => Effect.die("self HTTP join forbidden"),
                pull: () => Effect.die("self HTTP pull forbidden"),
                push: () => Effect.die("self HTTP push forbidden"),
              }),
            ),
          ),
        );
        const context = yield* Layer.build(app);
        yield* Effect.gen(function* () {
          yield* (yield* Settings.ServerSettingsService).start;
          const admin = yield* Hub.MemoryHubAdministrator;
          const sync = yield* Sync.MemorySyncService;
          const backend = yield* Hub.MemoryHubAdminSettings;
          assert.deepStrictEqual(yield* backend.readPublication, { state: "current" });
          yield* sync.start;
          assert.deepStrictEqual(yield* backend.readPublication, { state: "current" });
          yield* sync.initializeDefaultHub;
          yield* sync.initializeDefaultHub;
          const configured = yield* sync.getHubSettings({}, Effect.void);
          if (configured.settings.mode !== "hub" || !configured.settings.memorySpaceId)
            throw new Error("fixture hub configure");
          const allocated = configured.settings.memorySpaceId;
          assert.isFalse(Object.hasOwn(configured, "provenance"));
          assert.deepStrictEqual((yield* backend.read).provenance, {
            source: "auto-initialized",
            memorySpaceId: allocated,
          });
          assert.strictEqual(configured.version, 1);
          const store = yield* Store.MemoryStore;
          assert.deepStrictEqual(yield* sync.readLocalReadiness(), {
            memorySpaceId: allocated,
            bootstrap: "ready",
          });
          if (phase === "bootstrap") {
            yield* sync.shutdown;
            return;
          }
          // Both directions cross authoritative HubService admission; no ready seed or SQL membership seed.
          const hub = yield* Hub.MemoryHubService;
          const service = yield* Service.MemoryService;
          const h = operation(98001, M.MemoryId.make(id(98002)));
          if (h.kind !== "upsert") throw new Error("fixture upsert");
          const hOp = {
            ...h,
            memorySpaceId: allocated,
            revision: { ...h.revision, memorySpaceId: allocated },
          };
          yield* service.upsert(
            {
              memorySpaceId: allocated,
              memoryId: hOp.memoryId,
              operationId: hOp.operationId,
              expectedHeads: [],
              scope: { kind: "user" },
              assertionKind: "inference",
              payload: hOp.payload,
              baseBoundary: null,
            },
            Effect.void,
          );
          yield* sync.syncOnce;
          const provisioned = yield* admin.update(
            {
              requestId: M.MemoryOperationId.make(id(98003)),
              expectedVersion: configured.version,
              action: "provisionMember",
              environmentId: remote,
            },
            Effect.void,
          );
          assert.isNotNull(provisioned.credential);
          const principal: M.MemoryHubPrincipal = {
            memorySpaceId: allocated,
            environmentId: remote,
            credentialVersion: 1,
            scopes: ["memory:sync"],
          };
          const aSettings = Settings.layerTest(
            {
              memoryHub: { ...member, memorySpaceId: allocated, hubEnvironmentId: local },
              memoryHubVersion: 1,
              memoryModelSelection: selection,
              providerInstances: fixtureInstances,
            },
            "memoryHub",
          );
          const aCommitted = Layer.effect(
            Settings.MemoryHubCommittedSettings,
            Effect.serviceOption(Settings.MemoryHubCommittedSettings).pipe(
              Effect.map(Option.getOrThrow),
            ),
          ).pipe(Layer.provide(aSettings));
          const aCore = Service.layer.pipe(
            Layer.provide(
              Layer.succeed(Settings.MemoryHubCommittedSettings, {
                read: Effect.succeed({
                  provenance: null,
                  settings: { mode: "hub" as const, memorySpaceId: space },
                  version: 1,
                }),
              }),
            ),
            Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Layer.fresh(storage)))),
            Layer.provideMerge(Layer.merge(aSettings, aCommitted)),
            Layer.provideMerge(
              Layer.succeed(Environment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(remote),
              }),
            ),
            Layer.provide(
              Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
                resolve: () => Effect.succeed(null),
              }),
            ),
          );
          const aHub = Hub.layer.pipe(
            Layer.provideMerge(Hub.activityLayer),
            Layer.provide(
              Layer.succeed(Hub.MemoryHubConfiguration, { read: Effect.succeed(null) }),
            ),
            Layer.provide(aCore),
          );
          // A has a separate real SQLite replica and coordinator. Only its transport is an in-process bridge.
          const aClient = peer({
            join: (_c, input) =>
              hub
                .join(input, principal)
                .pipe(
                  Effect.mapError((e) =>
                    e._tag === "MemoryHubError" ||
                    e._tag === "MemoryHubUnauthorizedError" ||
                    e._tag === "MemoryHubForbiddenError"
                      ? e
                      : new M.MemoryHubError({ code: "storage_failed" }),
                  ),
                ),
            pull: (_c, input) =>
              hub
                .pull(input, principal)
                .pipe(
                  Effect.mapError((e) =>
                    e._tag === "MemoryHubError" ||
                    e._tag === "MemoryHubUnauthorizedError" ||
                    e._tag === "MemoryHubForbiddenError"
                      ? e
                      : new M.MemoryHubError({ code: "storage_failed" }),
                  ),
                ),
            push: (_c, input) =>
              hub
                .push(input, principal)
                .pipe(
                  Effect.mapError((e) =>
                    e._tag === "MemoryHubError" ||
                    e._tag === "MemoryHubUnauthorizedError" ||
                    e._tag === "MemoryHubForbiddenError"
                      ? e
                      : new M.MemoryHubError({ code: "storage_failed" }),
                  ),
                ),
          });
          const aApp = Sync.layer.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                aCore,
                aHub,
                runtimeBase.pipe(Layer.provide(aCore)),
                realGeneration({ resolveMemoryConflict: () => Effect.never }),
                aClient,
              ),
            ),
          );
          const aContext = yield* Layer.build(aApp);
          yield* Effect.gen(function* () {
            const aSync = yield* Sync.MemorySyncService;
            const aService = yield* Service.MemoryService;
            const aStore = yield* Store.MemoryStore;
            assert.notStrictEqual(aStore, store);
            yield* aSync.start;
            assert.deepStrictEqual(yield* aSync.readLocalReadiness(), {
              memorySpaceId: allocated,
              bootstrap: "ready",
            });
            const fromH = (yield* aService.list(
              {
                memorySpaceId: allocated,
                scope: { kind: "user" },
                limit: 20,
                includeQuarantined: false,
              },
              Effect.void,
            )).items.find((i) => i.memoryId === hOp.memoryId);
            if (fromH?.status !== "active") throw new Error("H write missing from A replica");
            assert.strictEqual(fromH.payload.text, "synthetic fact 98001");
            const before = yield* store.readCursor(allocated, local);
            const aMemory = M.MemoryId.make(id(98005));
            yield* aService.upsert(
              {
                memorySpaceId: allocated,
                memoryId: aMemory,
                operationId: M.MemoryOperationId.make(id(98004)),
                expectedHeads: [],
                scope: { kind: "user" },
                assertionKind: "inference",
                payload: { text: "A local write", evidence: [], derivedFromMemoryRevisions: [] },
                baseBoundary: null,
              },
              Effect.void,
            );
            yield* aSync.syncOnce;
            yield* sync.syncOnce;
            assert.isAbove(yield* store.readCursor(allocated, local), before);
            const received = (yield* service.list(
              {
                memorySpaceId: allocated,
                scope: { kind: "user" },
                limit: 20,
                includeQuarantined: false,
              },
              Effect.void,
            )).items.find((i) => i.memoryId === aMemory);
            if (received?.status !== "active") throw new Error("A write missing from H replica");
            assert.strictEqual(received.payload.text, "A local write");
            yield* aSync.shutdown;
          }).pipe(Effect.provideContext(aContext));
          yield* sync.shutdown;
        }).pipe(Effect.provideContext(context));
      }),
    ),
);

const recoveredDescriptor: M.ExecutionEnvironmentDescriptor = {
  environmentId: remote,
  label: "fixture",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1",
  capabilities: { memoryHubProtocolVersion: 1, repositoryIdentity: false },
};
const persistPullHold = (c: Store.MemoryHoldClass) =>
  Effect.gen(function* () {
    const store = yield* Store.MemoryStore;
    yield* store.transact(
      store.writePullRetryTx({
        memorySpaceId: space,
        hubEnvironmentId: remote,
        expectedVersion: 0,
        retry: {
          attempts: 1,
          nextAttemptAt: Number.MAX_SAFE_INTEGER,
          failureCode: "bootstrap_required",
          holdClass: c,
        },
      }),
    );
  });
it.effect.each(["availability", "protocol", "identity"] as const)(
  "real descriptor recovery probe releases only the held pull class: %s",
  (c) =>
    Effect.gen(function* () {
      let probes = 0;
      let pulls = 0;
      const pulled = yield* Deferred.make<void>();
      const client = peer({
        preflight: () =>
          Effect.sync(() => {
            probes++;
            return recoveredDescriptor;
          }),
        pull: () =>
          Deferred.succeed(pulled, undefined).pipe(
            Effect.andThen(
              Effect.sync(() => {
                pulls++;
                return { highWatermark: 0, throughSequence: 0, hasMore: false, entries: [] };
              }),
            ),
          ),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* persistPullHold(c);
          const store = yield* Store.MemoryStore;
          yield* enqueue(98100);
          // An unrelated authorization hold must survive the descriptor observation.
          const candidate = (yield* store.readEligibleOutbox(space, 0, 1))[0]!;
          yield* store.transact(
            Effect.gen(function* () {
              const acquired = yield* store.acquireSyncWorkTx({
                workId: candidate.work.id,
                operationId: candidate.operationId,
                operationDigest: candidate.operationDigest,
                expectedVersion: candidate.version,
                owner: "fixture",
                now: 0,
                ownedUntil: 30000,
              });
              yield* store.retrySyncWorkTx({
                ownership: acquired!,
                now: 0,
                nextAttemptAt: Number.MAX_SAFE_INTEGER,
                failureCode: "route_unavailable",
                holdClass: "authorization",
              });
            }),
          );
          const sync = yield* Sync.MemorySyncService;
          yield* sync.start;
          assert.strictEqual(pulls, 0);
          yield* TestClock.adjust(29999);
          assert.strictEqual(probes, 0);
          assert.strictEqual(
            (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
              .holdClass,
            c,
          );
          yield* TestClock.adjust(1);
          yield* Deferred.await(pulled);
          yield* sync.syncOnce;
          assert.strictEqual(probes, 1);
          assert.isAtLeast(pulls, 1);
          assert.isNull(
            (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
              .holdClass,
          );
          assert.strictEqual((yield* store.readWorkHold("sync:98100"))?.holdClass, "authorization");
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);
it.effect(
  "failed recovery probes back off from 30 seconds to a 15 minute cap without releasing holds",
  () =>
    Effect.gen(function* () {
      const times: number[] = [];
      const client = peer({
        preflight: () =>
          Effect.gen(function* () {
            times.push(yield* Clock.currentTimeMillis);
            return yield* new M.MemoryHubError({ code: "unavailable" });
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* persistPullHold("availability");
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          yield* sync.start;
          for (const delay of [30000, 60000, 120000, 240000, 480000, 900000, 900000]) {
            const previous = times.length;
            yield* TestClock.adjust(delay - 1);
            assert.strictEqual(times.length, previous);
            yield* TestClock.adjust(1);
            assert.strictEqual(times.length, previous + 1);
          }
          assert.deepStrictEqual(times, [30000, 90000, 210000, 450000, 930000, 1830000, 2730000]);
          assert.strictEqual(
            (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
              .holdClass,
            "availability",
          );
          yield* sync.shutdown;
          yield* TestClock.adjust(900000);
          assert.strictEqual(times.length, 7);
        }).pipe(Effect.provide(fixture(client))),
      );
    }),
);
it.effect("authorization pull hold never probes the public descriptor", () =>
  Effect.gen(function* () {
    let probes = 0;
    const client = peer({
      preflight: () =>
        Effect.sync(() => {
          probes++;
          return recoveredDescriptor;
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* persistPullHold("authorization");
        const sync = yield* Sync.MemorySyncService;
        yield* sync.start;
        yield* TestClock.adjust(900000);
        yield* sync.syncOnce;
        const store = yield* Store.MemoryStore;
        assert.strictEqual(probes, 0);
        assert.strictEqual(
          (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
            .holdClass,
          "authorization",
        );
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);
it.effect.each(["epoch", "shutdown"] as const)(
  "inflight recovery probe is cancelled on %s",
  (boundary) =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      let probes = 0;
      const client = peer({
        preflight: () =>
          Effect.gen(function* () {
            probes++;
            yield* Deferred.succeed(entered, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* persistPullHold("identity");
          const sync = yield* Sync.MemorySyncService;
          const store = yield* Store.MemoryStore;
          yield* sync.start;
          yield* TestClock.adjust(30000);
          yield* Deferred.await(entered);
          if (boundary === "epoch") yield* changeHub(1, { mode: "disabled" });
          else yield* sync.shutdown;
          yield* Deferred.await(interrupted);
          yield* TestClock.adjust(900000);
          assert.strictEqual(probes, 1);
          assert.strictEqual(
            (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
              .holdClass,
            "identity",
          );
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client, undefined, false, true))),
      );
    }),
);

it.effect("a real permanent pull failure recovers in the same epoch through preflight", () =>
  Effect.gen(function* () {
    let healthy = false;
    let probes = 0;
    let pulls = 0;
    const resumed = yield* Deferred.make<void>();
    const client = peer({
      preflight: () =>
        Effect.sync(() => {
          probes++;
          return recoveredDescriptor;
        }),
      pull: () =>
        Effect.gen(function* () {
          pulls++;
          if (!healthy) return yield* new M.MemoryHubError({ code: "bootstrap_required" });
          yield* Deferred.succeed(resumed, undefined);
          return { highWatermark: 0, throughSequence: 0, hasMore: false, entries: [] };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const store = yield* Store.MemoryStore;
        const sync = yield* Sync.MemorySyncService;
        yield* sync.start;
        assert.strictEqual(pulls, 1);
        assert.strictEqual(
          (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
            .holdClass,
          "availability",
        );
        healthy = true;
        yield* sync.syncOnce;
        assert.strictEqual(pulls, 1, "manual cycle alone cannot fabricate recovery");
        yield* TestClock.adjust(30000);
        assert.strictEqual(probes, 1);
        yield* Deferred.await(resumed);
        yield* sync.syncOnce;
        assert.isAbove(pulls, 1);
        assert.isNull(
          (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
            .holdClass,
        );
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("persisted push-only protocol hold is probed after coordinator restart", () =>
  Effect.gen(function* () {
    let healthy = false;
    let pushes = 0;
    let probes = 0;
    const resumed = yield* Deferred.make<void>();
    const client = peer({
      preflight: () =>
        Effect.sync(() => {
          probes++;
          return recoveredDescriptor;
        }),
      push: (_c, input) =>
        Effect.gen(function* () {
          pushes++;
          if (!healthy) return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
          const sent = input.operations[0]!;
          assert.strictEqual(sent.kind, "upsert");
          if (sent.kind !== "upsert") throw new Error("expected upsert");
          assert.strictEqual(sent.payload.text, "synthetic fact 98200");
          yield* Deferred.succeed(resumed, undefined);
          return {
            receipts: input.operations.map((op) => ({
              operationId: op.operationId,
              memoryId: op.memoryId,
              operationDigest: memoryOperationDigest(op),
              hubSequence: 1,
              outcome: "accepted" as const,
            })),
          };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* enqueue(98200);
        const store = yield* Store.MemoryStore;
        const first = yield* Sync.MemorySyncService;
        yield* first.start;
        assert.strictEqual(pushes, 1);
        assert.strictEqual((yield* store.readWorkHold("sync:98200"))?.holdClass, "protocol");
        assert.isNull(
          (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
            .holdClass,
        );
        yield* first.shutdown;
        healthy = true;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const restarted = yield* Sync.MemorySyncService;
            yield* restarted.start;
            yield* restarted.syncOnce;
            assert.strictEqual(pushes, 1, "healthy pull cannot release a persisted push hold");
            yield* TestClock.adjust(29999);
            assert.strictEqual(probes, 0);
            yield* TestClock.adjust(1);
            assert.strictEqual(probes, 1, "fresh coordinator discovers the non-pull class");
            yield* Deferred.await(resumed);
            yield* restarted.syncOnce;
            assert.strictEqual(pushes, 2);
            assert.isNull((yield* store.readWorkHold("sync:98200"))?.holdClass);
            const sql = yield* SqlClient.SqlClient;
            assert.deepStrictEqual(
              yield* sql`SELECT status FROM memory_outbox WHERE id='sync:98200'`,
              [{ status: "completed" }],
            );
            yield* restarted.shutdown;
          }).pipe(Effect.provide(Layer.fresh(Sync.layer))),
        );
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("paged rearm keeps a later same-class failure registered until a real probe ACK", () =>
  Effect.gen(function* () {
    let healthy = false;
    let probes = 0;
    let pushes = 0;
    const client = peer({
      preflight: () =>
        Effect.sync(() => {
          probes++;
          return recoveredDescriptor;
        }),
      push: (_c, input) =>
        Effect.gen(function* () {
          pushes++;
          assert.strictEqual(input.operations.length, 1);
          const sent = input.operations[0]!;
          assert.strictEqual(sent.kind, "upsert");
          if (sent.kind !== "upsert") throw new Error("expected upsert");
          assert.strictEqual(sent.payload.text, "synthetic fact 98200");
          if (!healthy) return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
          return {
            receipts: input.operations.map((op) => ({
              operationId: op.operationId,
              memoryId: op.memoryId,
              operationDigest: memoryOperationDigest(op),
              hubSequence: 1,
              outcome: "accepted" as const,
            })),
          };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* enqueue(98200);
        const store = yield* Store.MemoryStore;
        const sql = yield* SqlClient.SqlClient;
        // Completed history sorts after the only push; raw rearm must consume two pages.
        for (let n = 0; n < 101; n++) {
          const historyId = `zz-history:${String(n).padStart(3, "0")}`;
          yield* sql`INSERT INTO memory_outbox(id,space,memory_id,kind,status,metadata_json,next_attempt_at) SELECT ${historyId},space,memory_id,kind,'completed',metadata_json,0 FROM memory_outbox WHERE id='sync:98200'`;
        }
        assert.deepStrictEqual(
          yield* sql`SELECT count(*) AS count FROM memory_outbox WHERE id>='sync:98200'`,
          [{ count: 102 }],
        );
        const sync = yield* Sync.MemorySyncService;
        yield* sync.start;
        assert.strictEqual(pushes, 1);
        assert.strictEqual((yield* store.readWorkHold("sync:98200"))?.holdClass, "protocol");
        yield* TestClock.adjust(30000);
        yield* sync.syncOnce;
        assert.strictEqual(probes, 1);
        assert.strictEqual(pushes, 2, "first page retries and fails before final page finishes");
        assert.strictEqual((yield* store.readWorkHold("sync:98200"))?.holdClass, "protocol");
        healthy = true;
        yield* sync.syncOnce;
        assert.strictEqual(pushes, 2, "pull/manual sync cannot release the new permanent hold");
        yield* TestClock.adjust(29999);
        assert.strictEqual(probes, 1);
        yield* TestClock.adjust(1);
        assert.strictEqual(probes, 2, "final rearm page must retain the later failure's probe");
        yield* sync.syncOnce;
        assert.strictEqual(pushes, 3);
        assert.isNull((yield* store.readWorkHold("sync:98200"))?.holdClass);
        assert.strictEqual((yield* store.readWork("sync:98200"))?.status, "completed");
        yield* sync.shutdown;
        yield* TestClock.adjust(900000);
        assert.strictEqual(probes, 2);
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("a same-class failure during preflight supersedes the observed recovery generation", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let probes = 0;
    let pushes = 0;
    let healthy = false;
    const client = peer({
      preflight: () =>
        Effect.gen(function* () {
          probes++;
          if (probes === 1) {
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
          }
          return recoveredDescriptor;
        }),
      push: (_c, input) =>
        Effect.gen(function* () {
          pushes++;
          if (!healthy) return yield* new M.MemoryHubError({ code: "unsupported_protocol" });
          return {
            receipts: input.operations.map((op, n) => ({
              operationId: op.operationId,
              memoryId: op.memoryId,
              operationDigest: memoryOperationDigest(op),
              hubSequence: n + 1,
              outcome: "accepted" as const,
            })),
          };
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* enqueue(98200);
        const store = yield* Store.MemoryStore;
        const sync = yield* Sync.MemorySyncService;
        yield* sync.start;
        yield* TestClock.adjust(30000);
        yield* Deferred.await(entered);
        // A different work item fails with the same class while its descriptor is in flight.
        yield* enqueue(98201, M.MemoryId.make(id(3)));
        yield* sync.syncOnce;
        assert.strictEqual(pushes, 2);
        healthy = true;
        yield* Deferred.succeed(release, undefined);
        yield* TestClock.adjust(29999);
        yield* sync.syncOnce;
        assert.strictEqual(probes, 1);
        assert.strictEqual(pushes, 2, "old observation cannot settle the newer failure");
        assert.strictEqual((yield* store.readWorkHold("sync:98201"))?.holdClass, "protocol");
        yield* TestClock.adjust(1);
        assert.strictEqual(probes, 2, "one retained scheduler probes the new generation");
        yield* sync.syncOnce;
        assert.strictEqual(pushes, 4, "each of the two held operations gets its own ACK");
        for (const n of [98200, 98201]) {
          assert.isNull((yield* store.readWorkHold(`sync:${n}`))?.holdClass);
          assert.strictEqual((yield* store.readWork(`sync:${n}`))?.status, "completed");
        }
        yield* sync.shutdown;
      }).pipe(Effect.provide(fixture(client))),
    );
  }),
);

it.effect("hold discovery runs once per committed epoch, not per manual or periodic sync", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      const store = yield* Store.MemoryStore;
      const second = yield* Deferred.make<void>();
      const reads: { memorySpaceId: M.MemorySpaceId; hubEnvironmentId: M.EnvironmentId }[] = [];
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          yield* sync.start;
          yield* sync.start;
          yield* sync.syncOnce;
          yield* TestClock.adjust(30000);
          assert.strictEqual(reads.length, 1);
          yield* changeHub(1, { ...member, secretName: "memory-hub-fixture-next" });
          yield* Deferred.await(second);
          yield* sync.syncOnce;
          yield* sync.syncOnce;
          assert.deepStrictEqual(reads, [
            { memorySpaceId: space, hubEnvironmentId: remote },
            { memorySpaceId: space, hubEnvironmentId: remote },
          ]);
          yield* sync.shutdown;
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(
                Layer.succeed(Store.MemoryStore, {
                  ...store,
                  readPersistedHoldClasses: (input) =>
                    Effect.gen(function* () {
                      reads.push(input);
                      const result = yield* store.readPersistedHoldClasses(input);
                      if (reads.length === 2) yield* Deferred.succeed(second, undefined);
                      return result;
                    }),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(fixture(peer(), undefined, false, true))),
  ),
);

it.effect("typed hold discovery failure leaves healthy sync available", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      yield* enqueue(98210);
      const store = yield* Store.MemoryStore;
      let reads = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          yield* sync.start;
          const status = yield* sync.syncStatus({}, Effect.void);
          assert.strictEqual(status.failureCode, "storage_failed");
          yield* sync.syncOnce;
          assert.strictEqual(reads, 1, "legacy status no longer runs diagnostic hold probes");
          const sql = yield* SqlClient.SqlClient;
          assert.deepStrictEqual(
            yield* sql`SELECT status FROM memory_outbox WHERE id='sync:98210'`,
            [{ status: "completed" }],
          );
          yield* sync.shutdown;
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(
                Layer.succeed(Store.MemoryStore, {
                  ...store,
                  readPersistedHoldClasses: () =>
                    Effect.suspend(() => {
                      reads++;
                      return Effect.fail(
                        new Store.MemoryStorageError({
                          stage: "persisted-hold-discovery",
                          cause: "synthetic storage failure",
                        }),
                      );
                    }),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(fixture())),
  ),
);

it.effect.each(["claim", "paired"] as const)(
  "new %s identity hold registers a descriptor probe without restart",
  (stage) =>
    Effect.gen(function* () {
      let probes = 0;
      let attempts = 0;
      let lease: M.MemoryResolutionLease | undefined;
      const held = yield* Deferred.make<void>();
      const resumed = yield* Deferred.make<void>();
      const refuse = Effect.gen(function* () {
        attempts++;
        if (attempts === 2) {
          yield* Deferred.succeed(resumed, undefined);
          return yield* Effect.never;
        }
        return yield* new M.MemoryHubError({ code: "identity_mismatch" });
      });
      const client = peer({
        preflight: () =>
          Effect.sync(() => {
            probes++;
            return recoveredDescriptor;
          }),
        claim: (_c, { protocolVersion: _protocol, ...claim }) => {
          if (stage === "claim") return refuse;
          lease = {
            ...claim,
            fencingToken: 1,
            claimedAtHubTime: timestamp,
            expiresAtHubTime: "1970-01-01T00:02:00.000Z",
            attemptDeadlineHubTime: "1970-01-01T00:10:00.000Z",
          };
          return Effect.succeed(lease);
        },
        renew: () =>
          Effect.suspend(() => {
            if (attempts === 0) return refuse;
            return Effect.succeed(lease!);
          }),
        release: () => Deferred.succeed(held, undefined).pipe(Effect.as({ released: true })),
      });
      const model = realGeneration({
        resolveMemoryConflict: () =>
          Deferred.succeed(resumed, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* conflict();
          const sync = yield* Sync.MemorySyncService;
          const sql = yield* SqlClient.SqlClient;
          yield* sync.start;
          if (stage === "paired") yield* Deferred.await(held);
          assert.strictEqual(attempts, 1);
          const heldRows = yield* sql`SELECT id FROM memory_outbox WHERE hold_class='identity'`;
          assert.strictEqual(heldRows.length, stage === "claim" ? 1 : 2);
          yield* TestClock.adjust(29999);
          assert.strictEqual(probes, 0);
          yield* TestClock.adjust(1);
          assert.strictEqual(probes, 1);
          yield* Deferred.await(resumed);
          assert.strictEqual(attempts, stage === "claim" ? 2 : 1);
          yield* sync.shutdown;
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

const resolutionLineageModes = [
  "valid",
  "self-history",
  "self-history-pruned",
  "self-history-omitted",
  "quarantined-source",
  "limit",
  "generation-race",
  "omitted",
  "omitted-heads",
  "admission-race",
] as const;
it.effect.each(resolutionLineageModes)(
  "r2 resolution preserves transitive lineage and fences %s",
  (mode) =>
    Effect.gen(function* () {
      const submitted = yield* Deferred.make<void>();
      const milestone = yield* Deferred.make<"submitted" | "released">();
      const released = yield* Deferred.make<void>();
      let submission: M.MemoryHubApplyResolutionInput | undefined;
      let calls = 0;
      let database: SqlClient.SqlClient | undefined;
      const source = operation(9100, M.MemoryId.make(id(9100)));
      if (source.kind !== "upsert") throw new Error("fixture");
      const client = peer({
        applyResolution: (_c, input) =>
          Effect.gen(function* () {
            submission = input;
            yield* Deferred.succeed(submitted, undefined);
            yield* Deferred.succeed(milestone, "submitted");
            return yield* new M.MemoryHubError({ code: "unavailable" });
          }),
        release: () =>
          Deferred.succeed(released, undefined).pipe(
            Effect.andThen(Deferred.succeed(milestone, "released")),
            Effect.as({ released: true }),
          ),
      });
      const model = realGeneration({
        resolveMemoryConflict: (input) =>
          Effect.gen(function* () {
            calls++;
            if (mode === "generation-race") {
              if (!database) throw new Error("fixture");
              yield* database`UPDATE memory_items SET status='forgotten' WHERE memory_id=${source.memoryId}`.pipe(
                Effect.orDie,
              );
            }
            return {
              result: {
                text: "synthetic transitive resolution",
                assertionKind: "inference" as const,
                evidence: [],
                judgment: "synthetic lineage judgment",
              },
              execution: {
                requestedModelSelection: input.modelSelection,
                effectiveProvider: M.ProviderDriverKind.make("codex"),
                effectiveModel: input.modelSelection.model,
                providerInstanceId: input.modelSelection.instanceId,
                environmentId: local,
              },
            };
          }),
      });
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* ready;
          yield* commit(source);
          const target = yield* conflict();
          const sql = yield* SqlClient.SqlClient;
          database = sql;
          const store = yield* Store.MemoryStore;
          const service = yield* Service.MemoryService;
          const original = yield* store.loadAggregate(space, target);
          const deps =
            mode === "limit"
              ? Array.from({ length: 100 }, (_, i) => M.MemoryRevisionId.make(id(9200 + i)))
              : [
                  source.revision.revisionId,
                  ...(mode.startsWith("self-history")
                    ? [
                        original.revisions.find(
                          (r) => !original.heads.includes(r.revision.revisionId),
                        )!.revision.revisionId,
                      ]
                    : []),
                ];
          for (const head of original.heads)
            yield* sql`UPDATE memory_payloads SET body_json=json_set(body_json,'$.derivedFromMemoryRevisions',json(${encode(deps)})),dependencies_json=${encode(deps)} WHERE payload_ref=${head}`;
          if (mode === "self-history-pruned")
            yield* sql`DELETE FROM memory_payloads WHERE payload_ref=${deps[1]!}`;
          if (mode === "quarantined-source")
            yield* sql`UPDATE memory_items SET status='quarantined' WHERE memory_id=${source.memoryId}`;
          const sync = yield* Sync.MemorySyncService;
          yield* sync.syncOnce;
          if (mode === "limit" || mode === "generation-race" || mode === "quarantined-source") {
            yield* Deferred.await(released);
            yield* sync.shutdown;
            assert.isUndefined(submission);
            assert.strictEqual(calls, mode === "generation-race" ? 1 : 0);
            assert.deepStrictEqual(
              (yield* store.loadAggregate(space, target)).heads,
              original.heads,
            );
            return;
          }
          assert.strictEqual(yield* Deferred.await(milestone), "submitted");
          yield* Deferred.await(submitted);
          yield* sync.shutdown;
          if (!submission || submission.operation.kind !== "resolve") throw new Error("fixture");
          const op = submission.operation;
          assert.deepStrictEqual(
            [...op.payload.derivedFromMemoryRevisions].sort(),
            [...original.heads, ...deps].sort(),
          );
          yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status) VALUES (${space},${local},${"a".repeat(64)},1,'active')`;
          const authority: Store.HubAuthority = {
            principal: {
              memorySpaceId: space,
              environmentId: local,
              credentialVersion: 1,
              scopes: ["memory:sync"],
            },
            now: Clock.currentTimeMillis,
            reauthorize: Effect.void,
          };
          yield* store.transact(
            store.transitionHubLeaseTx({
              authority,
              action: {
                kind: "claim",
                request: {
                  protocolVersion: 1,
                  memorySpaceId: space,
                  memoryId: target,
                  holderEnvironmentId: local,
                  conflictId: op.conflictId,
                  conflictHeadSet: original.heads,
                  attemptId: submission.attemptId,
                  frozenDefaultModelSelection: selection,
                },
              },
            }),
          );
          if (mode === "admission-race")
            yield* sql`UPDATE memory_items SET status='forgotten' WHERE memory_id=${source.memoryId}`;
          const candidate =
            mode === "omitted" || mode === "self-history-omitted"
              ? { ...op, payload: { ...op.payload, derivedFromMemoryRevisions: original.heads } }
              : mode === "omitted-heads"
                ? { ...op, payload: { ...op.payload, derivedFromMemoryRevisions: deps } }
                : op;
          const receipt = yield* service.admitHubOperation({
            authority,
            operation: candidate,
            resolutionRequest: { ...submission, operation: candidate },
          });
          const accepted =
            mode === "valid" || mode === "self-history" || mode === "self-history-pruned";
          assert.strictEqual(receipt.outcome, accepted ? "accepted" : "rejected");
          if (!accepted) {
            assert.strictEqual(
              receipt.failureCode,
              mode === "admission-race" ? "source_invalidated" : "invalid_output",
            );
            return;
          }
          // Expire the actual original input payloads, not their lineage identity rows.
          yield* sql`UPDATE memory_payloads SET purge_eligible_after=0,revert_deadline=0 WHERE payload_ref IN (${original.heads[0]!},${original.heads[1]!})`;
          yield* sql`UPDATE memory_resolutions SET revert_deadline=0 WHERE memory_id=${target}`;
          yield* sql`UPDATE memory_outbox SET status='completed' WHERE memory_id=${target}`;
          yield* sql`UPDATE memory_events SET receipt_json=json_set(receipt_json,'$.hubSequence',1) WHERE memory_id=${target}`;
          yield* sql`INSERT INTO memory_compaction_state(space,published) VALUES (${space},1) ON CONFLICT(space) DO UPDATE SET published=1`;
          yield* store.prunePayloads(1, 100);
          for (const head of original.heads)
            assert.strictEqual(
              (yield* sql`SELECT 1 FROM memory_payloads WHERE payload_ref=${head}`).length,
              0,
            );
          yield* service.forget(
            {
              memorySpaceId: space,
              memoryId: source.memoryId,
              operationId: M.MemoryOperationId.make(id(9400)),
              expectedHeads: [source.revision.revisionId],
            },
            Effect.void,
          );
          assert.strictEqual(
            (yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${target}`).length,
            0,
          );
          assert.strictEqual((yield* store.loadAggregate(space, target)).item?.status, "blocked");
        }).pipe(Effect.provide(fixture(client, model))),
      );
    }),
);

it.effect.each(["offline", "next-page", "transport-retry", "chain", "rejected"] as const)(
  "H-R4-1 sends local dependencies before derived work: %s",
  (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        // A separate real SQLite hub; only the network boundary is bridged.
        const h = yield* Layer.build(Layer.fresh(Maintenance.layer.pipe(Layer.provideMerge(core))));
        const hStore = Context.get(h, Store.MemoryStore);
        const hService = Context.get(h, Service.MemoryService);
        const hSql = Context.get(h, SqlClient.SqlClient);
        yield* searchMigration.pipe(Effect.provideService(SqlClient.SqlClient, hSql));
        yield* hSql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${local},${"a".repeat(64)},1,'active',0)`;
        const sent: M.MemoryOperationId[] = [];
        let failedTransport = false;
        const client = peer({
          push: (_c, input) =>
            Effect.gen(function* () {
              const op = input.operations[0]!;
              sent.push(op.operationId);
              if (scenario === "transport-retry" && !failedTransport) {
                failedTransport = true;
                return yield* new M.MemoryHubError({ code: "unavailable" });
              }
              const receipt = yield* hService.admitHubOperation({
                operation: op,
                authority: {
                  principal: {
                    memorySpaceId: space,
                    environmentId: local,
                    credentialVersion: 1,
                    scopes: ["memory:sync"],
                  },
                  now: Clock.currentTimeMillis,
                  reauthorize: Effect.void,
                },
              });
              return { receipts: [receipt] };
            }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "unavailable" }))),
        });
        yield* Effect.gen(function* () {
          yield* ready;
          const service = yield* Service.MemoryService;
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          const sync = yield* Sync.MemorySyncService;
          assert.notStrictEqual(store, hStore);
          const save = Effect.fnUntraced(function* (
            n: number,
            deps: readonly M.MemoryRevisionId[] = [],
          ) {
            const value: M.MemoryUpsertInput = {
              memorySpaceId: space,
              memoryId: M.MemoryId.make(id(n)),
              operationId: M.MemoryOperationId.make(id(n)),
              expectedHeads: [],
              scope: { kind: "user" },
              assertionKind: "inference",
              payload: {
                text: `synthetic ordering ${n}`,
                evidence: [],
                derivedFromMemoryRevisions: deps,
              },
              baseBoundary: null,
            };
            yield* service.upsert(value, Effect.void);
            return {
              ...value,
              revision: (yield* store.loadAggregate(space, value.memoryId)).heads[0]!,
            };
          });
          const a = yield* save(99000);
          const b = scenario === "chain" ? yield* save(98999, [a.revision]) : null;
          const s = yield* save(98000, [b?.revision ?? a.revision]);
          // Fill the entire old page with derived candidates ordered before A.
          if (scenario === "next-page")
            for (let n = 98001; n < 98101; n++) yield* save(n, [a.revision]);
          // The hub forgot A while this member was offline: both submissions must terminate.
          if (scenario === "rejected") {
            yield* hService.upsert(
              {
                memorySpaceId: space,
                memoryId: a.memoryId,
                operationId: M.MemoryOperationId.make(id(99991)),
                expectedHeads: [],
                scope: a.scope,
                assertionKind: a.assertionKind,
                payload: a.payload,
                baseBoundary: null,
              },
              Effect.void,
            );
            yield* hService.forget(
              {
                memorySpaceId: space,
                memoryId: a.memoryId,
                operationId: M.MemoryOperationId.make(id(99992)),
                expectedHeads: (yield* hStore.loadAggregate(space, a.memoryId)).heads,
              },
              Effect.void,
            );
          }
          yield* sync.syncOnce;
          assert.isUndefined(yield* hStore.receipt(space, s.operationId));
          assert.deepStrictEqual(sent, [a.operationId]);
          assert.isTrue((yield* store.loadAggregate(space, s.memoryId)).item!.pendingSync);
          const waiting = yield* sql<{
            status: string;
            attempt: number;
            failure_code: string | null;
          }>`SELECT status,attempt,failure_code FROM memory_outbox WHERE id=${`sync:${space}:${s.operationId}`}`;
          assert.deepStrictEqual(waiting, [{ status: "pending", attempt: 0, failure_code: null }]);
          assert.isUndefined(yield* hStore.receipt(space, s.operationId));
          if (scenario === "transport-retry") {
            yield* sync.syncOnce;
            assert.deepStrictEqual(sent, [a.operationId]);
            yield* TestClock.adjust("2 seconds");
            yield* sync.syncOnce;
            assert.deepStrictEqual(sent, [a.operationId, a.operationId]);
          }
          yield* sync.syncOnce;
          if (b) {
            assert.deepStrictEqual(sent, [a.operationId, b.operationId]);
            assert.isUndefined(yield* hStore.receipt(space, s.operationId));
            yield* sync.syncOnce;
          }
          if (scenario === "next-page") yield* sync.syncOnce;
          const aReceipt = (yield* hStore.receipt(space, a.operationId))!.receipt;
          const sReceipt = (yield* hStore.receipt(space, s.operationId))!.receipt;
          assert.strictEqual(aReceipt.outcome, scenario === "rejected" ? "rejected" : "accepted");
          assert.strictEqual(sReceipt.outcome, scenario === "rejected" ? "rejected" : "accepted");
          assert.deepStrictEqual((yield* store.receipt(space, s.operationId))!.receipt, sReceipt);
          assert.lengthOf(
            yield* store.readEligibleOutbox(space, yield* Clock.currentTimeMillis, 100),
            0,
          );
          if (scenario === "rejected") {
            assert.strictEqual(sReceipt.failureCode, "source_invalidated");
            assert.deepStrictEqual(
              yield* sql`SELECT status FROM memory_outbox WHERE id=${`sync:${space}:${s.operationId}`}`,
              [{ status: "failed" }],
            );
            yield* sync.syncOnce;
            assert.lengthOf(sent, 2);
          } else {
            const maintenance = Context.get(h, Maintenance.MemoryFtsMaintenance);
            for (const value of [a, ...(b ? [b] : []), s]) {
              const current = yield* hStore.loadAggregate(space, value.memoryId);
              assert.isTrue(
                yield* maintenance.repair({
                  memorySpaceId: space,
                  memoryId: value.memoryId,
                  revisionId: value.revision,
                  generation: current.generation,
                }),
              );
            }
            const results = yield* hService.search(
              { memorySpaceId: space, query: "ordering", limit: 100, mode: "fts" },
              Effect.void,
            );
            assert.includeMembers(
              results.items.map((item) => item.memoryId),
              [a.memoryId, s.memoryId],
            );
          }
        }).pipe(Effect.provide(fixture(client)));
      }),
    ),
);

it.effect.each(["accepted", "rejected"] as const)(
  "M-R5-2 real toolkit replays %s Sync ACK without writes after forget and unknown",
  (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* Layer.build(Layer.fresh(core));
        const hService = Context.get(h, Service.MemoryService);
        const hStore = Context.get(h, Store.MemoryStore);
        const hSql = Context.get(h, SqlClient.SqlClient);
        yield* hSql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${local},${"a".repeat(64)},1,'active',0)`;
        const client = peer({
          push: (_c, input) =>
            Effect.gen(function* () {
              const receipt = yield* hService.admitHubOperation({
                operation: input.operations[0]!,
                authority: {
                  principal: {
                    memorySpaceId: space,
                    environmentId: local,
                    credentialVersion: 1,
                    scopes: ["memory:sync"],
                  },
                  now: Clock.currentTimeMillis,
                  reauthorize: Effect.void,
                },
              });
              return { receipts: [receipt] };
            }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "unavailable" }))),
        });
        const integrated = McpHttpServer.layerMemoryToolkit.pipe(
          Layer.provide(McpAccess.layerPermissionProfilesOff),
          Layer.provideMerge(fixture(client)),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(McpAccess.liveThreadsLayer),
          Layer.provide(NodeServices.layer),
        );
        yield* Effect.gen(function* () {
          yield* ready;
          const service = yield* Service.MemoryService;
          const store = yield* Store.MemoryStore;
          const sql = yield* SqlClient.SqlClient;
          const sync = yield* Sync.MemorySyncService;
          const input = { ...McpFixture.upsert(97001), memorySpaceId: space };
          const invocation = {
            ...McpFixture.scope(),
            environmentId: local,
            client: undefined,
            thread: {
              threadId: M.ThreadId.make("r6-caller"),
              providerSessionId: "synthetic",
              providerInstanceId: M.ProviderInstanceId.make("codex"),
            },
          };
          if (outcome === "rejected") {
            yield* hService.upsert(
              { ...input, operationId: M.MemoryOperationId.make(id(97002)) },
              Effect.void,
            );
            yield* hService.forget(
              {
                memorySpaceId: space,
                memoryId: input.memoryId,
                operationId: M.MemoryOperationId.make(id(97003)),
                expectedHeads: (yield* hStore.loadAggregate(space, input.memoryId)).heads,
              },
              Effect.void,
            );
          }
          const first = yield* McpFixture.call("memory_upsert", input, invocation);
          assert.isNotTrue(first.result.isError);
          const pending = yield* decodeReplayReceipt(first.body, {
            onExcessProperty: "error",
          });
          assert.isTrue(pending.pendingSync);
          yield* sync.syncOnce;
          const canonical = (yield* store.receipt(space, input.operationId))!;
          assert.strictEqual(canonical.receipt.outcome, outcome);
          assert.property(canonical.receipt, "hubSequence");
          const counts = sql`SELECT (SELECT count(*) FROM memory_events) AS events,(SELECT count(*) FROM memory_payloads) AS payloads,(SELECT count(*) FROM memory_outbox) AS outbox`;
          const replay = Effect.gen(function* () {
            const before = yield* counts;
            const response = yield* McpFixture.call("memory_upsert", input, invocation);
            assert.isNotTrue(response.result.isError);
            const receipt = yield* decodeReplayReceipt(response.body, {
              onExcessProperty: "error",
            });
            assert.strictEqual(receipt.outcome, outcome);
            assert.isFalse(receipt.pendingSync);
            assert.strictEqual(
              receipt.revisionId,
              outcome === "rejected" ? null : pending.revisionId,
            );
            if (outcome === "rejected")
              assert.strictEqual(receipt.failureCode, canonical.receipt.failureCode);
            assert.deepStrictEqual(yield* counts, before);
            assert.deepStrictEqual(yield* store.receipt(space, input.operationId), canonical);
          });
          yield* replay;
          yield* service.forget(
            {
              memorySpaceId: space,
              memoryId: input.memoryId,
              operationId: M.MemoryOperationId.make(id(97004)),
              expectedHeads: (yield* store.loadAggregate(space, input.memoryId)).heads,
            },
            Effect.void,
          );
          yield* sql`INSERT INTO orchestration_events(application_event_version,aggregate_kind,stream_id,event_type,payload_json) VALUES(2,'thread','r6-caller','context-transfer.created','{"targetThreadId":"r6-caller","sourceThreadId":"other"}')`;
          assert.strictEqual(
            (yield* store.readThreadLineage(
              { environmentId: local, threadId: invocation.thread.threadId },
              space,
            )).state,
            "unknown",
          );
          yield* replay;
          assert.lengthOf(
            yield* sql`SELECT 1 FROM memory_payloads WHERE memory_id=${input.memoryId}`,
            0,
          );
          // Settings WS calls the same service without a caller, then strict-decodes its receipt.
          const settingsInput = {
            ...McpFixture.upsert(97011),
            memorySpaceId: space,
            memoryId: M.MemoryId.make(id(97012)),
          };
          const settingsFirst = yield* service.upsert(settingsInput, Effect.void);
          yield* sync.syncOnce;
          const before = yield* counts;
          const settingsReplay = yield* service.upsert(settingsInput, Effect.void);
          const settingsReceipt = yield* decodeReplayReceipt(settingsReplay.receipt, {
            onExcessProperty: "error",
          });
          assert.isFalse(settingsReceipt.pendingSync);
          assert.strictEqual(
            settingsReceipt.revisionId,
            (settingsFirst.receipt as M.MemoryMutationReceipt).revisionId,
          );
          assert.deepStrictEqual(yield* counts, before);
        }).pipe(Effect.provide(integrated));
      }),
    ),
);

it.effect.each(["tail", "bootstrap"] as const)(
  "M-R6-1 caller-free replay fences foreign environment after %s",
  (phase) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* Layer.build(Layer.fresh(core));
        const hService = Context.get(h, Service.MemoryService);
        const hStore = Context.get(h, Store.MemoryStore);
        const hSql = Context.get(h, SqlClient.SqlClient);
        const bEnvironment = M.EnvironmentId.make("fixture-member-b");
        for (const [index, environment] of [local, remote, bEnvironment].entries())
          yield* hSql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${environment},${String(index + 1).repeat(64)},1,'active',0)`;
        const authority = (environmentId: M.EnvironmentId): Store.HubAuthority => ({
          principal: {
            memorySpaceId: space,
            environmentId,
            credentialVersion: 1,
            scopes: ["memory:sync"],
          },
          now: Clock.currentTimeMillis,
          reauthorize: Effect.void,
        });
        const aClient = peer({
          push: (_c, input) =>
            Effect.gen(function* () {
              const receipt = yield* hService.admitHubOperation({
                operation: input.operations[0]!,
                authority: authority(local),
              });
              return { receipts: [receipt] };
            }).pipe(Effect.mapError(() => new M.MemoryHubError({ code: "unavailable" }))),
        });
        const a = yield* Layer.build(Layer.fresh(fixture(aClient)));
        const aService = Context.get(a, Service.MemoryService);
        const aStore = Context.get(a, Store.MemoryStore);
        const aSql = Context.get(a, SqlClient.SqlClient);
        yield* ready.pipe(Effect.provide(a));
        const input = { ...McpFixture.upsert(97501), memorySpaceId: space };
        const caller = { environmentId: local, threadId: M.ThreadId.make("r7-caller") };
        const threaded = {
          ...McpFixture.upsert(97502),
          memorySpaceId: space,
          memoryId: M.MemoryId.make(id(97503)),
        };
        yield* aService.upsert(input, Effect.void);
        yield* Context.get(a, Sync.MemorySyncService).syncOnce;
        yield* aService.upsert(threaded, Effect.void, caller);
        yield* Context.get(a, Sync.MemorySyncService).syncOnce;
        assert.property((yield* aStore.receipt(space, input.operationId))!.receipt, "hubSequence");
        let snapshotToken: string | undefined;
        if (phase === "bootstrap") {
          yield* TestClock.adjust(M.MEMORY_LOG_RETENTION_MS);
          yield* hStore.transact(
            Effect.gen(function* () {
              const previous = yield* hStore.readHubRetentionTx(space);
              const handle = yield* hStore.prepareHubProducerCheckpointTx({
                authority: authority(remote),
                checkpointId: "r7-checkpoint",
                hubEnvironmentId: remote,
              });
              yield* hStore.publishCheckpointAndFloorTx({
                memorySpaceId: space,
                checkpointId: handle.checkpointId,
                expectedFloor: previous.retentionFloor,
                nextFloor: handle.checkpointSequence,
                now: yield* Clock.currentTimeMillis,
              });
              yield* hStore.compactEligibleHistoryTx({
                memorySpaceId: space,
                expectedFloor: handle.checkpointSequence,
                now: yield* Clock.currentTimeMillis,
                limit: 100,
              });
              assert.lengthOf(yield* hSql`SELECT 1 FROM memory_events`, 0);
              const snapshot = yield* hStore.prepareHubCheckpointTx({
                authority: authority(bEnvironment),
                checkpointId: handle.checkpointId,
                snapshotToken: "r7-snapshot",
                hubEnvironmentId: remote,
              });
              snapshotToken = snapshot.snapshotToken;
            }),
          );
        }
        const bClient = peer({
          join: () =>
            hStore
              .transact(
                Effect.gen(function* () {
                  const retention = yield* hStore.readHubRetentionTx(space);
                  return {
                    protocolVersion: 1 as const,
                    memorySpaceId: space,
                    hubEnvironmentId: remote,
                    checkpointSequence: retention.retentionFloor,
                    snapshotToken: snapshotToken!,
                    causalBoundary: retention.causalBoundary!,
                    retentionFloor: retention.retentionFloor,
                  };
                }),
              )
              .pipe(Effect.mapError(() => new M.MemoryHubError({ code: "unavailable" }))),
          pull: (_c, request) =>
            hStore
              .transact(
                Effect.gen(function* () {
                  if (request.snapshotToken) {
                    const page = yield* hStore.readHubCheckpointPageTx({
                      authority: authority(bEnvironment),
                      snapshotToken: request.snapshotToken,
                      cursor: request.cursor ?? null,
                    });
                    return {
                      highWatermark: page.checkpointSequence,
                      throughSequence: page.checkpointSequence,
                      hasMore: !page.bootstrapComplete,
                      entries: [],
                      checkpoint: page,
                    };
                  }
                  return yield* hStore.readHubTailTx({
                    memorySpaceId: space,
                    afterSequence: request.afterSequence,
                    highWatermark: request.highWatermark ?? null,
                    limit: request.limit,
                    maxBytes: M.MEMORY_PAGE_MAX_UTF8_BYTES,
                  });
                }),
              )
              .pipe(Effect.mapError(() => new M.MemoryHubError({ code: "unavailable" }))),
        });
        const b = yield* Layer.build(
          Layer.fresh(fixture(bClient, undefined, false, false, bEnvironment)),
        );
        const bService = Context.get(b, Service.MemoryService);
        const bStore = Context.get(b, Store.MemoryStore);
        const bSql = Context.get(b, SqlClient.SqlClient);
        if (phase === "tail") yield* ready.pipe(Effect.provide(b));
        yield* Context.get(b, Sync.MemorySyncService).syncOnce;
        assert.isDefined(yield* bStore.receipt(space, input.operationId));
        assert.lengthOf(
          yield* bSql`SELECT 1 FROM memory_events WHERE operation_id=${input.operationId}`,
          phase === "tail" ? 1 : 0,
        );
        const counts = (sql: SqlClient.SqlClient) =>
          sql`SELECT (SELECT count(*) FROM memory_events) AS events,(SELECT count(*) FROM memory_payloads) AS payloads,(SELECT count(*) FROM memory_outbox) AS outbox`;
        const aBefore = yield* counts(aSql);
        const bBefore = yield* counts(bSql);
        const aCanonical = yield* aStore.receipt(space, input.operationId);
        const bCanonical = yield* bStore.receipt(space, input.operationId);
        const reject = <A, E, R>(effect: Effect.Effect<A, E, R>, code: string) =>
          effect.pipe(
            Effect.flip,
            Effect.tap((error) => Effect.sync(() => assert.propertyVal(error, "code", code))),
          );
        yield* reject(bService.upsert(input, Effect.void), "operation_id_reused");
        yield* aService.upsert(input, Effect.void);
        yield* aService.upsert(threaded, Effect.void, caller);
        yield* reject(
          aService.upsert(
            { ...input, payload: { ...input.payload, text: "changed" } },
            Effect.void,
          ),
          "operation_id_reused",
        );
        yield* reject(bService.upsert(threaded, Effect.void, caller), "identity_mismatch");
        yield* reject(
          bService.upsert(threaded, Effect.void, { ...caller, environmentId: bEnvironment }),
          "operation_id_reused",
        );
        yield* reject(
          aService.upsert(threaded, Effect.void, {
            ...caller,
            threadId: M.ThreadId.make("other-thread"),
          }),
          "operation_id_reused",
        );
        assert.deepStrictEqual(yield* counts(aSql), aBefore);
        assert.deepStrictEqual(yield* counts(bSql), bBefore);
        assert.deepStrictEqual(yield* aStore.receipt(space, input.operationId), aCanonical);
        assert.deepStrictEqual(yield* bStore.receipt(space, input.operationId), bCanonical);
      }),
    ),
);

const failureCodeForTest = (error: Hub.MemoryHubServiceError) =>
  "code" in error ? error.code : error._tag;
const reconcileInput: M.MemoryHubReconcileInput = {
  memorySpaceId: space,
  environmentId: local,
  expectedVersion: 1,
};
it.effect.each(["protocol", "availability"] as const)(
  "Settings reconcile rearms %s only after a real pinned recovery observation",
  (c) =>
    Effect.gen(function* () {
      yield* ready;
      yield* persistPullHold(c);
      const sync = yield* Sync.MemorySyncService;
      const store = yield* Store.MemoryStore;
      const before = yield* sync.hubDiagnostics({}, Effect.void);
      assert.deepStrictEqual(before.recoverableHolds, [c]);
      assert.strictEqual(before.reconcile, "available");
      const result = yield* sync.reconcileHub(reconcileInput, Effect.void);
      assert.deepStrictEqual(result, { version: 1, rearmedClasses: [c] });
      assert.isNull(
        (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote })).holdClass,
      );
      assert.deepStrictEqual(
        (yield* sync.reconcileHub(reconcileInput, Effect.void)).rearmedClasses,
        [],
      );
    }).pipe(
      Effect.provide(fixture(peer({ preflight: () => Effect.succeed(recoveredDescriptor) }))),
    ),
);
it.effect.each(["identity", "authorization"] as const)(
  "Settings reconcile refuses permanent %s hold without probing or releasing it",
  (c) =>
    Effect.gen(function* () {
      yield* ready;
      yield* persistPullHold(c);
      const sync = yield* Sync.MemorySyncService;
      const store = yield* Store.MemoryStore;
      assert.deepStrictEqual((yield* sync.hubDiagnostics({}, Effect.void)).permanentHolds, [c]);
      const error = yield* sync.reconcileHub(reconcileInput, Effect.void).pipe(Effect.flip);
      assert.strictEqual(
        "code" in error ? error.code : error._tag,
        c === "identity" ? "identity_mismatch" : "route_unavailable",
      );
      assert.strictEqual(
        (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote })).holdClass,
        c,
      );
    }).pipe(
      Effect.provide(
        fixture(peer({ preflight: () => Effect.die("permanent hold must not probe") })),
      ),
    ),
);
it.effect.each([
  "stale",
  "environment",
  "space",
  "unbound",
  "staging",
  "disabled",
  "denied",
] as const)("Settings reconcile rejects %s authority before recovery", (mode) =>
  Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    if (mode !== "staging") yield* ready;
    if (mode === "unbound") yield* changeHub(1, { ...member, memorySpaceId: null });
    if (mode === "disabled") yield* changeHub(1, { mode: "disabled" });
    const input = {
      ...reconcileInput,
      expectedVersion: mode === "stale" ? 0 : mode === "unbound" || mode === "disabled" ? 2 : 1,
      environmentId: mode === "environment" ? remote : local,
      memorySpaceId: mode === "space" ? M.MemorySpaceId.make(id(99880)) : space,
    };
    const error = yield* sync
      .reconcileHub(
        input,
        mode === "denied"
          ? Effect.fail(new Service.MemoryAccessError({ code: "unavailable" }))
          : Effect.void,
      )
      .pipe(Effect.flip);
    assert.strictEqual(
      "code" in error ? error.code : error._tag,
      mode === "environment"
        ? "identity_mismatch"
        : mode === "stale" || mode === "space"
          ? "fenced"
          : mode === "denied"
            ? "unavailable"
            : "bootstrap_required",
    );
  }).pipe(
    Effect.provide(
      fixture(peer({ preflight: () => Effect.die("invalid authority must not probe") })),
    ),
  ),
);
it.effect.each(["identity_mismatch", "unsupported_protocol", "unavailable"] as const)(
  "failed Settings recovery observation retains holds: %s",
  (code) =>
    Effect.gen(function* () {
      yield* ready;
      yield* persistPullHold("protocol");
      const sync = yield* Sync.MemorySyncService;
      const store = yield* Store.MemoryStore;
      assert.strictEqual(
        failureCodeForTest(yield* sync.reconcileHub(reconcileInput, Effect.void).pipe(Effect.flip)),
        code,
      );
      assert.strictEqual(
        (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote })).holdClass,
        "protocol",
      );
    }).pipe(
      Effect.provide(
        fixture(
          peer({
            preflight: () =>
              code === "unavailable"
                ? Effect.fail(new M.MemoryHubError({ code }))
                : Effect.succeed({
                    ...recoveredDescriptor,
                    ...(code === "identity_mismatch"
                      ? { environmentId: local }
                      : { capabilities: { repositoryIdentity: false } }),
                  }),
          }),
        ),
      ),
    ),
);
it.effect.each(["last_valid", "unavailable", "unknown"] as const)(
  "Settings reconcile rejects %s publication even with matching epoch",
  (state) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        const committed = yield* Settings.MemoryHubCommittedSettings;
        yield* Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          assert.strictEqual(
            failureCodeForTest(
              yield* sync.reconcileHub(reconcileInput, Effect.void).pipe(Effect.flip),
            ),
            "fenced",
          );
          assert.strictEqual(
            (yield* sync.hubDiagnostics({}, Effect.void)).publication.state,
            state,
          );
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(
                Layer.succeed(Settings.MemoryHubCommittedSettings, {
                  ...committed,
                  readPublication: Effect.succeed({ state }),
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture())),
    ),
);
it.effect.each(["permission", "epoch", "publication"] as const)(
  "Settings reconcile rechecks live %s after waiting for the rearm SQL transaction",
  (revoked) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* persistPullHold("protocol");
        const store = yield* Store.MemoryStore;
        const committed = yield* Settings.MemoryHubCommittedSettings;
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let armed = false;
        let allowed = true;
        let publication: M.MemoryHubPublication = { state: "current" };
        const permit = Effect.suspend(() =>
          allowed
            ? Effect.void
            : Effect.fail(new Service.MemoryAccessError({ code: "unavailable" })),
        );
        yield* Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          const fiber = yield* sync.reconcileHub(reconcileInput, permit).pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          if (revoked === "permission") allowed = false;
          if (revoked === "epoch") yield* changeHub(1, member);
          if (revoked === "publication")
            publication = { state: "last_valid", code: "invalid_settings" };
          yield* Deferred.succeed(resume, undefined);
          const error = yield* Fiber.join(fiber).pipe(Effect.flip);
          assert.strictEqual(
            "code" in error ? error.code : error._tag,
            revoked === "permission" ? "unavailable" : "fenced",
          );
          assert.strictEqual(
            (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
              .holdClass,
            "protocol",
          );
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(
                Layer.succeed(Client.MemoryHubClient, {
                  ...(yield* Client.MemoryHubClient),
                  preflight: () =>
                    Effect.sync(() => {
                      armed = true;
                      return recoveredDescriptor;
                    }),
                }),
              ),
              Layer.provide(
                Layer.succeed(Settings.MemoryHubCommittedSettings, {
                  ...committed,
                  readPublication: Effect.sync(() => publication),
                }),
              ),
              Layer.provide(
                Layer.succeed(Store.MemoryStore, {
                  ...store,
                  transact: (effect, options) =>
                    Effect.suspend(() =>
                      armed
                        ? Deferred.succeed(entered, undefined).pipe(
                            Effect.andThen(Deferred.await(resume)),
                            Effect.andThen(store.transact(effect, options)),
                          )
                        : store.transact(effect, options),
                    ),
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture())),
    ),
);

it.effect("Settings reconcile rolls back a rearm if live permission is revoked before commit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* ready;
      yield* persistPullHold("protocol");
      const store = yield* Store.MemoryStore;
      const entered = yield* Deferred.make<void>();
      const resume = yield* Deferred.make<void>();
      let allowed = true;
      const permit = Effect.suspend(() =>
        allowed ? Effect.void : Effect.fail(new Service.MemoryAccessError({ code: "unavailable" })),
      );
      yield* Effect.gen(function* () {
        const sync = yield* Sync.MemorySyncService;
        const fiber = yield* sync.reconcileHub(reconcileInput, permit).pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        allowed = false;
        yield* Deferred.succeed(resume, undefined);
        assert.strictEqual(
          failureCodeForTest(yield* Fiber.join(fiber).pipe(Effect.flip)),
          "unavailable",
        );
        assert.strictEqual(
          (yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }))
            .holdClass,
          "protocol",
        );
      }).pipe(
        Effect.provide(
          Layer.fresh(Sync.layer).pipe(
            Layer.provide(
              Layer.succeed(Store.MemoryStore, {
                ...store,
                writePullRetryTx: (input) =>
                  store
                    .writePullRetryTx(input)
                    .pipe(
                      Effect.tap(() =>
                        Deferred.succeed(entered, undefined).pipe(
                          Effect.andThen(Deferred.await(resume)),
                        ),
                      ),
                    ),
              }),
            ),
          ),
        ),
      );
    }).pipe(
      Effect.provide(fixture(peer({ preflight: () => Effect.succeed(recoveredDescriptor) }))),
    ),
  ),
);

it.effect(
  "diagnostics distinguish staging, unobserved readiness and a ready but unreachable hub",
  () =>
    Effect.gen(function* () {
      yield* ready;
      const sql = yield* SqlClient.SqlClient;
      const sync = yield* Sync.MemorySyncService;
      yield* sql`UPDATE memory_sync_cursors SET bootstrap_state='staging' WHERE space=${space}`;
      const staging = yield* sync.hubDiagnostics({}, Effect.void);
      assert.strictEqual(staging.readiness, "staging");
      assert.strictEqual(staging.reconcile, "unavailable");
      yield* sql`UPDATE memory_sync_cursors SET bootstrap_state='ready' WHERE space=${space}`;
      const before = yield* sync.hubDiagnostics({}, Effect.void);
      assert.strictEqual(before.readiness, "ready");
      assert.strictEqual(before.connection, "unknown");
      assert.strictEqual(failureCodeForTest(yield* sync.syncOnce.pipe(Effect.flip)), "unavailable");
      const failed = yield* sync.hubDiagnostics({}, Effect.void);
      assert.strictEqual(failed.readiness, "ready");
      assert.strictEqual(failed.connection, "unreachable");
      assert.strictEqual((yield* sync.syncStatus({}, Effect.void)).failureCode, "unavailable");
    }).pipe(
      Effect.provide(
        fixture(peer({ pull: () => Effect.fail(new M.MemoryHubError({ code: "unavailable" })) })),
      ),
    ),
);

it.effect("an unfinished Settings rearm never becomes an unguarded sweep in the next epoch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const blocked = yield* Deferred.make<void>();
      const nextEpochPulled = yield* Deferred.make<void>();
      const client = peer({
        preflight: () => Effect.succeed(recoveredDescriptor),
        pull: (connection, input) =>
          Effect.gen(function* () {
            if (connection.epoch === 2) yield* Deferred.succeed(nextEpochPulled, undefined);
            return {
              highWatermark: input.highWatermark ?? input.afterSequence,
              throughSequence: input.afterSequence,
              hasMore: false,
              entries: [],
            };
          }),
      });
      yield* Effect.gen(function* () {
        yield* ready;
        const sql = yield* SqlClient.SqlClient;
        for (let n = 99000; n < 99101; n++) yield* enqueue(n, M.MemoryId.make(id(n)));
        yield* sql`UPDATE memory_outbox SET status='retry',hold_class='protocol',next_attempt_at=9007199254740991 WHERE kind='sync'`;
        const store = yield* Store.MemoryStore;
        let pages = 0;
        yield* Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          yield* sync.start;
          yield* sync.reconcileHub(reconcileInput, Effect.void);
          yield* Deferred.await(blocked);
          yield* changeHub(1, member);
          yield* Deferred.await(nextEpochPulled);
          yield* sync.syncOnce;
          const held = yield* sql`SELECT id FROM memory_outbox WHERE hold_class='protocol'`;
          assert.strictEqual(held.length, 1, "only the first authorized page may be rearmed");
          yield* sync.shutdown;
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(
                Layer.succeed(Store.MemoryStore, {
                  ...store,
                  rearmSyncHoldsTx: (input) =>
                    Effect.suspend(() => {
                      if (input.holdClass === "protocol" && ++pages === 2)
                        return Deferred.succeed(blocked, undefined).pipe(
                          Effect.andThen(Effect.never),
                        );
                      return store.rearmSyncHoldsTx(input);
                    }),
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.provide(fixture(client, undefined, false, true)));
    }),
  ),
);

it.effect("legacy syncStatus request and response decode through the base JSON RPC codec", () =>
  Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    const oldPayload = Schema.toCodecJson(legacySyncStatusRpc.payloadSchema);
    const newPayload = Schema.toCodecJson(M.WsMemorySyncStatusRpc.payloadSchema);
    const input = yield* Schema.decodeUnknownEffect(newPayload)(
      yield* Schema.encodeEffect(oldPayload)({}),
    );
    const response = yield* sync.syncStatus(input, Effect.void);
    assert.notProperty(response, "diagnostics");
    const encoded = yield* Schema.encodeEffect(
      Schema.toCodecJson(Rpc.exitSchema(M.WsMemorySyncStatusRpc)),
    )(Exit.succeed(response));
    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.toCodecJson(Rpc.exitSchema(legacySyncStatusRpc)),
    )(JSON.parse(JSON.stringify(encoded)));
    assert.deepStrictEqual(decoded, Exit.succeed(response));
    // The frozen decoder really rejects the r1 regression, including toCodecJson.
    const broken = {
      _tag: "Success",
      value: { ...response, diagnostics: yield* sync.hubDiagnostics({}, Effect.void) },
    };
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          Schema.decodeUnknownEffect(Schema.toCodecJson(Rpc.exitSchema(legacySyncStatusRpc)))(
            broken,
          ),
        ),
      ),
    );
    const reverse = yield* Schema.encodeEffect(
      Schema.toCodecJson(Rpc.exitSchema(legacySyncStatusRpc)),
    )(Exit.succeed(response));
    assert.deepStrictEqual(
      yield* Schema.decodeUnknownEffect(
        Schema.toCodecJson(Rpc.exitSchema(M.WsMemorySyncStatusRpc)),
      )(reverse),
      Exit.succeed(response),
    );
  }).pipe(Effect.provide(fixture())),
);

const encodeStatusExit = Schema.encodeEffect(
  Schema.toCodecJson(Rpc.exitSchema(M.WsMemorySyncStatusRpc)),
);
const decodeLegacyStatusExit = Schema.decodeUnknownEffect(
  Schema.toCodecJson(Rpc.exitSchema(legacySyncStatusRpc)),
);
it.effect("reports a paused memory model only to a request that opts in", () =>
  Effect.gen(function* () {
    const sync = yield* Sync.MemorySyncService;
    const hold = yield* Hold.MemoryGenerationHold;
    const memoryModel = M.MemoryModelSelection.make({
      instanceId: M.ProviderInstanceId.make("codex"),
      model: "held",
    });
    yield* (yield* Settings.ServerSettingsService).updateSettings({
      memoryModelSelection: memoryModel,
    });
    yield* hold
      .guard(
        yield* hold.keyFor(memoryModel),
        Effect.fail(
          new M.TextGenerationError({
            operation: "generateMemorySummary",
            detail: 'Codex CLI command failed: {"code":"invalid_json_schema","status":400}',
          }),
        ),
      )
      .pipe(Effect.flip);
    const opted = yield* sync.syncStatus({ includeGenerationHold: true }, Effect.void);
    assert.strictEqual(opted.generationHold?.reason, "schema_rejected");
    // A client that did not opt in decodes strictly and must never see the field.
    const legacy = yield* sync.syncStatus({}, Effect.void);
    assert.notProperty(legacy, "generationHold");
    const encoded = yield* encodeStatusExit(Exit.succeed(legacy));
    assert.isTrue(
      Exit.isSuccess(
        yield* Effect.exit(decodeLegacyStatusExit(JSON.parse(JSON.stringify(encoded)))),
      ),
    );
  }).pipe(Effect.provide(fixture().pipe(Layer.provideMerge(Hold.layer)))),
);

it.effect.each(["expiry", "permission", "epoch", "publication"] as const)(
  "final commit guard rolls back holds and retry after accounting waits across %s",
  (revoked) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* ready;
        yield* enqueue(99500);
        const sql = yield* SqlClient.SqlClient;
        yield* sql`UPDATE memory_outbox SET status='retry',hold_class='protocol',next_attempt_at=9007199254740991 WHERE kind='sync'`;
        yield* persistPullHold("protocol");
        const store = yield* Store.MemoryStore;
        const committed = yield* Settings.MemoryHubCommittedSettings;
        const before = yield* store.readPullRetry({
          memorySpaceId: space,
          hubEnvironmentId: remote,
        });
        const entered = yield* Deferred.make<void>();
        const resume = yield* Deferred.make<void>();
        let armed = false;
        let allowed = true;
        let publication: M.MemoryHubPublication = { state: "current" };
        const expires = (yield* Clock.currentTimeMillis) + 1000;
        const permit = Effect.gen(function* () {
          if (!allowed || (yield* Clock.currentTimeMillis) >= expires)
            return yield* new Service.MemoryAccessError({ code: "unavailable" });
        });
        const transformer: Statement.Transformer = (statement) =>
          Effect.gen(function* () {
            if (armed && statement.compile()[0].includes("SELECT dimension,scope_key")) {
              armed = false;
              yield* Deferred.succeed(entered, undefined);
              yield* Deferred.await(resume);
            }
            return statement;
          });
        yield* Effect.gen(function* () {
          const sync = yield* Sync.MemorySyncService;
          const fiber = yield* sync
            .reconcileHub(reconcileInput, permit)
            .pipe(
              Effect.provideService(Statement.CurrentTransformer, transformer),
              Effect.forkChild,
            );
          yield* Deferred.await(entered);
          if (revoked === "expiry") yield* TestClock.adjust(1000);
          if (revoked === "permission") allowed = false;
          if (revoked === "epoch") yield* changeHub(1, member);
          if (revoked === "publication")
            publication = { state: "last_valid", code: "invalid_settings" };
          yield* Deferred.succeed(resume, undefined);
          assert.strictEqual(
            failureCodeForTest(yield* Fiber.join(fiber).pipe(Effect.flip)),
            revoked === "permission" || revoked === "expiry" ? "unavailable" : "fenced",
          );
          assert.deepStrictEqual(
            yield* store.readPullRetry({ memorySpaceId: space, hubEnvironmentId: remote }),
            before,
          );
          assert.strictEqual((yield* store.readWorkHold("sync:99500"))?.holdClass, "protocol");
        }).pipe(
          Effect.provide(
            Layer.fresh(Sync.layer).pipe(
              Layer.provide(
                Layer.succeed(Settings.MemoryHubCommittedSettings, {
                  ...committed,
                  readPublication: Effect.sync(() => publication),
                }),
              ),
              Layer.provide(
                Layer.succeed(Store.MemoryStore, {
                  ...store,
                  writePullRetryTx: (input) =>
                    store.writePullRetryTx(input).pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          armed = true;
                        }),
                      ),
                    ),
                }),
              ),
            ),
          ),
        );
      }).pipe(
        Effect.provide(fixture(peer({ preflight: () => Effect.succeed(recoveredDescriptor) }))),
      ),
    ),
);

it.effect(
  "expired coalesced manual background page retires ownership and requires a fresh observation",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const automaticEntered = yield* Deferred.make<void>();
        const automaticResume = yield* Deferred.make<void>();
        const manualEntered = yield* Deferred.make<void>();
        const manualResume = yield* Deferred.make<void>();
        const automaticObserved = yield* Deferred.make<void>();
        const freshObserved = yield* Deferred.make<void>();
        let observations = 0;
        const client = peer({
          preflight: () =>
            Effect.gen(function* () {
              observations++;
              if (observations === 1) yield* Deferred.succeed(automaticObserved, undefined);
              if (observations === 3) yield* Deferred.succeed(freshObserved, undefined);
              return recoveredDescriptor;
            }),
        });
        yield* Effect.gen(function* () {
          yield* ready;
          for (let n = 99600; n < 99801; n++)
            yield* enqueue(
              n,
              M.MemoryId.make(id(99600 + ((n - 99600) % 100))),
              n >= 99700 ? [M.MemoryRevisionId.make(id(n + 100))] : [],
            );
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE memory_outbox SET status='retry',hold_class='protocol',next_attempt_at=9007199254740991 WHERE kind='sync'`;
          const store = yield* Store.MemoryStore;
          let pages = 0;
          let allowed = true;
          const permit = Effect.suspend(() =>
            allowed
              ? Effect.void
              : Effect.fail(new Service.MemoryAccessError({ code: "unavailable" })),
          );
          yield* Effect.gen(function* () {
            const sync = yield* Sync.MemorySyncService;
            yield* sync.start;
            yield* TestClock.adjust(30000);
            yield* Deferred.await(automaticObserved);
            yield* Deferred.await(automaticEntered);
            const manual = yield* sync
              .reconcileHub(reconcileInput, permit)
              .pipe(Effect.forkChild({ startImmediately: true }));
            // Start immediately so this request is queued on the held cycle mutex.
            yield* Deferred.succeed(automaticResume, undefined);
            yield* Fiber.join(manual);
            yield* Deferred.await(manualEntered);
            allowed = false;
            yield* Deferred.succeed(manualResume, undefined);
            // Joins the active background page and observes its rollback/finalizer.
            yield* sync.syncOnce.pipe(Effect.ignore);
            yield* sync.syncOnce;
            const held = yield* sql`SELECT id FROM memory_outbox WHERE hold_class='protocol'`;
            assert.strictEqual(
              held.length,
              101,
              "failed background page and remaining manual work stay held",
            );
            assert.strictEqual(
              observations,
              2,
              "completed automatic observation plus Settings preflight",
            );
            assert.strictEqual(
              (yield* sync.syncStatus({}, Effect.void)).state,
              "online",
              "normal pull/push/sweep progresses after the failed permit",
            );
            yield* TestClock.adjust(30000);
            yield* Deferred.await(freshObserved);
            yield* sync.syncOnce;
            assert.lengthOf(
              yield* sql`SELECT id FROM memory_outbox WHERE hold_class='protocol'`,
              0,
            );
            yield* sync.shutdown;
          }).pipe(
            Effect.provide(
              Layer.fresh(Sync.layer).pipe(
                Layer.provide(
                  Layer.succeed(Store.MemoryStore, {
                    ...store,
                    rearmSyncHoldsTx: (input) =>
                      Effect.gen(function* () {
                        const page = yield* store.rearmSyncHoldsTx(input);
                        if (input.holdClass === "protocol") {
                          pages++;
                          if (pages === 1) {
                            yield* Deferred.succeed(automaticEntered, undefined);
                            yield* Deferred.await(automaticResume);
                            // Retain the observed automatic pending cursor after a real rollback.
                            return yield* new Store.MemoryStorageError({
                              stage: "fixture-automatic-page",
                              cause: undefined,
                            });
                          }
                          if (pages === 3) {
                            yield* Deferred.succeed(manualEntered, undefined);
                            yield* Deferred.await(manualResume);
                          }
                        }
                        return page;
                      }),
                  }),
                ),
              ),
            ),
          );
        }).pipe(Effect.provide(fixture(client, undefined, false, true)));
      }),
    ),
);

it.effect("diagnostics probes issue only reads without transaction accounting", () =>
  Effect.gen(function* () {
    yield* ready;
    yield* persistPullHold("protocol");
    const sync = yield* Sync.MemorySyncService;
    const statements: string[] = [];
    const transformer: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        statements.push(statement.compile()[0]);
        return statement;
      });
    const result = yield* sync
      .hubDiagnostics({}, Effect.void)
      .pipe(Effect.provideService(Statement.CurrentTransformer, transformer));
    assert.deepStrictEqual(result.recoverableHolds, ["protocol"]);
    assert.isAbove(statements.length, 0);
    assert.isTrue(statements.every((query) => /^\s*SELECT\b/i.test(query)));
    assert.isFalse(statements.some((query) => query.includes("_checkpoint_dirty")));
  }).pipe(Effect.provide(fixture())),
);
