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
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import * as DateTime from "effect/DateTime";
import * as Owner from "./memory/MemoryOwnerSourceReader.ts";
import * as Registry from "./provider/ProviderInstanceRegistry.ts";
import * as Generation from "./textGeneration/TextGeneration.ts";
import * as Sync from "./memory/MemorySyncService.ts";
import * as Worker from "./memory/MemoryWorker.ts";
import * as Maintenance from "./memory/MemoryFtsMaintenance.ts";
import * as RuntimeIdentity from "./runtimeIdentity.ts";
import * as OrchestrationRuntime from "./orchestration-v2/runtimeLayer.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Config from "./config.ts";
import * as Settings from "./serverSettings.ts";
import * as Secrets from "./auth/ServerSecretStore.ts";
import * as Sqlite from "./persistence/Sqlite.ts";
import * as Environment from "./environment/ServerEnvironment.ts";
import * as Repository from "./project/RepositoryIdentityResolver.ts";
import * as Store from "./memory/MemoryStore.ts";
import * as Quota from "./memory/MemoryQuotaService.ts";
import * as Service from "./memory/MemoryService.ts";
import * as Hub from "./memory/MemoryHubService.ts";
import * as Client from "./memory/MemoryHubClient.ts";
import {
  layerMemorySyncRuntime,
  layerMemoryHubServices,
  layerMemoryHubRoutes,
  layerMemorySourceReadService,
  layerMemorySourceReadBinding,
  MemorySourceReadBinding,
} from "./server.ts";
import * as PolicyBinding from "./memory/MemoryOwnerSourceReadPolicyBinding.ts";

import * as McpFixture from "./mcp/toolkits/memory/handlers.testkit.ts";
import * as AccessFixture from "./mcp/McpToolAccess.testkit.ts";
import * as McpHttp from "./mcp/McpHttpServer.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as Sessions from "./mcp/McpSessionRegistry.ts";
import { McpServer } from "effect/ai";

