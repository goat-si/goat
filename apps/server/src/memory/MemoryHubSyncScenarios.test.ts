import { assert, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import { GOAT_ENVIRONMENT_PATH } from "@goat/contracts/legacyT3Names";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Deferred from "effect/Deferred";
import * as Schema from "effect/Schema";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Owner from "./MemoryOwnerSourceReader.ts";
import { memoryOperationDigest } from "./MemoryDecider.ts";
import type { ProviderDriver, ProviderInstance } from "@goat/provider-core/server/driver";
import * as Registry from "../provider/ProviderInstanceRegistry.ts";
import * as Generation from "../textGeneration/TextGeneration.ts";
import * as SourceControl from "../sourceControl/SourceControlProviderRegistry.ts";
import * as SourceControlDrivers from "../sourceControl/builtInDrivers.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Vcs from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as Sync from "./MemorySyncService.ts";
import * as Worker from "./MemoryWorker.ts";
import * as Maintenance from "./MemoryFtsMaintenance.ts";
import * as RuntimeIdentity from "../runtimeIdentity.ts";
import * as OrchestrationRuntime from "../orchestration-v2/runtimeLayer.ts";
import * as Runtime from "./MemorySyncRuntimeLive.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Repository from "../project/RepositoryIdentityResolver.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Client from "./MemoryHubClient.ts";
import { layerMemoryHubServices, layerMemoryHubRoutes, layerMemorySyncStarted } from "../server.ts";

const id = (n: number) =>
  M.MemoryOperationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);

