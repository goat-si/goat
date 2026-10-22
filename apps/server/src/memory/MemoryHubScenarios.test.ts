import { assert, describe, it } from "@effect/vitest";
import * as M from "@goat/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Statement from "effect/sql/Statement";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpBody from "effect/http/HttpBody";
import * as Settings from "../serverSettings.ts";
import * as ServerConfig from "../config.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as RepositoryResolver from "../project/RepositoryIdentityResolver.ts";
import * as Store from "./MemoryStore.ts";
import * as Quota from "./MemoryQuotaService.ts";
import * as Service from "./MemoryService.ts";
import * as Hub from "./MemoryHubService.ts";
import * as Compactor from "./MemoryCompactor.ts";
import { layerMemoryHubServices, layerMemoryHubRoutes, layerMemoryHubStarted } from "../server.ts";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space = M.MemorySpaceId.make(id(1));
const memoryId = M.MemoryId.make(id(2));
const memberEnv = M.EnvironmentId.make("synthetic-source-owner");
const hubCredential = "d".repeat(43);
const operation = (
  n: number,
  environmentId: M.EnvironmentId,
): Extract<M.MemoryOperation, { kind: "upsert" }> => ({
  protocolVersion: 1,
  kind: "upsert",
  memorySpaceId: space,
  memoryId,
  operationId: M.MemoryOperationId.make(id(n)),
  originEnvironmentId: environmentId,
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
    provenance: { environmentId },
  },
  payload: { text: "synthetic memory", evidence: [], derivedFromMemoryRevisions: [] },
});