const id = (n: number) =>
  M.MemoryOperationId.make(`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
// All state belongs to temporary homes. Only transport milestones and unused
// provider/repository boundaries are doubles; settings, reader, hub and SQL are real.
const environment = (home: string) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const memo = yield* Layer.makeMemoMap;
    const settings = Settings.layer.pipe(
      Layer.provide(Environment.layerIdentity),
      Layer.provideMerge(Secrets.layer),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(Config.layerTest(home, home)),
    );
    const core = layerMemorySourceReadService.pipe(
      Layer.provideMerge(Quota.layer.pipe(Layer.provideMerge(Store.layer))),
      Layer.provideMerge(layerMemorySourceReadBinding),
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
    const base = yield* Layer.buildWithMemoMap(
      Layer.mergeAll(Environment.layer, Client.layer).pipe(
        Layer.provideMerge(routes),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provideMerge(HttpRouter.layer),
      ),
      memo,
      scope,
    );
    let requested = yield* Deferred.make<M.MemorySourceReadRequest>();
    let resultGate = yield* Deferred.make<void>();
    let sendGate: Deferred.Deferred<void> | undefined;
    const sendEntered = yield* Deferred.make<void>();
    const observed = Layer.effect(
      Client.MemoryHubClient,
      Effect.gen(function* () {
        const client = yield* Client.MemoryHubClient;
        return Client.MemoryHubClient.of({
          ...client,
          requestSourceRead: (c, i) =>
            client
              .requestSourceRead(c, i)
              .pipe(Effect.tap((r) => Deferred.succeed(requested, r.request))),
          resultSourceRead: (c, i) =>
            Deferred.await(resultGate).pipe(Effect.andThen(client.resultSourceRead(c, i))),
          respondSourceRead: (c, i, prepare) =>
            Effect.gen(function* () {
              if (i.kind === "normal" && sendGate) {
                yield* Deferred.succeed(sendEntered, undefined);
                yield* Deferred.await(sendGate);
              }
              return yield* client.respondSourceRead(c, i, prepare);
            }),
        });
      }),
    ).pipe(Layer.provideMerge(layerMemorySyncRuntime));
    let owningRun = true;
    let memoryEnabled = true;
    const context = yield* Layer.buildWithMemoMap(
      McpHttp.layerMemoryToolkit.pipe(
        Layer.provide(AccessFixture.layerPermissionProfilesOff),
        Layer.provideMerge(
          Layer.mergeAll(
            Sync.layer,
            Worker.layer,
            Sessions.layer.pipe(Layer.provide(NodeHttpServer.layerTest)),
          ),
        ),
        Layer.provide(Maintenance.layer),
        Layer.provide(OrchestrationRuntime.layerEventSink),
        Layer.provide(RuntimeIdentity.layer),
        Layer.provideMerge(observed),
        Layer.provide(
          Layer.succeed(Generation.TextGeneration, {
            generateCommitMessage: () => Effect.die("unexpected fixture provider call"),
            generatePrContent: () => Effect.die("unexpected fixture provider call"),
            generateBranchName: () => Effect.die("unexpected fixture provider call"),
            generateThreadTitle: () => Effect.die("unexpected fixture provider call"),
            generateReviewGuide: () => Effect.die("unexpected fixture provider call"),
          }),
        ),
        Layer.provide(
          Layer.mock(Registry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed(undefined),
          }),
        ),
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadShell: (tid) =>
              Effect.sync(() =>
                AccessFixture.liveThreadShell(tid, {
                  activeRunId: owningRun ? M.RunId.make("run:mcp-test") : null,
                }),
              ),
          }),
        ),
        Layer.provideMerge(Layer.succeedContext(base)),
      ),
      memo,
      scope,
    );
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.provideContext(effect, context);
    yield* run(
      Settings.ServerSettingsService.use((s) =>
        s.updateSettings({
          defaultModelSelection: {
            instanceId: M.ProviderInstanceId.make("fixture"),
            model: "fixture",
          },
        }),
      ),
    );
    const identity = yield* run(
      Environment.ServerEnvironmentIdentity.use((s) => s.getEnvironmentId),
    );
    const sync = Context.get(context, Sync.MemorySyncService);
    yield* Context.get(context, MemorySourceReadBinding).bind(sync);
    const worker = Context.get(context, Worker.MemoryWorker);
    const policy = Context.get(context, Settings.MemoryOwnerSourceReadCommittedPolicy);
    const admin = Context.get(context, Settings.MemoryOwnerSourceReadPolicyAdministration);
    const updatePolicy = (ids: readonly M.EnvironmentId[]) =>
      run(
        Effect.gen(function* () {
          const current = yield* policy.read;
          return yield* admin.update(
            {
              requestId: id(990),
              expectedVersion: current.version,
              allowedRequesterEnvironmentIds: ids,
            },
            Effect.void,
          );
        }),
      );
    const tick = Effect.gen(function* () {
      yield* sync.syncOnce;
      yield* worker.drain;
      yield* sync.syncOnce;
      yield* worker.drain;
    });
    const serve = Effect.gen(function* () {
      const route = HttpRouter.add(
        "GET",
        GOAT_ENVIRONMENT_PATH,
        run(Environment.ServerEnvironment.use((s) => s.getDescriptor)).pipe(
          Effect.map(HttpServerResponse.jsonUnsafe),
        ),
      );
      const served = yield* Layer.buildWithMemoMap(
        HttpRouter.serve(route, { disableLogger: true, disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(Layer.succeedContext(context)),
        ),
        memo,
        scope,
      );
      const endpoint = new URL(
        HttpServer.formatAddress(Context.get(served, HttpServer.HttpServer).address),
      );
      endpoint.hostname = "127.0.0.1";
      return M.MemoryHubEndpoint.make(endpoint.origin);
    });
    const connection = run(
      Settings.MemoryHubCommittedSettings.use((s) =>
        s.read.pipe(
          Effect.map((view) => {
            if (view.settings.mode !== "member") throw new Error("member required");
            return { ...view.settings, epoch: view.version };
          }),
        ),
      ),
    );
    return {
      home,
      run,
      identity,
      sync,
      worker,
      tick,
      policy,
      updatePolicy,
      serve,
      connection,
      sendEntered,
      update: (input: M.MemoryHubSettingsUpdateInput) =>
        run(Hub.MemoryHubAdministrator.use((s) => s.update(input, Effect.void))),
      begin: Effect.gen(function* () {
        requested = yield* Deferred.make<M.MemorySourceReadRequest>();
        resultGate = yield* Deferred.make<void>();
      }),
      request: () => Deferred.await(requested),
      releaseResult: () => Deferred.succeed(resultGate, undefined),
      blockSend: (gate: Deferred.Deferred<void>) => {
        sendGate = gate;
      },
      issue: (scopes: readonly M.AuthEnvironmentScope[]) =>
        run(
          Effect.gen(function* () {
            const registry = yield* Sessions.McpSessionRegistry;
            const policy = { grant: "read" as const, policyEpoch: 1 };
            const issued = yield* registry.issue({
              threadId: M.ThreadId.make("fixture-caller"),
              providerInstanceId: M.ProviderInstanceId.make("codex"),
              grantedScopes: scopes,
              capabilities: new Set(["memory"]),
              memoryPolicy: policy,
              readCurrentPolicy: () =>
                Effect.sync(() =>
                  memoryEnabled ? policy : { grant: "none" as const, policyEpoch: 2 },
                ),
              isLiveCaller: Effect.sync(() => owningRun),
            });
            const invocation = yield* registry.resolve(
              issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
            );
            if (!invocation) return yield* Effect.die("issued synthetic scope missing");
            return invocation;
          }),
        ),
      setMemoryEnabled: (value: boolean) => {
        memoryEnabled = value;
      },
      setOwningRun: (value: boolean) => {
        owningRun = value;
      },
      close: Scope.close(scope, Exit.void),
    };
  });
const cluster = () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const h = yield* environment(yield* fs.makeTempDirectoryScoped({ prefix: "wp4-compose2-h-" }));
    const a = yield* environment(yield* fs.makeTempDirectoryScoped({ prefix: "wp4-compose2-a-" }));
    const b = yield* environment(yield* fs.makeTempDirectoryScoped({ prefix: "wp4-compose2-b-" }));
    const configured = yield* h.update({
      requestId: id(1000),
      expectedVersion: 0,
      action: "configure",
      settings: { mode: "hub", memorySpaceId: null },
    });
    if (configured.view.settings.mode !== "hub" || !configured.view.settings.memorySpaceId)
      return yield* Effect.die("space required");
    const space = configured.view.settings.memorySpaceId;
    const endpoint = yield* h.serve;
    for (const [index, member] of [a, b].entries()) {
      const view = yield* h.run(Settings.MemoryHubCommittedSettings.use((s) => s.read));
      const provisioned = yield* h.update({
        requestId: id(1010 + index),
        expectedVersion: view.version,
        action: "provisionMember",
        environmentId: member.identity,
      });
      if (!provisioned.credential) return yield* Effect.die("credential required");
      yield* member.update({
        requestId: id(1020 + index),
        expectedVersion: 0,
        action: "installCredential",
        hubEnvironmentId: h.identity,
        endpoint,
        memorySpaceId: space,
        credential: provisioned.credential.credential,
      });
      yield* member.tick;
    }
    yield* h.tick;
    return { h, a, b, space };
  });
const memory = (n: number) => M.MemoryId.make(id(n));
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
        providerInstanceId: M.ProviderInstanceId.make("fixture"),
        modelSelection: { instanceId: M.ProviderInstanceId.make("fixture"), model: "fixture" },
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
    yield* owner.updatePolicy([c.a.identity]);
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
    const remove = () => owner.updatePolicy([]);
    const input = {
      memorySpaceId: c.space,
      memoryId: target,
      sourceThread: thread,
      messageIds: [messageId, assistantId],
      limit: 10,
    };
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
      input,
    };
  });

it.effect(
  "settings enrollment connects public readSource and managed MCP compound live permit to real relay",
  () =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      const expected = {
        sourceThread: c.thread,
        watermark: c.watermark,
        messages: [
          { messageId: c.messageId, text: "synthetic original from owner" },
          { messageId: c.assistantId, text: "synthetic completed answer" },
        ],
        nextCursor: null,
      };
      yield* c.a.begin;
      const read = yield* c.a
        .run(Service.MemoryService.use((s) => s.readSource(c.input, Effect.void)))
        .pipe(Effect.forkScoped);
      const stamped = yield* c.a.request();
      assert.isDefined(stamped.stamp);
      yield* c.owner.sync.syncOnce;
      yield* c.a.releaseResult();
      assert.deepStrictEqual(yield* Fiber.join(read), expected);
      const port = yield* c.owner.run(Owner.MemoryOwnerSourceReadPolicyPort);
      const runtime = yield* c.owner.run(Sync.MemorySyncRuntime);
      assert.strictEqual(runtime.ownerPolicy, port);
      assert.strictEqual(port.read, c.owner.policy.read);
      assert.strictEqual(port.changes, c.owner.policy.changes);
      for (const scopes of [["memory:read"], ["orchestration:read"]] as const) {
        const invocation = yield* c.a.issue(scopes);
        const denied = yield* c.a.run(McpFixture.call("memory_read_source", c.input, invocation));
        assert.isTrue(denied.result.isError === true);
      }
      const invocation = yield* c.a.issue(["memory:read", "orchestration:read"]);
      yield* c.a.begin;
      const mcp = yield* c.a
        .run(McpFixture.call("memory_read_source", c.input, invocation))
        .pipe(Effect.forkScoped);
      yield* c.a.request();
      yield* c.owner.sync.syncOnce;
      yield* c.a.releaseResult();
      const returned = yield* Fiber.join(mcp);
      assert.isFalse(returned.result.isError === true);
      assert.deepStrictEqual(returned.body, expected);
      // Reuse the issued scope: live registry reauthorization must reject ended runs.
      c.a.setOwningRun(false);
      const ended = yield* c.a.run(McpFixture.call("memory_read_source", c.input, invocation));
      assert.isTrue(ended.result.isError === true);
      c.a.setOwningRun(true);
      // Recheck the same scope after the network await, rather than just at admission.
      yield* c.a.begin;
      const inFlight = yield* c.a
        .run(McpFixture.call("memory_read_source", c.input, invocation))
        .pipe(Effect.forkScoped);
      yield* c.a.request();
      yield* c.owner.sync.syncOnce;
      c.a.setOwningRun(false);
      yield* c.a.releaseResult();
      assert.isTrue((yield* Fiber.join(inFlight)).result.isError === true);
      c.a.setOwningRun(true);
      yield* c.a.begin;
      const grantRevoked = yield* c.a
        .run(McpFixture.call("memory_read_source", c.input, invocation))
        .pipe(Effect.forkScoped);
      yield* c.a.request();
      yield* c.owner.sync.syncOnce;
      c.a.setMemoryEnabled(false);
      yield* c.a.releaseResult();
      assert.isTrue((yield* Fiber.join(grantRevoked)).result.isError === true);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "committed removal denies an in-flight response; hub ack commits removal deletion and opens reenrollment",
  () =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      yield* c.a.begin;
      const gate = yield* Deferred.make<void>();
      c.owner.blockSend(gate);
      const requester = yield* c.a.sync
        .readSource(c.validated, Effect.void)
        .pipe(Effect.forkScoped);
      const request = yield* c.a.request();
      const ownerCycle = yield* c.owner.sync.syncOnce.pipe(Effect.forkScoped);
      yield* Deferred.await(c.owner.sendEntered);
      yield* c.remove();
      const pending = yield* c.owner.run(c.owner.policy.read);
      assert.strictEqual(pending.policy.removals.length, 1);
      assert.deepStrictEqual(pending.policy.allowedRequesterEnvironmentIds, []);
      assert.strictEqual((yield* c.owner.run(runtimePermit(request)))._tag, "Failure");
      yield* c.owner.updatePolicy([c.a.identity]);
      const barrier = yield* c.owner.run(c.owner.policy.read);
      assert.strictEqual(barrier.policy.enrollments[0]?.state, "pending");
      assert.deepStrictEqual(barrier.policy.allowedRequesterEnvironmentIds, []);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(ownerCycle);
      // Ref removal blocks owner bytes immediately; terminal denial is committed
      // by the hub revoke Tx before releasing the requester result gate.
      assert.strictEqual((yield* c.owner.run(c.owner.policy.read)).policy.removals.length, 1);
      yield* c.owner.sync.syncOnce;
      yield* c.a.releaseResult();
      assert.deepStrictEqual(yield* Fiber.join(requester), {
        kind: "denied",
        requiredPermission: "orchestration:read",
      });
      yield* c.owner.sync.syncOnce;
      const acknowledged = yield* c.owner.run(c.owner.policy.read);
      assert.deepStrictEqual(acknowledged.policy.removals, []);
      assert.strictEqual(acknowledged.policy.enrollments[0]?.state, "active");
      assert.isAbove(
        acknowledged.policy.enrollments[0]!.ownerPolicyEpoch,
        pending.policy.removals[0]!.removalEpoch,
      );
      assert.deepStrictEqual(acknowledged.policy.allowedRequesterEnvironmentIds, [c.a.identity]);
      yield* assertPersisted(c.owner, acknowledged.policy);
      yield* c.a.begin;
      const fresh = yield* c.a
        .run(Service.MemoryService.use((s) => s.readSource(c.input, Effect.void)))
        .pipe(Effect.forkScoped);
      yield* c.a.request();
      yield* c.owner.sync.syncOnce;
      yield* c.a.releaseResult();
      assert.strictEqual(
        (yield* Fiber.join(fresh)).messages[0]?.text,
        "synthetic original from owner",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
const runtimePermit = (request: M.MemorySourceReadRequest) =>
  Sync.MemorySyncRuntime.use((r) => Effect.result(r.ownerPermit(request)));
const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(M.ServerSettings));
const assertPersisted = (
  owner: Effect.Success<ReturnType<typeof environment>>,
  policy: M.MemoryOwnerSourceReadPolicy,
) =>
  owner.run(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* Config.ServerConfig;
      const settings = yield* decodeSettings(yield* fs.readFileString(config.settingsPath));
      assert.deepStrictEqual(settings.memoryOwnerSourceReadPolicy, policy);
    }),
  );

it.effect(
  "restart reloads pending removal from the settings file and startup retransmits exact revoke before activating reenrollment",
  () =>
    Effect.gen(function* () {
      const c = yield* sourceFixture();
      yield* c.remove();
      yield* c.owner.updatePolicy([c.a.identity]);
      const pending = yield* c.owner.run(c.owner.policy.read);
      yield* assertPersisted(c.owner, pending.policy);
      const ownerHome = c.owner.home;
      yield* c.owner.close;
      const restarted = yield* environment(ownerHome);
      assert.strictEqual(restarted.identity, c.owner.identity);
      assert.deepStrictEqual(yield* restarted.run(restarted.policy.read), pending);
      const acknowledged = yield* Deferred.make<Settings.MemoryOwnerSourceReadCommitted>();
      const changes = yield* restarted.run(restarted.policy.changes);
      yield* changes.pipe(
        Stream.filter((v) => v.policy.removals.length === 0),
        Stream.take(1),
        Stream.runForEach((v) => Deferred.succeed(acknowledged, v)),
        Effect.forkScoped,
      );
      yield* restarted.sync.start;
      const settled = yield* Deferred.await(acknowledged);
      assert.strictEqual(settled.policy.enrollments[0]?.state, "active");
      assert.isAbove(
        settled.policy.enrollments[0]!.ownerPolicyEpoch,
        pending.policy.removals[0]!.removalEpoch,
      );
      yield* assertPersisted(restarted, settled.policy);
      yield* restarted.sync.shutdown;
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  [
    new M.ServerSettingsError({
      settingsPath: "<fixture>",
      operation: "write-file",
      cause: new Error("synthetic persistence failure"),
    }),
    "storage_failed",
  ],
  [new M.MemoryRpcError({ code: "fenced" }), "fenced"],
] as const)("policy binding exposes only safe acknowledgement failure %#", ([failure, code]) =>
  Effect.gen(function* () {
    const port = yield* Owner.MemoryOwnerSourceReadPolicyPort;
    const error = yield* port
      .recordRevokeAck({
        memorySpaceId: M.MemorySpaceId.make(id(1)),
        ownerEnvironmentId: M.EnvironmentId.make("owner"),
        requesterEnvironmentId: M.EnvironmentId.make("requester"),
        removalEpoch: 1,
        revokedThroughEpoch: 1,
      })
      .pipe(Effect.flip);
    assert.strictEqual(error._tag, "MemoryAccessError");
    assert.strictEqual(error.code, code);
    assert.isFalse("cause" in error);
    assert.isFalse("settingsPath" in error);
  }).pipe(
    Effect.provide(
      PolicyBinding.layer.pipe(
        Layer.provide(
          Layer.succeed(Settings.MemoryOwnerSourceReadCommittedPolicy, {
            read: Effect.succeed({ version: 0, policy: M.DEFAULT_MEMORY_OWNER_SOURCE_READ_POLICY }),
            changes: Effect.succeed(Stream.empty),
            recordRevokeAck: () => Effect.fail(failure),
          }),
        ),
      ),
    ),
  ),
);