type Resolve = NonNullable<Generation.TextGeneration["Service"]["resolveMemoryConflict"]>;
// The only double is the provider instance returned by this driver. Registry,
// TextGeneration routing, storage, HTTP and Sync all run their production code.
const environment = (label: "H" | "A" | "B", resolve?: Resolve) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: `goat-wp3-l5-${label}-` });
    const settings = Settings.layer.pipe(
      Layer.provideMerge(Secrets.layer),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(Config.layerTest(home, home)),
    );
    const core = Service.layer.pipe(
      Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
      Layer.provideMerge(Environment.layerIdentity),
      Layer.provide(Repository.layer),
    );
    const services = layerMemoryHubServices.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(settings),
    );
    const routes = layerMemoryHubRoutes.pipe(
      HttpRouter.provideRequest(services),
      Layer.provideMerge(services),
    );
    const application = Layer.mergeAll(Environment.layer, Client.layer).pipe(
      Layer.provideMerge(routes),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(HttpRouter.layer),
    );
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Scope.Scope;
    const baseContext = yield* Layer.buildWithMemoMap(application, memoMap, scope);
    const instanceId = M.ProviderInstanceId.make(`fixture-${label}`);
    const selection = { instanceId, model: `model-${label}` };
    const entered = yield* Deferred.make<M.ResolveMemoryConflictInput>();
    const released = yield* Deferred.make<M.MemoryId>();
    let generated = 0;
    let claimed: M.MemoryResolutionLease | null = null;
    let descriptorHealthy = true;
    let probes = 0;
    let rearmObservations = 0;
    const probed = yield* Deferred.make<void>();
    const pulled = yield* Deferred.make<void>();
    let observePull = false;
    const sourcePolicy = yield* Ref.make<Owner.MemoryOwnerSourceReadCommitted>({
      version: 0,
      policy: M.DEFAULT_MEMORY_OWNER_SOURCE_READ_POLICY,
    });
    const sourceChanges = yield* PubSub.sliding<Owner.MemoryOwnerSourceReadCommitted>(1);
    const policyPort = Layer.succeed(Owner.MemoryOwnerSourceReadPolicyPort, {
      read: Ref.get(sourcePolicy),
      changes: Effect.succeed(Stream.fromPubSub(sourceChanges)),
      recordRevokeAck: (ack) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sourcePolicy);
          const removal = current.policy.removals.find(
            (r) => r.state === "pending" && M.matchesMemorySourceReadRevokeAck(r, ack),
          );
          if (!removal) return current;
          const policy = M.MemoryOwnerSourceReadPolicy.make({
            ...current.policy,
            ownerPolicyEpoch: current.policy.ownerPolicyEpoch + 1,
            removals: current.policy.removals.filter((r) => r !== removal),
            enrollments: current.policy.enrollments.map((e) =>
              e.state === "pending" &&
              M.matchesMemorySourceReadRevokeAck({ ...e, removalEpoch: e.removalEpoch }, ack)
                ? {
                    memorySpaceId: e.memorySpaceId,
                    ownerEnvironmentId: e.ownerEnvironmentId,
                    requesterEnvironmentId: e.requesterEnvironmentId,
                    ownerPolicyEpoch: current.policy.ownerPolicyEpoch + 1,
                    state: "active" as const,
                  }
                : e,
            ),
            allowedRequesterEnvironmentIds: current.policy.enrollments
              .filter(
                (e) =>
                  e.state === "active" ||
                  (e.state === "pending" && M.matchesMemorySourceReadRevokeAck(e, ack)),
              )
              .map((e) => e.requesterEnvironmentId),
          });
          const next = { policy, version: current.version + 1 };
          yield* Ref.set(sourcePolicy, next);
          yield* PubSub.publish(sourceChanges, next);
          return next;
        }),
    });
    const sourceRequested = yield* Deferred.make<M.MemorySourceReadRequest>();
    const sourceSecondRequested = yield* Deferred.make<M.MemorySourceReadRequest>();
    let sourceAdmissions = 0;
    let sourceAckFault: boolean | M.EnvironmentId = false;
    let sourceSendGate: Deferred.Deferred<void> | null = null;
    const sourceSendEntered = yield* Deferred.make<void>();
    let pullFault: "failure" | "budget" | null = null;
    let pullCalls = 0;
    let budgetOperation: Extract<M.MemoryOperation, { kind: "upsert" }> | null = null;
    const sourceResponses: M.MemorySourceReadOutcome[] = [];
    const sourceResult = yield* Deferred.make<M.MemoryHubSourceReadResultResult>();
    let sourceAfterResultGate: Deferred.Deferred<void> | null = null;
    let sourceResultGate: Deferred.Deferred<void> | null = null;
    const driver: ProviderDriver<{}> = {
      driverKind: M.ProviderDriverKind.make("codex"),
      metadata: { displayName: "Synthetic memory provider", hasDefaultInstance: false },
      configSchema: Schema.Struct({}),
      defaultConfig: () => ({}),
      create: (input) =>
        Effect.gen(function* () {
          const identity = Context.get(baseContext, Environment.ServerEnvironmentIdentity);
          const environmentId = yield* identity.getEnvironmentId;
          const textGeneration = Generation.TextGeneration.of({
            generateCommitMessage: () => Effect.die("unexpected provider operation"),
            generatePrContent: () => Effect.die("unexpected provider operation"),
            generateBranchName: () => Effect.die("unexpected provider operation"),
            generateThreadTitle: () => Effect.die("unexpected provider operation"),
            generateReviewGuide: () => Effect.die("unexpected provider operation"),
            resolveMemoryConflict: (request) =>
              Effect.gen(function* () {
                generated++;
                yield* Deferred.succeed(entered, request);
                if (resolve) return yield* resolve(request);
                return {
                  result: {
                    text: "resolved synthetic fact",
                    assertionKind: "inference" as const,
                    evidence: [],
                    judgment: "combine both synthetic versions",
                  },
                  execution: {
                    requestedModelSelection: request.modelSelection,
                    effectiveProvider: M.ProviderDriverKind.make("codex"),
                    effectiveModel: request.modelSelection.model,
                    providerInstanceId: input.instanceId,
                    environmentId,
                  },
                };
              }),
          });
          return {
            instanceId: input.instanceId,
            driverKind: M.ProviderDriverKind.make("codex"),
            continuationIdentity: {
              driverKind: M.ProviderDriverKind.make("codex"),
              continuationKey: `synthetic-${label}`,
            },
            displayName: input.displayName,
            enabled: true,
            snapshot: {} as ProviderInstance["snapshot"],
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration,
          };
        }),
    };
    const providers = Registry.layer({
      drivers: [driver],
      configMap: { [instanceId]: { driver: driver.driverKind, config: {}, enabled: true } },
    });
    const vcs = Layer.mergeAll(Git.layer, Vcs.layer).pipe(Layer.provideMerge(VcsProcess.layer));
    const sourceControl = SourceControl.layer.pipe(
      Layer.provide(SourceControlDrivers.layer),
      Layer.provide(vcs),
    );
    // Observe the real HTTP release after the coordinator's persisted finalize.
    // Even an erroneous release wakes the test, which asserts the actual state;
    // it cannot turn a failed resolution into a timeout-only oracle.
    const observedClient = Layer.effect(
      Client.MemoryHubClient,
      Effect.gen(function* () {
        const client = yield* Client.MemoryHubClient;
        return Client.MemoryHubClient.of({
          ...client,
          claim: (connection, input) =>
            client.claim(connection, input).pipe(
              Effect.tap((lease) =>
                Effect.sync(() => {
                  claimed = lease;
                }),
              ),
            ),
          preflight: (connection) =>
            client.preflight(connection).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  probes++;
                }),
              ),
              Effect.tap(() => Deferred.succeed(probed, undefined)),
            ),
          pull: (connection, input) =>
            Effect.suspend(() => {
              pullCalls++;
              if (pullFault === "failure")
                return Effect.fail(new M.MemoryHubError({ code: "storage_failed" }));
              if (pullFault === "budget" && budgetOperation) {
                const sequence = input.afterSequence + 1;
                const operationId = id(20000 + sequence);
                const memoryId = M.MemoryId.make(id(30000 + sequence));
                const revisionId = M.MemoryRevisionId.make(id(40000 + sequence));
                const operation = {
                  ...budgetOperation,
                  operationId,
                  memoryId,
                  expectedHeads: [],
                  revision: {
                    ...budgetOperation.revision,
                    operationId,
                    memoryId,
                    revisionId,
                    payloadRef: revisionId,
                    parents: [],
                  },
                };
                return Effect.succeed({
                  hasMore: true,
                  throughSequence: sequence,
                  highWatermark: input.highWatermark ?? 10000,
                  entries: [
                    {
                      kind: "operation" as const,
                      operation,
                      hubSequence: sequence,
                      receipt: {
                        operationId,
                        memoryId,
                        hubSequence: sequence,
                        operationDigest: memoryOperationDigest(operation),
                        outcome: "accepted" as const,
                      },
                    },
                  ],
                });
              }
              return client.pull(connection, input);
            }).pipe(
              Effect.tap(() => (observePull ? Deferred.succeed(pulled, undefined) : Effect.void)),
            ),
          requestSourceRead: (connection, input) =>
            client
              .requestSourceRead(connection, input)
              .pipe(
                Effect.tap((result) =>
                  Deferred.succeed(
                    ++sourceAdmissions === 2 ? sourceSecondRequested : sourceRequested,
                    result.request,
                  ),
                ),
              ),
          respondSourceRead: (connection, input, prepare) =>
            Effect.gen(function* () {
              if (sourceSendGate && input.kind === "normal") {
                yield* Deferred.succeed(sourceSendEntered, undefined);
                yield* Deferred.await(sourceSendGate);
              }
              if (!prepare && input.kind === "normal") sourceResponses.push(input.outcome);
              const observedPrepare = prepare?.pipe(
                Effect.tap((prepared) =>
                  Effect.sync(() => {
                    if (prepared.kind === "normal") sourceResponses.push(prepared.outcome);
                  }),
                ),
              );
              return yield* client.respondSourceRead(connection, input, observedPrepare);
            }).pipe(
              Effect.map((result) =>
                result.kind === "revoke" &&
                (sourceAckFault === true || sourceAckFault === result.ack.requesterEnvironmentId)
                  ? {
                      ...result,
                      ack: {
                        ...result.ack,
                        ownerEnvironmentId: M.EnvironmentId.make("wrong-owner"),
                      },
                    }
                  : result,
              ),
            ),
          resultSourceRead: (connection, input) =>
            Effect.suspend(() =>
              (sourceResultGate ? Deferred.await(sourceResultGate) : Effect.void).pipe(
                Effect.andThen(client.resultSourceRead(connection, input)),
                Effect.tap((result) => Deferred.succeed(sourceResult, result)),
                Effect.tap(() =>
                  sourceAfterResultGate ? Deferred.await(sourceAfterResultGate) : Effect.void,
                ),
              ),
            ),
          release: (connection, input) =>
            client
              .release(connection, input)
              .pipe(
                Effect.onExit(() => Deferred.succeed(released, input.memoryId).pipe(Effect.asVoid)),
              ),
        });
      }),
    ).pipe(Layer.provideMerge(Runtime.layer.pipe(Layer.provide(policyPort))));
    const observedRuntime = Layer.effect(
      Sync.MemorySyncRuntime,
      Effect.gen(function* () {
        const runtime = yield* Sync.MemorySyncRuntime;
        return Sync.MemorySyncRuntime.of({
          ...runtime,
          rearmEvents: runtime.rearmEvents!.pipe(
            Stream.tap(() =>
              Effect.sync(() => {
                rearmObservations++;
              }),
            ),
          ),
        });
      }),
    ).pipe(Layer.provideMerge(observedClient));
    const syncLayer = Layer.mergeAll(Sync.layer, Worker.layer).pipe(
      Layer.provide(Maintenance.layer),
      Layer.provide(OrchestrationRuntime.layerEventSink),
      Layer.provide(RuntimeIdentity.layer),
      Layer.provideMerge(observedRuntime),
      Layer.provideMerge(Generation.layer.pipe(Layer.provide(sourceControl))),
      Layer.provideMerge(providers),
      Layer.provideMerge(Layer.succeedContext(baseContext)),
    );
    const context = yield* Layer.buildWithMemoMap(syncLayer, memoMap, scope);
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context);
    const identity = yield* run(
      Environment.ServerEnvironmentIdentity.use((s) => s.getEnvironmentId),
    );
    const admin = Context.get(context, Hub.MemoryHubAdministrator);
    const update: typeof admin.update = (input, permit) => run(admin.update(input, permit));
    const descriptor = run(Environment.ServerEnvironment.use((s) => s.getDescriptor));
    const serve = Effect.gen(function* () {
      const descriptorRoute = HttpRouter.add(
        "GET",
        GOAT_ENVIRONMENT_PATH,
        descriptor.pipe(
          Effect.map((view) =>
            HttpServerResponse.jsonUnsafe(
              descriptorHealthy
                ? view
                : { ...view, capabilities: { ...view.capabilities, memoryHubProtocolVersion: 99 } },
            ),
          ),
        ),
      );
      const served = yield* Layer.buildWithMemoMap(
        HttpRouter.serve(descriptorRoute, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(Layer.succeedContext(context)),
        ),
        memoMap,
        scope,
      );
      const server = Context.get(served, HttpServer.HttpServer);
      // layerTest listens on a wildcard address; clients must use loopback.
      const endpoint = new URL(HttpServer.formatAddress(server.address));
      endpoint.hostname = "127.0.0.1";
      return M.MemoryHubEndpoint.make(endpoint.origin);
    });
    const connection = run(
      Effect.gen(function* () {
        const snapshot = yield* (yield* Settings.MemoryHubCommittedSettings).read;
        if (snapshot.settings.mode !== "member")
          return yield* Effect.die("member configuration required");
        return { ...snapshot.settings, epoch: snapshot.version };
      }),
    );
    const sync = Context.get(context, Sync.MemorySyncService);
    const worker = Context.get(context, Worker.MemoryWorker);
    // Two explicit phases: receive/push, finish persisted scanner work, then
    // discover the newly eligible frontier. No polling or elapsed-time oracle.
    const tick = Effect.gen(function* () {
      yield* sync.syncOnce;
      yield* worker.drain;
      yield* sync.syncOnce;
      yield* worker.drain;
    });
    const startProduction = Layer.buildWithMemoMap(
      layerMemorySyncStarted.pipe(Layer.provide(Layer.succeedContext(context))),
      memoMap,
      scope,
    ).pipe(Effect.map((started) => Context.get(started, Sync.MemorySyncService)));
    const aggregate = (space: M.MemorySpaceId, memory: M.MemoryId) =>
      run(Store.MemoryStore.use((s) => s.loadAggregate(space, memory)));
    return {
      home,
      run,
      identity,
      update,
      descriptor,
      serve,
      connection,
      sync,
      worker,
      tick,
      selection,
      entered,
      aggregate,
      released,
      generated: () => generated,
      claimed: () => claimed,
      startProduction,
      setDescriptorHealthy: (healthy: boolean) => {
        descriptorHealthy = healthy;
      },
      probes: () => probes,
      rearmObservations: () => rearmObservations,
      probed,
      pulled,
      observeNextPull: () => {
        observePull = true;
      },
      sourcePolicy,
      sourceResponses,
      sourceSendEntered,
      blockSourceSend: (gate: Deferred.Deferred<void>) => {
        sourceSendGate = gate;
      },
      setPullFault: (
        fault: "failure" | "budget",
        operation: Extract<M.MemoryOperation, { kind: "upsert" }>,
      ) => {
        pullFault = fault;
        budgetOperation = operation;
      },
      pullCalls: () => pullCalls,
      commitSourcePolicy: (policy: M.MemoryOwnerSourceReadPolicy) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sourcePolicy);
          const next = {
            version: current.version + 1,
            policy: M.MemoryOwnerSourceReadPolicy.make(policy),
          };
          yield* Ref.set(sourcePolicy, next);
          // Explicit syncOnce is the milestone in fixtures; a background stream also
          // sees the real commit notification once production startup subscribes.
          yield* PubSub.publish(sourceChanges, next);
        }),
      setSourceAckFault: (fault: boolean | M.EnvironmentId) => {
        sourceAckFault = fault;
      },
      sourceSecondRequested,
      sourceRequested,
      sourceResult,
      blockAfterSourceResult: (gate: Deferred.Deferred<void>) => {
        sourceAfterResultGate = gate;
      },
      blockSourceResult: (gate: Deferred.Deferred<void>) => {
        sourceResultGate = gate;
      },
    };
  });