// r2 can reuse the actual HTTP/core fixture when L4's H/A/B drivers are integrated.
// No SyncService double, transcript reader or alternate admission path is installed.
const makeScenario = (fileSystem?: FileSystem.FileSystem) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "goat-memory-hub-scenario-" });
    const settings = Settings.layer.pipe(
      Layer.provideMerge(Secrets.layer),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    );
    const core = Service.layer.pipe(
      Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
      Layer.provideMerge(Environment.layerIdentity),
      Layer.provide(
        Layer.mock(RepositoryResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
        }),
      ),
    );
    const services = layerMemoryHubServices.pipe(
      Layer.provideMerge(core),
      Layer.provideMerge(settings),
    );
    const routes = layerMemoryHubRoutes.pipe(
      HttpRouter.provideRequest(services),
      Layer.provideMerge(services),
    );
    const app = Environment.layer.pipe(
      Layer.provideMerge(routes),
      Layer.provideMerge(
        fileSystem === undefined
          ? NodeServices.layer
          : Layer.merge(NodeServices.layer, Layer.succeed(FileSystem.FileSystem, fileSystem)),
      ),
    );
    const memoMap = yield* Layer.makeMemoMap;
    const scope = yield* Scope.Scope;
    const context = yield* Layer.buildWithMemoMap(
      app.pipe(Layer.provideMerge(HttpRouter.layer)),
      memoMap,
      scope,
    );
    const http = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(app, { memoMap, disableLogger: true })),
      (http) => Effect.promise(() => http.dispose()),
    );
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context);
    const hubEnv = yield* run(
      Environment.ServerEnvironmentIdentity.use((identity) => identity.getEnvironmentId),
    );
    const post = (path: string, body: unknown, credential: string | null = hubCredential) =>
      Effect.promise(() =>
        http.handler(
          new Request(`https://hub.invalid${path}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
            },
            body: JSON.stringify(body),
          }),
          Context.empty(),
        ),
      );
    const call = <A, I>(
      path: string,
      body: unknown,
      schema: Schema.Codec<A, I>,
      credential = hubCredential,
    ) =>
      Effect.gen(function* () {
        const response = yield* post(path, body, credential);
        assert.strictEqual(response.status, 200);
        assert.strictEqual(response.headers.get("cache-control"), "no-store");
        return yield* Schema.decodeUnknownEffect(schema)(
          yield* Effect.promise(() => response.json()),
        );
      });
    const configure = (mode: "hub" | "disabled") =>
      run(
        Effect.gen(function* () {
          const service = yield* Settings.ServerSettingsService;
          const transitions = yield* Settings.MemoryHubSettingsTransitions;
          const current = yield* service.getSettings;
          return yield* transitions.applyMemoryHubTransition(
            {
              requestId: M.MemoryOperationId.make(id(900 + current.memoryHubVersion)),
              expectedVersion: current.memoryHubVersion,
              settings: mode === "hub" ? { mode, memorySpaceId: space } : { mode },
            },
            Effect.void,
          );
        }),
      );
    const initialize = Effect.gen(function* () {
      yield* configure("hub");
      yield* run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const crypto = yield* Crypto.Crypto;
          const digest = Hex.encode(
            yield* crypto.digest("SHA-256", new TextEncoder().encode(hubCredential)),
          );
          yield* sql`INSERT INTO memory_hub_members(space,environment,credential_digest,credential_version,status,joined_at) VALUES (${space},${hubEnv},${digest},1,'active',0)`;
          const compactor = yield* Compactor.MemoryCompactor;
          yield* compactor.compact({
            memorySpaceId: space,
            environmentId: hubEnv,
            credentialVersion: 1,
            scopes: ["memory:sync"],
          });
        }),
      );
    });
    const push = (operations: readonly M.MemoryOperation[]) =>
      call(
        M.MEMORY_HUB_PATHS.push,
        {
          protocolVersion: 1,
          memorySpaceId: space,
          environmentId: hubEnv,
          operations,
        },
        M.MemoryHubPushResult,
      );
    return { run, post, call, configure, initialize, push, hubEnv, context, memoMap };
  });

const scenario = makeScenario();
const encodeSettingsJson = Schema.encodeEffect(Schema.fromJsonString(M.ServerSettings));

// Keep the actual cache lookup pending before it acquires the same SQLite
// connection. Synthetic watch events avoid depending on native fs.watch timing.
const pendingReloadScenario = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const events = yield* PubSub.unbounded<FileSystem.WatchEvent>();
  const watching = yield* Deferred.make<void>();
  const eventSeen = yield* Deferred.make<void>();
  const historyRequested = yield* Deferred.make<void>();
  const releaseHistory = yield* Deferred.make<void>();
  let holdHistory = false;
  const controlledFs = FileSystem.FileSystem.of({
    ...fs,
    watch: () =>
      Stream.unwrap(
        PubSub.subscribe(events).pipe(
          Effect.tap(() => Deferred.succeed(watching, undefined)),
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
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
  const s = yield* makeScenario(controlledFs).pipe(
    Effect.provideService(Statement.CurrentTransformer, transformer),
  );
  yield* s.initialize;
  const settings = Context.get(s.context, Settings.ServerSettingsService);
  yield* settings.start.pipe(Effect.provideService(Statement.CurrentTransformer, transformer));
  yield* Deferred.await(watching);
  const config = Context.get(s.context, ServerConfig.ServerConfig);
  const before = yield* settings.getSettings;
  const reload = (
    memoryHub: M.MemoryHubSettings = before.memoryHub,
    version = before.memoryHubVersion,
  ) =>
    Effect.gen(function* () {
      holdHistory = true;
      yield* fs.writeFileString(
        config.settingsPath,
        yield* encodeSettingsJson({
          ...before,
          memoryHub,
          memoryHubVersion: version,
        }),
      );
      yield* PubSub.publish(events, { _tag: "Update" as const, path: config.settingsPath });
      yield* Deferred.await(eventSeen);
      yield* TestClock.adjust(100);
      yield* Deferred.await(historyRequested);
    });
  const finishReload = Effect.gen(function* () {
    holdHistory = false;
    yield* Deferred.succeed(releaseHistory, undefined);
    yield* settings.getSettings;
  });
  return { ...s, reload, finishReload, before };
});

describe("Memory hub assembled HTTP scenarios", () => {
  it.effect.each(["join", "push admission", "capacity rollback", "compactor sweep"] as const)(
    "completes %s while provider-history reload is pending",
    (lane) =>
      Effect.gen(function* () {
        const s = yield* pendingReloadScenario;
        const store = Context.get(s.context, Store.MemoryStore);
        const hub = Context.get(s.context, Hub.MemoryHubService);
        const principal: M.MemoryHubPrincipal = {
          memorySpaceId: space,
          environmentId: s.hubEnv,
          credentialVersion: 1,
          scopes: ["memory:sync"],
        };
        if (lane === "capacity rollback") {
          yield* s.run(
            store.transact(
              Effect.gen(function* () {
                const usage = yield* store.readHubUsageTx(space);
                yield* store.reserveHubCheckpointTx({
                  memorySpaceId: space,
                  checkpointDeltaBytes: 0,
                  publishedPinnedDeltaBytes:
                    M.MEMORY_CHECKPOINT_STAGING_MAX_BYTES -
                    usage.requiredCheckpointBoundBytes -
                    usage.publishedPinnedBytes,
                });
              }),
            ),
          );
        }
        yield* s.reload();
        // The lookup remains gated until each real service transaction returns.
        if (lane === "join") {
          const joined = yield* s.run(
            hub.join(
              {
                protocolVersion: 1,
                memorySpaceId: space,
                environmentId: s.hubEnv,
              },
              principal,
            ),
          );
          assert.strictEqual(joined.memorySpaceId, space);
          assert.isNotEmpty(joined.snapshotToken);
        } else if (lane === "compactor sweep") {
          yield* s.run(Compactor.MemoryCompactor.use((compactor) => compactor.compact(principal)));
          const retention = yield* s.run(store.transact(store.readHubRetentionTx(space)));
          assert.isNotNull(retention.checkpointId);
        } else {
          const result = yield* s.run(
            hub.push(
              {
                protocolVersion: 1,
                memorySpaceId: space,
                environmentId: s.hubEnv,
                operations: [operation(20, s.hubEnv)],
              },
              principal,
            ),
          );
          const receipt = result.receipts[0]!;
          if (lane === "capacity rollback") {
            assert.strictEqual(receipt.failureCode, "capacity_exceeded");
            assert.isNull(receipt.hubSequence);
            assert.isUndefined((yield* s.run(store.loadAggregate(space, memoryId))).identity);
          } else {
            assert.strictEqual(receipt.outcome, "accepted");
            assert.strictEqual(receipt.hubSequence, 1);
          }
        }
        yield* s.finishReload;
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("observes external disable before provider-history SQL finishes", () =>
    Effect.gen(function* () {
      const s = yield* pendingReloadScenario;
      yield* s.reload({ mode: "disabled" }, s.before.memoryHubVersion + 1);
      const snapshot = yield* s.run(
        Settings.MemoryHubCommittedSettings.use((settings) => settings.read),
      );
      assert.deepStrictEqual(snapshot, {
        provenance: null,
        settings: { mode: "disabled" },
        version: s.before.memoryHubVersion + 1,
      });
      const store = Context.get(s.context, Store.MemoryStore);
      const configuration = Context.get(s.context, Hub.MemoryHubConfiguration);
      assert.isNull(yield* s.run(store.transact(configuration.read)));
      yield* s.finishReload;
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fences transactions begun immediately after disable commit", () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      yield* s.initialize;
      const enabledVersion = (yield* s.run(
        Settings.MemoryHubCommittedSettings.use((settings) => settings.read),
      )).version;
      yield* s.configure("disabled");
      const store = Context.get(s.context, Store.MemoryStore);
      const configuration = Context.get(s.context, Hub.MemoryHubConfiguration);
      const view = yield* s.run(
        store.transact(Settings.MemoryHubCommittedSettings.use((settings) => settings.read)),
      );
      assert.deepStrictEqual(view, {
        provenance: null,
        settings: { mode: "disabled" },
        version: enabledVersion + 1,
      });
      assert.strictEqual(
        view.version,
        (yield* s.run(Settings.ServerSettingsService.use((settings) => settings.getSettings)))
          .memoryHubVersion,
      );
      assert.isNull(yield* s.run(store.transact(configuration.read)));
      const result = yield* s
        .run(
          Hub.MemoryHubService.use((hub) =>
            hub.join(
              {
                protocolVersion: 1,
                memorySpaceId: space,
                environmentId: s.hubEnv,
              },
              {
                memorySpaceId: space,
                environmentId: s.hubEnv,
                credentialVersion: 1,
                scopes: ["memory:sync"],
              },
            ),
          ),
        )
        .pipe(Effect.result);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "MemoryHubError");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect.each([false, true] as const)(
    "joins a real checkpoint, pushes a fork, claims and applies one canonical resolution (shared alias bodies: %s)",
    (shared) =>
      Effect.gen(function* () {
        const s = yield* scenario;
        yield* s.initialize;
        const join = yield* s.call(
          M.MEMORY_HUB_PATHS.join,
          { protocolVersion: 1, memorySpaceId: space, environmentId: s.hubEnv },
          M.MemoryHubJoinResult,
        );
        const initial = yield* s.call(
          M.MEMORY_HUB_PATHS.pull,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            afterSequence: 0,
            limit: 100,
            snapshotToken: join.snapshotToken,
          },
          M.MemoryHubPullResult,
        );
        assert.strictEqual(initial.checkpoint?.bootstrapComplete, true);
        const sourceBase = operation(9, s.hubEnv);
        const sourceId = M.MemoryId.make(id(3));
        const source = {
          ...sourceBase,
          memoryId: sourceId,
          revision: { ...sourceBase.revision, memoryId: sourceId },
        };
        assert.strictEqual((yield* s.push([source])).receipts[0]!.outcome, "accepted");
        const firstBase = operation(10, s.hubEnv);
        const first = {
          ...firstBase,
          payload: {
            ...firstBase.payload,
            derivedFromMemoryRevisions: [source.revision.revisionId],
          },
        };
        assert.strictEqual((yield* s.push([first])).receipts[0]!.hubSequence, 2);
        const sibling = (n: number) => {
          const op = operation(n, s.hubEnv);
          return {
            ...op,
            expectedHeads: [first.revision.revisionId],
            revision: {
              ...op.revision,
              parents: [first.revision.revisionId],
              ...(shared
                ? {
                    payloadRef: first.revision.payloadRef,
                    provenance: {
                      environmentId: s.hubEnv,
                      importSource: {
                        sourceId: M.MemoryImportSourceId.make(id(9000)),
                        format: "codex" as const,
                        parserVersion: "synthetic-v1",
                        sourceLocator: "memory.md",
                        sourceItemKey: `alias-${n}`,
                        sourceFingerprint: "a".repeat(64),
                        contentFingerprint: "b".repeat(64),
                        sourceAliases: [],
                        acceptedContentFingerprints: [],
                      },
                    },
                  }
                : {}),
            },
            payload: {
              ...(shared ? first.payload : op.payload),
              derivedFromMemoryRevisions: [source.revision.revisionId],
            },
          };
        };
        yield* s.push([sibling(11), sibling(12)]);
        const aggregate = yield* s.run(
          Store.MemoryStore.use((store) => store.loadAggregate(space, memoryId)),
        );
        assert.deepStrictEqual([...aggregate.heads].sort(), [id(111), id(112)]);
        const claim: M.MemoryHubClaimInput = {
          protocolVersion: 1,
          memorySpaceId: space,
          memoryId,
          holderEnvironmentId: s.hubEnv,
          conflictId: aggregate.conflicts[0]!.conflictId,
          conflictHeadSet: aggregate.heads,
          attemptId: M.MemoryOperationId.make(id(50)),
          frozenDefaultModelSelection: {
            instanceId: M.ProviderInstanceId.make("synthetic-provider"),
            model: "synthetic-model",
          },
        };
        const lease = yield* s.call(M.MEMORY_HUB_PATHS.claim, claim, M.MemoryResolutionLease);
        const renewed = yield* s.call(
          M.MEMORY_HUB_PATHS.renew,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            memoryId,
            holderEnvironmentId: s.hubEnv,
            conflictId: claim.conflictId,
            attemptId: claim.attemptId,
            fencingToken: lease.fencingToken,
          },
          M.MemoryResolutionLease,
        );
        assert.strictEqual(renewed.fencingToken, lease.fencingToken);
        const base = operation(80, s.hubEnv);
        const resolutionId = M.MemoryResolutionId.make(id(81));
        const op: Extract<M.MemoryOperation, { kind: "resolve" }> = {
          ...base,
          kind: "resolve",
          expectedHeads: aggregate.heads,
          revision: { ...base.revision, parents: aggregate.heads },
          // Match the resolver: preserve both direct inputs and their inherited lineage.
          payload: {
            ...base.payload,
            derivedFromMemoryRevisions: [...aggregate.heads, source.revision.revisionId],
          },
          conflictId: claim.conflictId,
          fencingToken: lease.fencingToken,
          resolution: {
            resolutionId,
            memorySpaceId: space,
            memoryId,
            inputRevisionIds: aggregate.heads,
            inputPayloadRefs: aggregate.heads.map(
              (id) =>
                aggregate.revisions.find((r) => r.revision.revisionId === id)!.revision.payloadRef,
            ),
            judgmentRef: resolutionId,
            requestedModelSelection: claim.frozenDefaultModelSelection,
            effectiveProvider: M.ProviderDriverKind.make("codex"),
            effectiveModel: "synthetic-model",
            resolvingEnvironmentId: s.hubEnv,
            fencingToken: lease.fencingToken,
            resultRevisionId: base.revision.revisionId,
            appliedAtUtc: M.MemoryUtcTimestamp.make("2000-01-01T00:00:00.000Z"),
            revertDeadlineUtc: M.MemoryUtcTimestamp.make("2000-01-02T00:00:00.000Z"),
          },
          resolutionPayload: { resolutionId, judgment: "synthetic judgment" },
        };
        const apply = {
          protocolVersion: 1,
          memorySpaceId: space,
          holderEnvironmentId: s.hubEnv,
          attemptId: claim.attemptId,
          operation: op,
        };
        const receipt = yield* s.call(
          M.MEMORY_HUB_PATHS.applyResolution,
          apply,
          M.MemoryHubReceipt,
        );
        assert.strictEqual(receipt.outcome, "accepted", receipt.failureCode);
        assert.strictEqual(receipt.hubSequence, 5);
        assert.deepStrictEqual(
          yield* s.call(M.MEMORY_HUB_PATHS.applyResolution, apply, M.MemoryHubReceipt),
          receipt,
        );
        const pull = yield* s.call(
          M.MEMORY_HUB_PATHS.pull,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            afterSequence: 0,
            limit: 100,
          },
          M.MemoryHubPullResult,
        );
        assert.strictEqual(pull.entries.length, 5);
        assert.strictEqual(pull.throughSequence, 5);
        const resolved = yield* s.run(
          Store.MemoryStore.use((store) => store.loadAggregate(space, memoryId)),
        );
        assert.deepStrictEqual(
          [
            ...resolved.revisions.find(
              (pair) => pair.revision.revisionId === base.revision.revisionId,
            )!.payload!.derivedFromMemoryRevisions,
          ].sort(),
          [...aggregate.heads, source.revision.revisionId].sort(),
        );
        assert.deepStrictEqual(
          (yield* s.run(Store.MemoryStore.use((store) => store.loadAggregate(space, memoryId))))
            .heads,
          [base.revision.revisionId],
        );
        yield* s.run(
          Compactor.MemoryCompactor.use((compactor) =>
            compactor.compact({
              memorySpaceId: space,
              environmentId: s.hubEnv,
              credentialVersion: 1,
              scopes: ["memory:sync"],
            }),
          ),
        );
        // Production producer must retain the old member's immutable checkpoint token.
        const pinned = yield* s.call(
          M.MEMORY_HUB_PATHS.pull,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            afterSequence: 0,
            limit: 100,
            snapshotToken: join.snapshotToken,
          },
          M.MemoryHubPullResult,
        );
        assert.deepStrictEqual(pinned.checkpoint, initial.checkpoint);
        yield* s.run(
          Service.MemoryService.use((service) =>
            service.forget(
              {
                memorySpaceId: space,
                memoryId: sourceId,
                operationId: M.MemoryOperationId.make(id(82)),
                expectedHeads: [source.revision.revisionId],
              },
              Effect.void,
            ),
          ),
        );
        const forgotten = yield* s.run(
          Store.MemoryStore.use((store) => store.loadAggregate(space, memoryId)),
        );
        assert.strictEqual(forgotten.item?.status, "blocked");
        assert.ok(forgotten.revisions.every((pair) => pair.payload === null));
        assert.strictEqual(
          (yield* s.run(
            SqlClient.SqlClient.use(
              (sql) =>
                sql`SELECT 1 FROM memory_payloads WHERE space=${space} AND memory_id=${memoryId}`,
            ),
          )).length,
          0,
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "relays only the owner's synthetic source through four actual routes and purges it",
    () =>
      Effect.gen(function* () {
        const s = yield* scenario;
        yield* s.initialize;
        const provisioned = yield* s.run(
          Effect.gen(function* () {
            const settings = yield* Settings.ServerSettingsService;
            const admin = yield* Hub.MemoryHubAdministrator;
            return yield* admin.update(
              {
                requestId: M.MemoryOperationId.make(id(600)),
                expectedVersion: (yield* settings.getSettings).memoryHubVersion,
                action: "provisionMember",
                environmentId: memberEnv,
              },
              Effect.void,
            );
          }),
        );
        assert.ok(provisioned.credential);
        const sourceThread: M.ScopedThreadRef = {
          environmentId: memberEnv,
          threadId: M.ThreadId.make("synthetic-thread"),
        };
        const watermark: M.MemorySourceWatermark = {
          fromEventId: M.EventId.make("synthetic-from"),
          toEventId: M.EventId.make("synthetic-to"),
          throughSequence: 8,
        };
        const messageId = M.MessageId.make("synthetic-message");
        const base = operation(10, s.hubEnv);
        yield* s.push([
          {
            ...base,
            revision: {
              ...base.revision,
              provenance: { environmentId: s.hubEnv, sourceThread, sourceWatermark: watermark },
            },
            payload: {
              text: "synthetic linked summary",
              evidence: [{ origin: "thread", sourceThread, watermark, messageIds: [messageId] }],
              derivedFromMemoryRevisions: [],
            },
          },
        ]);
        const requestId = M.MemorySourceReadRequestId.make(id(300));
        yield* s.call(
          M.MEMORY_HUB_PATHS.sourceReadRequest,
          {
            protocolVersion: 1,
            memorySpaceId: space,
            memoryId,
            requestId,
            sourceThread,
            sourceWatermark: watermark,
            messageIds: [messageId],
            limit: 10,
            authorizedScopes: ["memory:read", "orchestration:read"],
          },
          M.MemoryHubSourceReadRequestResult,
        );
        const collect = { protocolVersion: 1, memorySpaceId: space, limit: 32 };
        assert.strictEqual(
          (yield* s.call(
            M.MEMORY_HUB_PATHS.sourceReadCollect,
            collect,
            M.MemoryHubSourceReadCollectResult,
          )).requests.length,
          0,
        );
        assert.strictEqual(
          (yield* s.call(
            M.MEMORY_HUB_PATHS.sourceReadCollect,
            collect,
            M.MemoryHubSourceReadCollectResult,
            provisioned.credential.credential,
          )).requests.length,
          1,
        );
        const outcome: M.MemorySourceReadOutcome = {
          kind: "available",
          page: {
            sourceThread,
            watermark,
            messages: [{ messageId, text: "synthetic original" }],
            nextCursor: null,
          },
        };
        yield* s.call(
          M.MEMORY_HUB_PATHS.sourceReadRespond,
          {
            protocolVersion: 1,
            kind: "normal",
            ownerPolicyEpoch: 1,
            memorySpaceId: space,
            requestId,
            outcome,
          },
          M.MemoryHubSourceReadRespondResult,
          provisioned.credential.credential,
        );
        assert.deepStrictEqual(
          yield* s.call(
            M.MEMORY_HUB_PATHS.sourceReadResult,
            { protocolVersion: 1, memorySpaceId: space, requestId },
            M.MemoryHubSourceReadResultResult,
          ),
          { state: "completed", outcome },
        );
        yield* s.run(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            assert.strictEqual(
              (yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM memory_payloads WHERE body_json LIKE '%synthetic original%'`)[0]!
                .count,
              0,
            );
            assert.strictEqual(
              (yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM memory_hub_operations`)[0]!.count,
              1,
            );
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("uses bearer identity for 401/403 and withdraws live advertisement when disabled", () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      const descriptor = s.run(
        Environment.ServerEnvironment.use((environment) => environment.getDescriptor),
      );
      assert.strictEqual((yield* descriptor).capabilities.memoryHubProtocolVersion, undefined);
      assert.strictEqual((yield* s.post(M.MEMORY_HUB_PATHS.push, {})).status, 503);
      yield* s.initialize;
      assert.strictEqual((yield* descriptor).capabilities.memoryHubProtocolVersion, 1);
      const push = {
        protocolVersion: 1,
        memorySpaceId: space,
        environmentId: s.hubEnv,
        operations: [],
      };
      assert.strictEqual((yield* s.post(M.MEMORY_HUB_PATHS.push, push, null)).status, 401);
      assert.strictEqual(
        (yield* s.post(M.MEMORY_HUB_PATHS.push, push, "x".repeat(43))).status,
        401,
      );
      assert.strictEqual(
        (yield* s.post(M.MEMORY_HUB_PATHS.push, { ...push, environmentId: memberEnv })).status,
        403,
      );
      yield* s.configure("disabled");
      assert.strictEqual((yield* descriptor).capabilities.memoryHubProtocolVersion, undefined);
      assert.strictEqual((yield* s.post(M.MEMORY_HUB_PATHS.push, push)).status, 503);
      assert.strictEqual(
        yield* s.run(Hub.MemoryHubConfiguration.use((configuration) => configuration.read)),
        null,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("serves externally registered hub routes across the server MemoMap boundary", () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      yield* s.initialize;
      // As in server.ts: route/descriptor acquisition happens in the parent map,
      // and serve forks that map while reusing the already acquired router/core.
      const served = yield* Layer.buildWithMemoMap(
        HttpRouter.serve(Layer.empty, {
          disableLogger: true,
          disableListenLog: true,
        }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(Layer.succeedContext(s.context)),
        ),
        s.memoMap,
        yield* Scope.Scope,
      );
      const client = Context.get(served, HttpClient.HttpClient);
      const request = () =>
        client.post(M.MEMORY_HUB_PATHS.push, {
          headers: { "content-type": "application/json", authorization: `Bearer ${hubCredential}` },
          body: HttpBody.jsonUnsafe({
            protocolVersion: 1,
            memorySpaceId: space,
            environmentId: s.hubEnv,
            operations: [],
          }),
        });
      const response = yield* request();
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(yield* response.json, { receipts: [] });
      const descriptor = s.run(
        Environment.ServerEnvironment.use((environment) => environment.getDescriptor),
      );
      const enabled = yield* descriptor;
      assert.strictEqual(enabled.capabilities.memoryHubProtocolVersion, 1);
      assert.deepStrictEqual(enabled.capabilities.memory, {
        protocolVersion: 1,
        refusedReverts: true,
        resolutionInputs: true,
        retainedLocalSpace: true,
        generationHold: true,
        hubDiagnostics: true,
      });
      yield* s.configure("disabled");
      const disabled = yield* descriptor;
      assert.strictEqual(disabled.environmentId, enabled.environmentId);
      assert.strictEqual(disabled.instanceId, enabled.instanceId);
      const { memoryHubProtocolVersion: _hubVersion, ...enabledCapabilities } =
        enabled.capabilities;
      assert.deepStrictEqual(disabled.capabilities, enabledCapabilities);
      assert.strictEqual((yield* request()).status, 503);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps waiting after readiness failure and starts once", () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      yield* s.initialize;
      const judged = yield* Deferred.make<void>();
      const releaseRead = yield* Deferred.make<void>();
      const retried = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const configuration = Context.get(s.context, Hub.MemoryHubConfiguration);
      const compactor = Context.get(s.context, Compactor.MemoryCompactor);
      let reads = 0;
      let starts = 0;
      const applicationScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(applicationScope, Exit.void));
      yield* Layer.buildWithScope(
        layerMemoryHubStarted.pipe(
          Layer.provide(
            Layer.succeed(Hub.MemoryHubConfiguration, {
              read: Effect.gen(function* () {
                reads++;
                if (reads === 1) {
                  yield* Deferred.succeed(judged, undefined);
                  yield* Deferred.await(releaseRead);
                  return yield* new M.MemoryHubError({ code: "storage_failed" });
                }
                const hub = yield* configuration.read;
                yield* Deferred.succeed(retried, undefined);
                return hub;
              }),
            }),
          ),
          Layer.provide(
            Layer.succeed(Compactor.MemoryCompactor, {
              ...compactor,
              start: (principal) =>
                compactor.start(principal).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      starts++;
                    }),
                  ),
                  Effect.tap(() => Deferred.succeed(started, undefined)),
                ),
            }),
          ),
          Layer.provide(Layer.succeedContext(s.context)),
        ),
        applicationScope,
      );
      yield* s.run(Settings.ServerSettingsService.use((settings) => settings.start));
      yield* Deferred.await(judged);
      yield* s.configure("disabled");
      yield* Deferred.succeed(releaseRead, undefined);
      yield* Deferred.await(retried);
      assert.strictEqual(starts, 0);
      yield* s.configure("hub");
      yield* Deferred.await(started);
      assert.strictEqual(starts, 1);
      yield* Scope.close(applicationScope, Exit.void);
      yield* s.configure("disabled");
      yield* s.configure("hub");
      assert.strictEqual(starts, 1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("retries a disabled initial sweep, starts once and stops with application Scope", () =>
    Effect.gen(function* () {
      const s = yield* scenario;
      yield* s.initialize;
      yield* s.configure("disabled");
      const judged = yield* Deferred.make<void>();
      const releaseStart = yield* Deferred.make<void>();
      const failed = yield* Deferred.make<string>();
      const started = yield* Deferred.make<void>();
      const prepared = yield* Deferred.make<void>();
      const timerReady = yield* Deferred.make<void>();
      const releaseTimer = yield* Deferred.make<void>();
      const store = Context.get(s.context, Store.MemoryStore);
      const retentionReads = new WeakSet<object>();
      const observedStore = Store.MemoryStore.of({
        ...store,
        readHubRetentionTx: (spaceId) => {
          const read = store.readHubRetentionTx(spaceId);
          retentionReads.add(read);
          return read;
        },
        transact: (effect, options) => {
          // Only the timer passes a standalone retention read to transact.
          // Hold it after commit, before sampling now, until the clock advances.
          const timerRead = retentionReads.has(effect);
          return store.transact(effect, options).pipe(
            Effect.tap(() =>
              timerRead
                ? Effect.gen(function* () {
                    yield* Deferred.succeed(timerReady, undefined);
                    yield* Deferred.await(releaseTimer);
                  })
                : Effect.void,
            ),
          );
        },
      });
      let starts = 0;
      let attempts = 0;
      const producer = Context.get(s.context, Compactor.MemoryHubCheckpointProducer);
      const compactor = yield* s.run(
        Compactor.make.pipe(
          Effect.provideService(Store.MemoryStore, observedStore),
          Effect.provideService(Compactor.MemoryHubCheckpointProducer, {
            prepareTx: (input) =>
              producer
                .prepareTx(input)
                .pipe(Effect.tap(() => Deferred.succeed(prepared, undefined))),
          }),
        ),
      );
      const observed = Compactor.MemoryCompactor.of({
        ...compactor,
        start: (principal) =>
          Effect.gen(function* () {
            attempts++;
            if (attempts === 1) {
              // The assembled readiness check has succeeded; disable before
              // the real compactor subscribes and runs its initial sweep.
              yield* Deferred.succeed(judged, undefined);
              yield* Deferred.await(releaseStart);
            }
            yield* compactor
              .start(principal)
              .pipe(
                Effect.tapError((error) =>
                  Deferred.succeed(failed, "code" in error ? error.code : error._tag),
                ),
              );
          }).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                starts++;
              }),
            ),
            Effect.tap(() => Deferred.succeed(started, undefined)),
          ),
      });
      const applicationScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(applicationScope, Exit.void));
      // Real file settings are not started yet. Layer acquisition must return;
      // waiting for readiness here would deadlock ServerRuntimeStartup.start.
      yield* Layer.buildWithScope(
        layerMemoryHubStarted.pipe(
          Layer.provide(Layer.succeed(Compactor.MemoryCompactor, observed)),
          Layer.provide(Layer.succeedContext(s.context)),
        ),
        applicationScope,
      );
      assert.strictEqual(starts, 0);
      yield* s.run(Settings.ServerSettingsService.use((settings) => settings.start));
      yield* s.configure("hub");
      yield* Deferred.await(judged);
      yield* s.configure("disabled");
      yield* Deferred.succeed(releaseStart, undefined);
      assert.strictEqual(yield* Deferred.await(failed), "hub_disabled");
      assert.strictEqual(starts, 0);
      yield* s.configure("hub");
      yield* Deferred.await(started);
      assert.strictEqual(attempts, 2);
      assert.strictEqual(starts, 1);
      const retention = s.run(
        Store.MemoryStore.use((store) => store.transact(store.readHubRetentionTx(space))),
      );
      yield* Deferred.await(timerReady);
      const before = yield* retention;
      yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS);
      yield* Deferred.succeed(releaseTimer, undefined);
      yield* Deferred.await(prepared);
      // Read through the writer lock after prepare, so the observation follows commit.
      const after = yield* retention;
      assert.notStrictEqual(after.checkpointId, before.checkpointId);
      assert.strictEqual(
        Date.parse(after.compaction.lastRunAtUtc!),
        M.MEMORY_CHECKPOINT_INTERVAL_MS,
      );
      yield* s.configure("disabled");
      yield* s.configure("hub");
      assert.strictEqual(starts, 1);
      assert.strictEqual(attempts, 2);
      yield* Scope.close(applicationScope, Exit.void);
      yield* TestClock.adjust(M.MEMORY_CHECKPOINT_INTERVAL_MS);
      yield* s.run(Hub.MemoryHubActivity.use((activity) => activity.notify));
      assert.deepStrictEqual(yield* retention, after);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