it.effect(
  "installCredential automatically bootstraps fresh production Sync for isolated H/A/B over real HTTP",
  () =>
    Effect.gen(function* () {
      const h = yield* environment("H");
      const a = yield* environment("A");
      const b = yield* environment("B");
      assert.strictEqual(new Set([h.home, a.home, b.home]).size, 3);
      assert.strictEqual(new Set([h.identity, a.identity, b.identity]).size, 3);
      assert.strictEqual((yield* h.descriptor).capabilities.memoryHubProtocolVersion, undefined);
      const configured = yield* h.update(
        {
          requestId: id(1),
          expectedVersion: 0,
          action: "configure",
          settings: { mode: "hub", memorySpaceId: null },
        },
        Effect.void,
      );
      if (
        configured.view.settings.mode !== "hub" ||
        configured.view.settings.memorySpaceId === null
      )
        return yield* Effect.die("hub configure did not publish a space");
      const space = configured.view.settings.memorySpaceId;
      const descriptor = yield* h.descriptor;
      assert.strictEqual(descriptor.environmentId, h.identity);
      assert.strictEqual(descriptor.capabilities.memoryHubProtocolVersion, 1);
      yield* h.run(
        Effect.gen(function* () {
          const store = yield* Store.MemoryStore;
          const self = yield* store.readHubMember(space, h.identity);
          assert.strictEqual(self?.status, "active");
          const retention = yield* store.transact(store.readHubRetentionTx(space));
          assert.strictEqual(retention.checkpointId, `initial-${id(1)}`);
        }),
      );
      const endpoint = yield* h.serve;
      for (const [index, member] of [a, b].entries()) {
        const current = yield* h.run(Settings.MemoryHubCommittedSettings.use((s) => s.read));
        const provisioned = yield* h.update(
          {
            requestId: id(10 + index),
            expectedVersion: current.version,
            action: "provisionMember",
            environmentId: member.identity,
          },
          Effect.void,
        );
        if (provisioned.credential === null)
          return yield* Effect.die("missing issued member credential");
        yield* member.update(
          {
            requestId: id(20 + index),
            expectedVersion: 0,
            action: "installCredential",
            hubEnvironmentId: h.identity,
            endpoint,
            memorySpaceId: space,
            credential: provisioned.credential.credential,
          },
          Effect.void,
        );
        assert.strictEqual(
          (yield* member.descriptor).capabilities.memoryHubProtocolVersion,
          undefined,
        );
        // Installation alone leaves an unbound replica; production startup owns
        // its first HTTP join and bootstrap. No preparatory join or ready seed.
        const progress = yield* member.run(
          Store.MemoryStore.use((store) =>
            store.readBootstrap({
              memorySpaceId: space,
              hubEnvironmentId: h.identity,
            }),
          ),
        );
        assert.strictEqual(progress.state, "unbound");
        assert.strictEqual(yield* member.startProduction, member.sync);
        assert.deepStrictEqual(yield* member.sync.readLocalReadiness(), {
          memorySpaceId: space,
          bootstrap: "ready",
        });
        assert.strictEqual(
          (yield* member.run(
            Store.MemoryStore.use((store) =>
              store.readBootstrap({ memorySpaceId: space, hubEnvironmentId: h.identity }),
            ),
          )).state,
          "ready",
        );

        const fs = yield* FileSystem.FileSystem;
        const dbPath = yield* member.run(
          Config.ServerConfig.use((config) => Effect.succeed(config.dbPath)),
        );
        assert.isTrue(yield* fs.exists(dbPath));
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

type Replica = Effect.Success<ReturnType<typeof environment>>;
const cluster = (resolveB?: Resolve) =>
  Effect.gen(function* () {
    const h = yield* environment("H");
    const a = yield* environment("A");
    const b = yield* environment("B", resolveB);
    const configured = yield* h.update(
      {
        requestId: id(1000),
        expectedVersion: 0,
        action: "configure",
        settings: { mode: "hub", memorySpaceId: null },
      },
      Effect.void,
    );
    if (configured.view.settings.mode !== "hub" || configured.view.settings.memorySpaceId === null)
      return yield* Effect.die("missing configured space");
    const space = configured.view.settings.memorySpaceId;
    const endpoint = yield* h.serve;
    for (const [index, member] of [a, b].entries()) {
      const view = yield* h.run(Settings.MemoryHubCommittedSettings.use((s) => s.read));
      const provisioned = yield* h.update(
        {
          requestId: id(1010 + index),
          expectedVersion: view.version,
          action: "provisionMember",
          environmentId: member.identity,
        },
        Effect.void,
      );
      if (provisioned.credential === null) return yield* Effect.die("missing issued credential");
      yield* member.update(
        {
          requestId: id(1020 + index),
          expectedVersion: 0,
          action: "installCredential",
          hubEnvironmentId: h.identity,
          endpoint,
          memorySpaceId: space,
          credential: provisioned.credential.credential,
        },
        Effect.void,
      );
      yield* member.run(
        Settings.ServerSettingsService.use((s) =>
          s.updateSettings({
            // Memory falls back from disabled instances, so the fixture model needs one.
            providerInstances: {
              [member.selection.instanceId]: {
                driver: M.ProviderDriverKind.make("codex"),
                enabled: true,
                config: {},
              },
            },
            memoryModelSelection: member.selection,
          }),
        ),
      );
      yield* member.tick;
      assert.deepStrictEqual(yield* member.sync.readLocalReadiness(), {
        memorySpaceId: space,
        bootstrap: "ready",
      });
    }
    yield* h.tick;
    assert.deepStrictEqual(yield* h.sync.readLocalReadiness(), {
      memorySpaceId: space,
      bootstrap: "ready",
    });
    return { h, a, b, space };
  });
const memory = (n: number) =>
  M.MemoryId.make(`00000000-0000-4000-9000-${String(n).padStart(12, "0")}`);
const write = (
  replica: Replica,
  space: M.MemorySpaceId,
  target: M.MemoryId,
  n: number,
  text: string,
  expectedHeads: readonly M.MemoryRevisionId[] = [],
) =>
  replica.run(
    Service.MemoryService.use((s) =>
      s.upsert(
        {
          memorySpaceId: space,
          memoryId: target,
          operationId: id(n),
          expectedHeads,
          scope: { kind: "user" },
          assertionKind: "inference",
          payload: { text, evidence: [], derivedFromMemoryRevisions: [] },
          baseBoundary: null,
        },
        Effect.void,
      ),
    ),
  );
const activeText = (aggregate: Store.MemoryAggregate) => {
  assert.strictEqual(aggregate.item?.status, "active");
  return aggregate.item?.status === "active" ? aggregate.item.payload.text : undefined;
};
const common = (c: Effect.Success<ReturnType<typeof cluster>>, target: M.MemoryId) =>
  Effect.gen(function* () {
    yield* write(c.a, c.space, target, 1100, "common parent");
    yield* c.a.tick;
    yield* c.b.tick;
    return (yield* c.a.aggregate(c.space, target)).heads;
  });

it.effect("a: A write propagates through real H HTTP to B", () =>
  Effect.gen(function* () {
    const c = yield* cluster();
    const target = memory(1);
    yield* write(c.a, c.space, target, 1101, "A shared fact");
    yield* c.a.tick;
    yield* c.b.tick;
    for (const replica of [c.a, c.h, c.b]) {
      assert.strictEqual(activeText(yield* replica.aggregate(c.space, target)), "A shared fact");
      assert.strictEqual(replica.generated(), 0);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("b: A forget dominates B concurrent edit and purges every replica", () =>
  Effect.gen(function* () {
    const c = yield* cluster();
    const target = memory(2);
    const heads = yield* common(c, target);
    yield* write(c.b, c.space, target, 1102, "B offline concurrent edit", heads);
    yield* c.a.run(
      Service.MemoryService.use((s) =>
        s.forget(
          { memorySpaceId: c.space, memoryId: target, operationId: id(1103), expectedHeads: heads },
          Effect.void,
        ),
      ),
    );
    yield* c.a.tick;
    yield* c.b.tick;
    yield* c.a.tick;
    for (const replica of [c.a, c.h, c.b]) {
      const aggregate = yield* replica.aggregate(c.space, target);
      assert.strictEqual(aggregate.item?.status, "forgotten");
      assert.isDefined(aggregate.tombstone);
      assert.isTrue(aggregate.revisions.every((r) => r.payload === null));
      assert.strictEqual(replica.generated(), 0);
    }
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "c: one conflicted memory is quarantined while unrelated memory continues during a blocked provider",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster(() => Effect.never);
      const target = memory(3);
      const heads = yield* common(c, target);
      yield* write(c.a, c.space, target, 1110, "A version", heads);
      yield* write(c.b, c.space, target, 1111, "B version", heads);
      yield* c.a.tick;
      yield* c.b.tick;
      const input = yield* Deferred.await(c.b.entered);
      assert.strictEqual(input.memoryId, target);
      assert.strictEqual((yield* c.h.aggregate(c.space, target)).item?.status, "quarantined");
      assert.strictEqual((yield* c.b.aggregate(c.space, target)).item?.status, "quarantined");
      const other = memory(30);
      yield* write(c.a, c.space, other, 1112, "unrelated healthy fact");
      yield* c.a.tick;
      yield* c.b.tick;
      assert.strictEqual(
        activeText(yield* c.b.aggregate(c.space, other)),
        "unrelated healthy fact",
      );
      assert.strictEqual((yield* c.b.aggregate(c.space, target)).item?.status, "quarantined");
      assert.strictEqual(c.b.generated(), 1);
      assert.strictEqual(c.a.generated(), 0);
      yield* c.b.sync.shutdown;
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "d/f: first observer B automatically resolves with its default provider and one revert reaches all replicas",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      const target = memory(4);
      const heads = yield* common(c, target);
      yield* write(c.a, c.space, target, 1120, "A original", heads);
      yield* write(c.b, c.space, target, 1121, "B original", heads);
      const aHead = (yield* c.a.aggregate(c.space, target)).heads[0]!;
      const bHead = (yield* c.b.aggregate(c.space, target)).heads[0]!;
      yield* c.a.tick;
      yield* c.b.tick;
      assert.strictEqual(yield* Deferred.await(c.b.released), target);
      yield* c.b.worker.drain;
      const input = yield* Deferred.await(c.b.entered);
      assert.deepStrictEqual(input.modelSelection, c.b.selection);
      assert.strictEqual(c.b.generated(), 1);
      assert.strictEqual(c.a.generated(), 0);
      yield* c.a.tick;
      const resolved = yield* c.b.aggregate(c.space, target);
      const resolution = resolved.resolutions[0]!;
      assert.deepStrictEqual([...resolution.inputRevisionIds].sort(), [aHead, bHead].sort());
      assert.strictEqual(resolution.resolvingEnvironmentId, c.b.identity);
      assert.deepStrictEqual(resolution.requestedModelSelection, c.b.selection);
      assert.strictEqual(resolution.effectiveProvider, "codex");
      assert.strictEqual(resolution.effectiveModel, "model-B");
      const history = yield* c.b.run(
        Service.MemoryService.use((s) =>
          s.history({ memorySpaceId: c.space, memoryId: target, limit: 100 }, Effect.void),
        ),
      );
      assert.deepStrictEqual(
        history.revisions
          .filter((r) => [aHead, bHead].includes(r.revision.revisionId))
          .map((r) => r.payload?.text)
          .sort(),
        ["A original", "B original"],
      );
      assert.strictEqual(
        history.resolutions[0]?.payload?.judgment,
        "combine both synthetic versions",
      );
      for (const replica of [c.a, c.h, c.b])
        assert.strictEqual(
          activeText(yield* replica.aggregate(c.space, target)),
          "resolved synthetic fact",
        );
      yield* c.b.run(
        Service.MemoryService.use((s) =>
          s.revertResolution(
            {
              memorySpaceId: c.space,
              memoryId: target,
              operationId: id(1122),
              resolutionId: resolution.resolutionId,
              restoredRevisionId: aHead,
              expectedHeads: resolved.heads,
            },
            Effect.void,
          ),
        ),
      );
      yield* c.b.tick;
      yield* c.a.tick;
      for (const replica of [c.a, c.h, c.b])
        assert.strictEqual(activeText(yield* replica.aggregate(c.space, target)), "A original");
      assert.strictEqual(c.b.generated(), 1);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "e: departed holder cannot release and A takes over only after the hub lease expires",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster(() => Effect.never);
      const target = memory(5);
      const heads = yield* common(c, target);
      yield* write(c.a, c.space, target, 1130, "A takeover original", heads);
      yield* write(c.b, c.space, target, 1131, "B takeover original", heads);
      yield* c.a.tick;
      yield* c.b.tick;
      yield* Deferred.await(c.b.entered);
      const lease = (yield* c.h.aggregate(c.space, target)).fence?.activeLease;
      assert.isDefined(lease);
      if (!lease) return yield* Effect.die("missing holder lease");
      assert.strictEqual(lease.holderEnvironmentId, c.b.identity);
      assert.strictEqual(Date.parse(lease.expiresAtHubTime), 120000);
      // Losing the member's local transport credential leaves Hub authority and
      // its lease intact. Revocation would invalidate that lease immediately.
      const departedConnection = yield* c.b.connection;
      yield* c.b.run(
        Secrets.ServerSecretStore.use((secrets) =>
          secrets.set(departedConnection.secretName, new TextEncoder().encode("A".repeat(43))),
        ),
      );
      const releaseDenied = yield* c.b.run(
        Client.MemoryHubClient.use((client) =>
          Effect.result(
            client.release(departedConnection, {
              protocolVersion: 1,
              memorySpaceId: c.space,
              memoryId: target,
              conflictId: lease.conflictId,
              holderEnvironmentId: c.b.identity,
              attemptId: lease.attemptId,
              fencingToken: lease.fencingToken,
            }),
          ),
        ),
      );
      assert.strictEqual(releaseDenied._tag, "Failure");
      if (releaseDenied._tag === "Failure")
        assert.strictEqual(releaseDenied.failure._tag, "MemoryHubUnauthorizedError");
      yield* c.b.sync.shutdown;
      yield* c.a.tick;
      assert.strictEqual(c.a.generated(), 0);
      assert.strictEqual((yield* c.h.aggregate(c.space, target)).item?.status, "quarantined");
      assert.deepStrictEqual((yield* c.h.aggregate(c.space, target)).fence?.activeLease, lease);
      yield* TestClock.adjust(119999);
      assert.strictEqual(c.a.generated(), 0);
      assert.deepStrictEqual((yield* c.h.aggregate(c.space, target)).fence?.activeLease, lease);
      yield* TestClock.adjust(1);
      yield* c.a.tick;
      assert.strictEqual(yield* Deferred.await(c.a.released), target);
      yield* c.a.worker.drain;
      assert.strictEqual(c.a.generated(), 1);
      const takeover = c.a.claimed();
      assert.isNotNull(takeover);
      if (takeover === null) return yield* Effect.die("missing observed takeover claim");
      assert.strictEqual(Date.parse(takeover.claimedAtHubTime), 120000);
      assert.strictEqual(Date.parse(takeover.expiresAtHubTime), 240000);
      assert.isAbove(takeover.fencingToken, lease.fencingToken);
      // Approval already fences the canonical lease. Cleanup release may be
      // refused; durable resolution and lease retirement prove completion.
      assert.isNull((yield* c.h.aggregate(c.space, target)).fence?.activeLease ?? null);
      assert.strictEqual(
        activeText(yield* c.a.aggregate(c.space, target)),
        "resolved synthetic fact",
      );
      assert.strictEqual(
        (yield* c.h.aggregate(c.space, target)).resolutions[0]?.resolvingEnvironmentId,
        c.a.identity,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "requester receives terminal denied from fail-closed owner while unrelated HTTP sync continues",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      const target = memory(6);
      const sourceThread = {
        environmentId: c.b.identity,
        threadId: M.ThreadId.make("synthetic-owner-thread"),
      };
      const watermark = {
        fromEventId: M.EventId.make("synthetic-from"),
        toEventId: M.EventId.make("synthetic-to"),
        throughSequence: 8,
      };
      const messageId = M.MessageId.make("synthetic-owner-message");
      const operation: Extract<M.MemoryOperation, { kind: "upsert" }> = {
        protocolVersion: 1,
        kind: "upsert",
        memorySpaceId: c.space,
        memoryId: target,
        operationId: id(1140),
        originEnvironmentId: c.a.identity,
        expectedHeads: [],
        revision: {
          memorySpaceId: c.space,
          memoryId: target,
          operationId: id(1140),
          revisionId: M.MemoryRevisionId.make(id(1141)),
          payloadRef: M.MemoryRevisionId.make(id(1141)),
          parents: [],
          scope: { kind: "user" },
          assertionKind: "inference",
          createdAtUtc: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
          provenance: { environmentId: c.a.identity, sourceThread, sourceWatermark: watermark },
        },
        payload: {
          text: "synthetic linked summary",
          evidence: [{ origin: "thread", sourceThread, watermark, messageIds: [messageId] }],
          derivedFromMemoryRevisions: [],
        },
      };
      const connection = yield* c.a.connection;
      yield* c.a.run(
        Client.MemoryHubClient.use((client) =>
          client.push(connection, {
            protocolVersion: 1,
            memorySpaceId: c.space,
            environmentId: c.a.identity,
            operations: [operation],
          }),
        ),
      );
      yield* c.a.tick;
      const validated = yield* c.a.run(
        Service.MemoryService.use((service) =>
          service.prepareSourceRead(
            {
              memorySpaceId: c.space,
              memoryId: target,
              sourceThread,
              messageIds: [messageId],
              limit: 10,
            },
            Effect.void,
          ),
        ),
      );
      const resultGate = yield* Deferred.make<void>();
      c.a.blockSourceResult(resultGate);
      const requester = yield* c.a.sync.readSource(validated, Effect.void).pipe(Effect.forkScoped);
      const request = yield* Deferred.await(c.a.sourceRequested);
      const denied = yield* c.b.run(
        Sync.MemorySyncRuntime.use((runtime) => Effect.result(runtime.ownerPermit(request))),
      );
      assert.strictEqual(denied._tag, "Failure");
      if (denied._tag === "Failure") {
        assert.strictEqual(denied.failure._tag, "MemoryAccessError");
        assert.strictEqual(denied.failure.code, "route_unavailable");
      }
      const other = memory(60);
      yield* write(c.b, c.space, other, 1143, "ordinary sync survives source denial");
      yield* c.b.sync.syncOnce;
      assert.strictEqual(
        activeText(yield* c.h.aggregate(c.space, other)),
        "ordinary sync survives source denial",
      );
      const status = yield* c.b.sync.syncStatus({}, Effect.void);
      assert.strictEqual(status.failureCode, "route_unavailable");
      yield* Deferred.succeed(resultGate, undefined);
      assert.deepStrictEqual(yield* Fiber.join(requester), {
        kind: "denied",
        requiredPermission: "orchestration:read",
      });
      const outcome = yield* Deferred.await(c.a.sourceResult);
      assert.strictEqual(outcome.state, "completed");
      if (outcome.state !== "completed") return yield* Effect.die("source request stayed pending");
      assert.deepStrictEqual(outcome.outcome, {
        kind: "denied",
        requiredPermission: "orchestration:read",
      });
      yield* c.a.tick;
      assert.strictEqual(
        activeText(yield* c.a.aggregate(c.space, other)),
        "ordinary sync survives source denial",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "production scoped startup reuses Sync and exposes real unbound processing and storage",
  () =>
    Effect.gen(function* () {
      const replica = yield* environment("A");
      assert.strictEqual(yield* replica.startProduction, replica.sync);
      assert.strictEqual(yield* replica.startProduction, replica.sync);
      yield* replica.run(
        Sync.MemorySyncRuntime.use((runtime) =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* runtime.readIntentBinding!, {
              memorySpaceId: null,
              coordinatorEpoch: 0,
              enabled: false,
            });
            const processing = yield* runtime.readProcessing(null, null);
            assert.strictEqual(processing.pendingSync, 0);
            assert.strictEqual(processing.quarantined, 0);
            const storage = yield* runtime.readUnboundStorage;
            assert.strictEqual(storage.checkpointSequence, 0);
            assert.strictEqual(storage.retentionFloor, 0);
            const status = yield* replica.sync.syncStatus({}, Effect.void);
            assert.strictEqual(status.state, "disabled");
            assert.strictEqual(status.memorySpaceId, null);
            assert.deepStrictEqual(status.processing, processing.processing);
            yield* Store.MemoryStore.use((store) =>
              store.putLocalIntent({
                intentId: "synthetic-unbound",
                environmentId: replica.identity,
                memoryId: memory(90),
                scope: { kind: "user" },
                assertionKind: "inference",
                provenance: { environmentId: replica.identity },
                createdAtUtc: M.MemoryUtcTimestamp.make("1970-01-01T00:00:00.000Z"),
                payload: {
                  text: "synthetic local draft",
                  evidence: [],
                  derivedFromMemoryRevisions: [],
                },
              }),
            );
            assert.strictEqual((yield* runtime.readProcessing(null, null)).pendingSync, 1);
            const draftStorage = yield* runtime.readUnboundStorage;
            assert.strictEqual(
              draftStorage.quotas.find((quota) => quota.dimension === "work_items")?.current,
              1,
            );
            assert.isAbove(
              draftStorage.quotas.find((quota) => quota.dimension === "work_bytes")?.current ?? 0,
              0,
            );
            assert.strictEqual((yield* replica.sync.syncStatus({}, Effect.void)).pendingSync, 1);
          }),
        ),
      );
      yield* replica.worker.start();
      yield* replica.worker.drain;
      assert.strictEqual(replica.generated(), 0);
      yield* replica.sync.shutdown;
      assert.strictEqual(yield* replica.sync.activeResolutions, 0);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "hub device writes propagate H to A/B and A writes reach H local replica over real HTTP",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      const fromHub = memory(70);
      yield* write(c.h, c.space, fromHub, 1170, "H device memory");
      yield* c.h.tick;
      yield* c.a.tick;
      yield* c.b.tick;
      for (const replica of [c.h, c.a, c.b])
        assert.strictEqual(
          activeText(yield* replica.aggregate(c.space, fromHub)),
          "H device memory",
        );
      const fromA = memory(71);
      yield* write(c.a, c.space, fromA, 1171, "A device memory");
      yield* c.a.tick;
      yield* c.h.tick;
      yield* c.b.tick;
      for (const replica of [c.h, c.a, c.b]) {
        assert.strictEqual(activeText(yield* replica.aggregate(c.space, fromA)), "A device memory");
        assert.strictEqual(replica.generated(), 0);
      }
      assert.strictEqual((yield* c.h.sync.readLocalReadiness()).bootstrap, "ready");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "production adapter and recovery probe recover one protocol hold without duplicate rearm observations",
  () =>
    Effect.gen(function* () {
      const c = yield* cluster();
      c.h.setDescriptorHealthy(false);
      const held = yield* Effect.result(c.a.sync.syncOnce);
      assert.strictEqual(held._tag, "Failure");
      if (held._tag === "Failure") {
        assert.strictEqual(held.failure._tag, "MemoryHubError");
        if (held.failure._tag === "MemoryHubError")
          assert.strictEqual(held.failure.code, "unsupported_protocol");
      }
      const retry = () =>
        c.a.run(
          Store.MemoryStore.use((store) =>
            store.readPullRetry({
              memorySpaceId: c.space,
              hubEnvironmentId: c.h.identity,
            }),
          ),
        );
      assert.strictEqual((yield* retry()).holdClass, "protocol");
      assert.strictEqual((yield* retry()).nextAttemptAt, Number.MAX_SAFE_INTEGER);
      c.h.setDescriptorHealthy(true);
      c.a.observeNextPull();
      yield* c.a.startProduction;
      assert.strictEqual(c.a.probes(), 0);
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(c.a.probed);
      yield* Deferred.await(c.a.pulled);
      yield* c.a.tick;
      assert.strictEqual((yield* retry()).holdClass, null);
      assert.strictEqual(c.a.probes(), 1);
      assert.strictEqual(c.a.rearmObservations(), 0);
      yield* c.a.tick;
      assert.strictEqual(c.a.probes(), 1);
      assert.strictEqual(c.a.rearmObservations(), 0);
      yield* c.a.sync.shutdown;
    }).pipe(Effect.provide(NodeServices.layer)),
);

// A real three-environment hub/HTTP/SQL/Sync/owner reader chain. Only the
// committed policy port is a fake; L5 owns its filesystem persistence and CAS.
const sourceFixture = (ownerIsHub = false) =>
  Effect.gen(function* () {
    const c = yield* cluster();
    const owner = ownerIsHub ? c.h : c.b;
    const target = memory(901);
    const thread = {
      environmentId: owner.identity,
      threadId: M.ThreadId.make("relay-fixture-thread"),
    };
    const messageId = M.MessageId.make("relay-fixture-message");
    const assistantId = M.MessageId.make("relay-fixture-assistant");
    const runId = M.RunId.make("relay-fixture-run");
    const watermark = {
      fromEventId: M.EventId.make(id(9100)),
      toEventId: M.EventId.make(id(9113)),
      throughSequence: 4,
    };
    const msg = M.OrchestrationV2ConversationMessageJson.make({
      id: messageId,
      threadId: thread.threadId,
      runId: null,
      nodeId: null,
      createdBy: "user",
      creationSource: "web",
      role: "user",
      text: "synthetic original from owner",
      attachments: [],
      streaming: false,
      createdAt: DateTime.makeUnsafe(0),
      updatedAt: DateTime.makeUnsafe(0),
    });
    const encodeMessage = Schema.encodeEffect(
      Schema.fromJsonString(M.OrchestrationV2ConversationMessageJson),
    );
    const encodeRun = Schema.encodeEffect(Schema.fromJsonString(M.OrchestrationV2RunJson));
    const run = (status: M.OrchestrationV2RunJson["status"]) =>
      M.OrchestrationV2RunJson.make({
        id: runId,
        threadId: thread.threadId,
        ordinal: 1,
        providerInstanceId: owner.selection.instanceId,
        modelSelection: owner.selection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: DateTime.makeUnsafe(0),
        startedAt: DateTime.makeUnsafe(0),
        completedAt: status === "running" ? null : DateTime.makeUnsafe(0),
        checkpointId: null,
        contextHandoffId: null,
      });
    yield* owner.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO orchestration_v2_projection_threads(thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${thread.threadId},'fixture-project','fixture','codex','full-access','default','1970-01-01T00:00:00.000Z','1970-01-01T00:00:00.000Z','{}')`;
        yield* sql`INSERT INTO orchestration_events(sequence,event_id,stream_id,event_type,payload_json,occurred_at,application_event_version,aggregate_kind,stream_version,actor_kind,metadata_json) VALUES (1,${watermark.fromEventId},${thread.threadId},'message.updated',${yield* encodeMessage(msg)},'1970-01-01T00:00:00.000Z',2,'thread',1,'user','{}')`;
      }),
    );
    yield* owner.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const assistant = {
          ...msg,
          id: assistantId,
          role: "assistant" as const,
          createdBy: "agent" as const,
          runId,
          text: "synthetic completed answer",
        };
        yield* sql`INSERT INTO orchestration_events(sequence,event_id,stream_id,event_type,payload_json,occurred_at,application_event_version,aggregate_kind,stream_version,actor_kind,metadata_json) VALUES (2,${id(9111)},${thread.threadId},'run.created',${yield* encodeRun(run("running"))},'1970-01-01T00:00:00.000Z',2,'thread',2,'system','{}')`;
        yield* sql`INSERT INTO orchestration_events(sequence,event_id,stream_id,event_type,payload_json,occurred_at,application_event_version,aggregate_kind,stream_version,actor_kind,metadata_json) VALUES (3,${id(9112)},${thread.threadId},'message.updated',${yield* encodeMessage(assistant)},'1970-01-01T00:00:00.000Z',2,'thread',3,'system','{}')`;
        yield* sql`INSERT INTO orchestration_events(sequence,event_id,stream_id,event_type,payload_json,occurred_at,application_event_version,aggregate_kind,stream_version,actor_kind,metadata_json) VALUES (4,${watermark.toEventId},${thread.threadId},'run.updated',${yield* encodeRun(run("completed"))},'1970-01-01T00:00:00.000Z',2,'thread',4,'system','{}')`;
      }),
    );
    const op: M.MemoryOperation = {
      protocolVersion: 1,
      kind: "upsert",
      memorySpaceId: c.space,
      memoryId: target,
      operationId: id(9101),
      originEnvironmentId: c.a.identity,
      expectedHeads: [],
      revision: {
        memorySpaceId: c.space,
        memoryId: target,
        operationId: id(9101),
        revisionId: M.MemoryRevisionId.make(id(9102)),
        payloadRef: M.MemoryRevisionId.make(id(9102)),
        parents: [],
        scope: { kind: "user" },
        assertionKind: "inference",
        createdAtUtc: "1970-01-01T00:00:00.000Z",
        provenance: {
          environmentId: c.a.identity,
          sourceThread: thread,
          sourceWatermark: watermark,
        },
      },
      payload: {
        text: "synthetic linked summary",
        evidence: [
          {
            origin: "thread",
            sourceThread: thread,
            watermark,
            messageIds: [messageId, assistantId],
          },
        ],
        derivedFromMemoryRevisions: [],
      },
    };
    const connection = yield* c.a.connection;
    yield* c.a.run(
      Client.MemoryHubClient.use((client) =>
        client.push(connection, {
          protocolVersion: 1,
          memorySpaceId: c.space,
          environmentId: c.a.identity,
          operations: [op],
        }),
      ),
    );
    yield* c.a.tick;
    if (!ownerIsHub) yield* c.b.tick;
    yield* owner.commitSourcePolicy({
      allowedRequesterEnvironmentIds: [c.a.identity],
      ownerPolicyEpoch: 1,
      removals: [],
      enrollments: [
        {
          memorySpaceId: c.space,
          ownerEnvironmentId: owner.identity,
          requesterEnvironmentId: c.a.identity,
          ownerPolicyEpoch: 1,
          state: "active",
        },
      ],
    });
    const validated = yield* c.a.run(
      Service.MemoryService.use((service) =>
        service.prepareSourceRead(
          {
            memorySpaceId: c.space,
            memoryId: target,
            sourceThread: thread,
            messageIds: [messageId, assistantId],
            limit: 10,
          },
          Effect.void,
        ),
      ),
    );
    const remove = (reenroll = false) =>
      owner.commitSourcePolicy({
        allowedRequesterEnvironmentIds: [],
        ownerPolicyEpoch: reenroll ? 3 : 2,
        removals: [
          {
            memorySpaceId: c.space,
            ownerEnvironmentId: owner.identity,
            requesterEnvironmentId: c.a.identity,
            removalEpoch: 2,
            state: "pending",
          },
        ],
        enrollments: reenroll
          ? [
              {
                memorySpaceId: c.space,
                ownerEnvironmentId: owner.identity,
                requesterEnvironmentId: c.a.identity,
                ownerPolicyEpoch: 3,
                removalEpoch: 2,
                state: "pending",
              },
            ]
          : [],
      });
    return {
      ...c,
      owner,
      target,
      thread,
      messageId,
      assistantId,
      watermark,
      validated,
      remove,
      sourceOperation: op,
    };
  });

it.effect.each([false, true])(
  `scenario g: reads original on its owner, consumes transient body (owner=hub %s)`,
  (localOwner) =>
    Effect.gen(function* () {
      const c = yield* sourceFixture(localOwner);
      const gate = yield* Deferred.make<void>();
      c.a.blockSourceResult(gate);
      const fiber = yield* c.a.sync.readSource(c.validated, Effect.void).pipe(Effect.forkScoped);
      const request = yield* Deferred.await(c.a.sourceRequested);
      yield* c.owner.sync.syncOnce;
      yield* Deferred.succeed(gate, undefined);
      const outcome = yield* Fiber.join(fiber);
      assert.deepStrictEqual(outcome, {
        kind: "available",
        page: {
          sourceThread: c.thread,
          watermark: c.watermark,
          messages: [
            { messageId: c.messageId, text: "synthetic original from owner" },
            { messageId: c.assistantId, text: "synthetic completed answer" },
          ],
          nextCursor: null,
        },
      });
      assert.isDefined(request.stamp);
      assert.notStrictEqual(request.requestId, c.validated.request.requestId);
      for (const env of [c.h, c.a])
        yield* env.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.strictEqual(
              (yield* sql`SELECT 1 FROM memory_payloads WHERE body_json LIKE '%synthetic original from owner%'`)
                .length,
              0,
            );
          }),
        );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  `revocation linearizes at hub result Tx (released before revoke %s)`,
  (released) =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      const gate = yield* Deferred.make<void>();
      const admissionGate = yield* Deferred.make<void>();
      c.a.blockSourceResult(released ? admissionGate : gate);
      if (released) c.a.blockAfterSourceResult(gate);
      const fiber = yield* c.a.sync.readSource(c.validated, Effect.void).pipe(Effect.forkScoped);
      yield* Deferred.await(c.a.sourceRequested);
      yield* c.owner.sync.syncOnce;
      if (released) {
        yield* Deferred.succeed(admissionGate, undefined);
        const result = yield* Deferred.await(c.a.sourceResult);
        assert.strictEqual(result.state, "completed");
      }
      yield* c.remove(true);
      const before = yield* Ref.get(c.owner.sourcePolicy);
      assert.deepStrictEqual(before.policy.allowedRequesterEnvironmentIds, []);
      yield* c.owner.sync.syncOnce;
      const after = yield* Ref.get(c.owner.sourcePolicy);
      assert.deepStrictEqual(after.policy.removals, []);
      assert.isAbove(after.policy.ownerPolicyEpoch, before.policy.ownerPolicyEpoch);
      assert.strictEqual(
        after.policy.enrollments[0]?.ownerPolicyEpoch,
        after.policy.ownerPolicyEpoch,
      );
      assert.deepStrictEqual(after.policy.allowedRequesterEnvironmentIds, [c.a.identity]);
      yield* Deferred.succeed(gate, undefined);
      const outcome = yield* Fiber.join(fiber);
      assert.strictEqual(outcome.kind, released ? "available" : "denied");
      // Duplicate old revoke cannot close the newer active enrollment's response.
      const connection = yield* c.owner.connection;
      const revoke = {
        protocolVersion: 1 as const,
        kind: "revoke" as const,
        memorySpaceId: c.space,
        requesterEnvironmentId: c.a.identity,
        ownerPolicyEpoch: 2,
      };
      const first = yield* c.owner.run(
        Client.MemoryHubClient.use((client) => client.respondSourceRead(connection, revoke)),
      );
      const second = yield* c.owner.run(
        Client.MemoryHubClient.use((client) => client.respondSourceRead(connection, revoke)),
      );
      assert.deepStrictEqual(first, second);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "caller revocation after await denies exposure and independent callers use separate IDs",
  () =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      const gate = yield* Deferred.make<void>();
      c.a.blockSourceResult(gate);
      let live = true;
      const permit = Effect.suspend(() =>
        live
          ? Effect.void
          : Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" })),
      );
      const first = yield* c.a.sync
        .readSource(c.validated, permit)
        .pipe(Effect.result, Effect.forkScoped);
      const second = yield* c.a.sync.readSource(c.validated, Effect.void).pipe(Effect.forkScoped);
      yield* Deferred.await(c.a.sourceRequested);
      const request1 = yield* Deferred.await(c.a.sourceRequested);
      const request2 = yield* Deferred.await(c.a.sourceSecondRequested);
      assert.notStrictEqual(request1.requestId, request2.requestId);
      assert.notStrictEqual(request1.requestId, c.validated.request.requestId);
      yield* c.owner.sync.syncOnce;
      live = false;
      yield* Deferred.succeed(gate, undefined);
      assert.strictEqual((yield* Fiber.join(first))._tag, "Failure");
      const secondResult = yield* Fiber.join(second);
      assert.strictEqual(secondResult.kind, "available");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("requester rejects a denied live caller permit before hub admission", () =>
  Effect.gen(function* () {
    const c = yield* sourceFixture();
    const denied = Effect.fail(new Service.MemoryAccessError({ code: "route_unavailable" }));
    const error = yield* c.a.sync.readSource(c.validated, denied).pipe(Effect.flip);
    assert.strictEqual(error._tag, "MemoryAccessError");
    yield* c.h.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        assert.strictEqual((yield* sql`SELECT 1 FROM memory_hub_source_reads`).length, 0);
      }),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "hub commit before lost owner ack preserves pending reenrollment and retries the same fence",
  () =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      const gate = yield* Deferred.make<void>();
      c.a.blockSourceResult(gate);
      const fiber = yield* c.a.sync.readSource(c.validated, Effect.void).pipe(Effect.forkScoped);
      const request = yield* Deferred.await(c.a.sourceRequested);
      yield* c.owner.sync.syncOnce;
      c.owner.setSourceAckFault(true);
      yield* c.remove(true);
      yield* c.owner.sync.syncOnce;
      const pending = yield* Ref.get(c.owner.sourcePolicy);
      assert.strictEqual(pending.policy.removals[0]?.state, "pending");
      assert.strictEqual(pending.policy.enrollments[0]?.state, "pending");
      assert.deepStrictEqual(pending.policy.allowedRequesterEnvironmentIds, []);
      const denied = yield* c.owner.run(
        Sync.MemorySyncRuntime.use((runtime) => Effect.result(runtime.ownerPermit(request))),
      );
      assert.strictEqual(denied._tag, "Failure");
      yield* c.h.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const rows = yield* sql<{
            record_json: string;
          }>`SELECT record_json FROM memory_import_keys WHERE key_kind='hub_source_fences'`;
          assert.strictEqual(rows.length, 1);
        }),
      );
      c.owner.setSourceAckFault(false);
      yield* c.owner.sync.syncOnce;
      const acknowledged = yield* Ref.get(c.owner.sourcePolicy);
      assert.deepStrictEqual(acknowledged.policy.removals, []);
      assert.isAbove(acknowledged.policy.ownerPolicyEpoch, pending.policy.ownerPolicyEpoch);
      assert.strictEqual(acknowledged.policy.enrollments[0]?.state, "active");
      assert.deepStrictEqual(acknowledged.policy.allowedRequesterEnvironmentIds, [c.a.identity]);
      yield* Deferred.succeed(gate, undefined);
      assert.deepStrictEqual(yield* Fiber.join(fiber), {
        kind: "denied",
        requiredPermission: "orchestration:read",
      });
      const nextGate = yield* Deferred.make<void>();
      c.a.blockSourceResult(nextGate);
      const next = yield* c.a.sync.readSource(c.validated, Effect.void).pipe(Effect.forkScoped);
      const nextRequest = yield* Deferred.await(c.a.sourceSecondRequested);
      assert.notStrictEqual(nextRequest.requestId, request.requestId);
      yield* c.owner.sync.syncOnce;
      const connection = yield* c.owner.connection;
      yield* c.owner.run(
        Client.MemoryHubClient.use((client) =>
          client.respondSourceRead(connection, {
            protocolVersion: 1,
            kind: "revoke",
            memorySpaceId: c.space,
            requesterEnvironmentId: c.a.identity,
            ownerPolicyEpoch: 2,
          }),
        ),
      );
      yield* Deferred.succeed(nextGate, undefined);
      assert.strictEqual((yield* Fiber.join(next)).kind, "available");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "settles offline policy removal after reclamation and continues past one failed ack",
  () =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      const connection = yield* c.a.connection;
      const submission = {
        ...c.validated.request,
        protocolVersion: 1 as const,
        requestId: M.MemorySourceReadRequestId.make(id(50000)),
      };
      const requested = yield* c.a.run(
        Client.MemoryHubClient.use((client) => client.requestSourceRead(connection, submission)),
      );
      const oldResponse: M.MemoryHubSourceReadRespondInput = {
        protocolVersion: 1,
        kind: "normal",
        memorySpaceId: c.space,
        requestId: submission.requestId,
        ownerPolicyEpoch: 1,
        outcome: {
          kind: "available",
          page: {
            sourceThread: c.thread,
            watermark: c.watermark,
            messages: [{ messageId: c.messageId, text: "synthetic original" }],
            nextCursor: null,
          },
        },
      };
      const ownerConnection = yield* c.owner.connection;
      yield* c.owner.run(
        Client.MemoryHubClient.use((client) =>
          client.respondSourceRead(ownerConnection, oldResponse),
        ),
      );
      yield* c.remove(); // owner is offline from here until the explicit syncOnce below
      const pending = yield* Ref.get(c.owner.sourcePolicy);
      yield* c.owner.commitSourcePolicy({
        ...pending.policy,
        removals: [
          ...pending.policy.removals,
          {
            memorySpaceId: c.space,
            ownerEnvironmentId: c.owner.identity,
            requesterEnvironmentId: c.h.identity,
            removalEpoch: 2,
            state: "pending",
          },
        ],
      });
      let sequence = 51000;
      const update = (action: "provisionMember" | "revokeMember", environmentId: M.EnvironmentId) =>
        Effect.gen(function* () {
          const current = yield* c.h.run(Settings.MemoryHubCommittedSettings.use((s) => s.read));
          return yield* c.h.update(
            { action, environmentId, requestId: id(sequence++), expectedVersion: current.version },
            Effect.void,
          );
        });
      // Synthetic filler rows only; Remove/reclaim/auth/relay are production paths.
      yield* c.h.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (let n = 0; n < 125; n++)
            yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at)
          VALUES (${c.space},${`offline-filler-${n}`},${(n + 1000).toString(16).padStart(64, "0")},1,'active',0)`;
        }),
      );
      yield* update("revokeMember", c.a.identity);
      yield* update("provisionMember", M.EnvironmentId.make("offline-replacement"));
      yield* c.h.run(
        Store.MemoryStore.use((store) =>
          store
            .readHubMember(c.space, c.a.identity)
            .pipe(Effect.tap((value) => Effect.sync(() => assert.isUndefined(value)))),
        ),
      );
      c.owner.setSourceAckFault(c.a.identity);
      yield* c.owner.sync.syncOnce;
      const partial = yield* Ref.get(c.owner.sourcePolicy);
      assert.strictEqual(partial.policy.removals.length, 1);
      assert.strictEqual(partial.policy.removals[0]!.requesterEnvironmentId, c.a.identity);
      c.owner.setSourceAckFault(false);
      yield* c.owner.sync.syncOnce;
      assert.deepStrictEqual((yield* Ref.get(c.owner.sourcePolicy)).policy.removals, []);
      assert.deepStrictEqual(
        (yield* Ref.get(c.owner.sourcePolicy)).policy.allowedRequesterEnvironmentIds,
        [],
      );
      // Old credential cannot submit or retrieve a relay after reclamation.
      assert.strictEqual(
        (yield* c.a
          .run(
            Client.MemoryHubClient.use((client) =>
              client.requestSourceRead(connection, {
                ...submission,
                requestId: M.MemorySourceReadRequestId.make(id(52000)),
              }),
            ),
          )
          .pipe(Effect.flip))._tag,
        "MemoryHubUnauthorizedError",
      );
      yield* update("revokeMember", M.EnvironmentId.make("offline-replacement"));
      const readded = yield* update("provisionMember", c.a.identity);
      const newPrincipal: M.MemoryHubPrincipal = {
        memorySpaceId: c.space,
        environmentId: c.a.identity,
        credentialVersion: readded.credential!.credentialVersion,
        scopes: ["memory:sync"],
      };
      assert.isAbove(
        newPrincipal.credentialVersion,
        requested.request.stamp!.requesterCredentialVersion,
      );
      yield* c.h.run(
        Effect.gen(function* () {
          const hub = yield* Hub.MemoryHubService;
          const owner = yield* (yield* Store.MemoryStore).readHubMember(c.space, c.owner.identity);
          assert.isFalse(
            (yield* hub.respondSourceRead(oldResponse, {
              ...newPrincipal,
              environmentId: c.owner.identity,
              credentialVersion: owner!.credentialVersion,
            })).accepted,
          );
          const staleResult = yield* hub
            .resultSourceRead(
              { protocolVersion: 1, memorySpaceId: c.space, requestId: submission.requestId },
              newPrincipal,
            )
            .pipe(Effect.flip);
          assert.strictEqual(staleResult._tag, "MemoryHubError");
          if (staleResult._tag === "MemoryHubError")
            assert.strictEqual(staleResult.code, "identity_mismatch");
          const next = yield* hub.requestSourceRead(
            { ...submission, requestId: M.MemorySourceReadRequestId.make(id(52001)) },
            newPrincipal,
          );
          assert.strictEqual(
            (yield* c.owner.run(
              Sync.MemorySyncRuntime.use((runtime) =>
                Effect.result(runtime.ownerPermit(next.request)),
              ),
            ))._tag,
            "Failure",
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["deleted thread", "pending forget"] as const)(
  "response submission revalidates owner source after reader completion: %s",
  (drift) =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      const resultGate = yield* Deferred.make<void>();
      const sendGate = yield* Deferred.make<void>();
      c.a.blockSourceResult(resultGate);
      c.owner.blockSourceSend(sendGate);
      const read = yield* c.a.sync.readSource(c.validated, Effect.void).pipe(Effect.forkScoped);
      yield* Deferred.await(c.a.sourceRequested);
      const cycle = yield* c.owner.sync.syncOnce.pipe(Effect.forkScoped);
      yield* Deferred.await(c.owner.sourceSendEntered);
      yield* c.owner.run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (drift === "deleted thread")
            yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at='deleted' WHERE thread_id=${c.thread.threadId}`;
          else
            yield* sql`INSERT INTO memory_pending_forget_intents(space,memory_id,operation_id,requested_at_utc,attempts,last_failure_code,submission_state) VALUES (${c.space},${c.target},${id(9991)},'1970-01-01T00:00:00.000Z',0,NULL,'unsubmitted')`;
        }),
      );
      yield* Deferred.succeed(sendGate, undefined);
      yield* Fiber.join(cycle);
      yield* Deferred.succeed(resultGate, undefined);
      const outcome = yield* Fiber.join(read);
      assert.notStrictEqual(outcome.kind, "available");
      assert.strictEqual(c.owner.sourceResponses.length, 1);
      assert.notStrictEqual(c.owner.sourceResponses[0]?.kind, "available");
      assert.isFalse(JSON.stringify(c.owner.sourceResponses).includes("synthetic original"));
      assert.isFalse(JSON.stringify(outcome).includes("synthetic original"));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["failure", "budget"] as const)(
  "propagates revoke independently of summary pull: %s",
  (fault) =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      yield* c.remove(true);
      c.owner.setPullFault(fault, c.sourceOperation);
      const before = c.owner.pullCalls();
      const cycle = yield* Effect.result(c.owner.sync.syncOnce);
      if (fault === "failure") assert.strictEqual(cycle._tag, "Failure");
      else {
        assert.strictEqual(cycle._tag, "Success");
        assert.strictEqual(c.owner.pullCalls() - before, 10);
      }
      const committed = yield* Ref.get(c.owner.sourcePolicy);
      assert.deepStrictEqual(committed.policy.removals, []);
      assert.strictEqual(committed.policy.enrollments[0]?.state, "active");
      assert.isAbove(committed.policy.enrollments[0]!.ownerPolicyEpoch, 2);
      assert.deepStrictEqual(committed.policy.allowedRequesterEnvironmentIds, [c.a.identity]);
    }).pipe(Effect.provide(NodeServices.layer)),
);
