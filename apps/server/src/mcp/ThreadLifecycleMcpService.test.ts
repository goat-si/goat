import { expect, it } from "@effect/vitest";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { resolveGoatMcpToolDefinition } from "@goat/shared/goatMcpToolPresentation";
import { definitionName } from "./agentSurfaceSchemaRefs.testkit.ts";

it("exposes lifecycle writes and resource-specific reconciliation reads", () => {
  for (const path of [
    "queue.resume",
    "queued_run.start",
    "thread.delete",
    "provider_session.detach",
    "queue.receipt",
    "queued_run.receipt",
    "thread.lifecycle_receipt",
    "provider_session.receipt",
  ]) {
    expect(agentSurfaceRegistry, path).toHaveProperty([path]);
    expect(resolveGoatMcpToolDefinition(`goat_${path.replace(".", "_")}`), path).not.toBeNull();
  }
});

import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Legacy from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as Sessions from "./McpSessionRegistry.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";
import * as Lifecycle from "./ThreadLifecycleMcpService.ts";
import { ThreadLifecycleToolkit } from "./toolkits/threadLifecycle/tools.ts";
import * as LifecycleHandlers from "./toolkits/threadLifecycle/handlers.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for lifecycle command acceptance"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const admission = RuntimeAdmission.layer;
const runtime = Replay.layerWithRegistry(
  { name: "lifecycle-mcp" },
  Registry.layerFromAdapters([adapter]),
  {
    databaseLayer: database,
    runEffectWorker: false,
  },
).pipe(Layer.provideMerge(admission));
const settings = Settings.layerTest();
const management = Threads.layer.pipe(
  Layer.provide(runtime),
  Layer.provide(settings),
  Layer.provide(Receipts.layer.pipe(Layer.provide(database))),
  Layer.provide(Executor.layer),
  Layer.provide(
    Layer.mock(Legacy.LegacyV1ThreadImporter)({
      ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    }),
  ),
);
const services = Layer.mergeAll(
  runtime,
  management,
  database,
  Projections.layer.pipe(Layer.provide(database)),
  admission,
  settings,
  Profiles.layer.pipe(Layer.provide(Layer.merge(settings, database))),
);
const served = McpHttpServer.toolkitRegistration(
  ThreadLifecycleToolkit,
  LifecycleHandlers.layer,
).pipe(
  Layer.provide(Lifecycle.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(services),
  Layer.provide(NodeCrypto.layer),
);
it("receipt output references resolve when MCP schema definition names contain slashes", () => {
  const document = Schema.toJsonSchemaDocument(
    ThreadLifecycleToolkit.tools.goat_queue_receipt.successSchema,
  );
  const refs = Array.from(
    JSON.stringify(document).matchAll(/"\$ref":"([^"]+)"/g),
    (match) => match[1]!,
  );
  expect(refs.length).toBeGreaterThan(0);
  for (const ref of refs)
    expect(Object.hasOwn(document.definitions, definitionName(ref) ?? ""), ref).toBe(true);
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "lifecycle-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "lifecycle-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:lifecycle"),
  requestNamespace: "client:lifecycle",
  thread: undefined,
  client: { sessionId: "lifecycle", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  grantedScopes: [AuthOrchestrationOperateScope],
  reauthorize: () => Effect.void,
};
const call = (name: string, args: object, as = scope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(Invocation.McpInvocationContext, as),
  );
const value = (result: McpSchema.CallToolResult) => {
  const block = result.content.find((item) => item.type === "text");
  return block?.type === "text"
    ? (JSON.parse(block.text) as Readonly<Record<string, unknown>>)
    : undefined;
};
const create = Effect.fn("test.createLifecycleThread")(function* (
  id: string,
  project = "project:lifecycle",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(id);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: ProjectId.make(project),
    title: id,
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});
const queue = Effect.fn("test.queueLifecycleMessage")(function* (threadId: ThreadId, id: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`queue:${id}`),
    threadId,
    messageId: MessageId.make(id),
    text: id,
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const projection = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
  const run = projection.runs.find((run) => run.userMessageId === id);
  if (run === undefined) return yield* Effect.die("Expected queued run");
  const projections = yield* Projections.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* projections.apply({
    id: EventId.make(`held:${id}`),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId: instanceId,
    occurredAt: now,
    payload: { ...run, status: "queued", queueHeld: true },
  });
  return run.id;
});

it.effect(
  "deletes once, replays after target deletion, and isolates retained receipts and arguments",
  () =>
    Effect.gen(function* () {
      const threadId = yield* create("thread:delete");
      const first = yield* call("goat_thread_delete", { threadId, clientRequestId: "delete-1" });
      expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
      expect(value(first)).toMatchObject({ accepted: true });
      expect(
        (yield* call("goat_thread_delete", { threadId, clientRequestId: "delete-1" })).content,
      ).toEqual(first.content);
      expect(
        value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "delete-1" })),
      ).toMatchObject({
        state: "completed",
        commandStatus: "accepted",
        result: { content: first.content },
      });
      const other = {
        ...scope,
        client: { sessionId: "another", label: "Other", access: "full-access" as const },
      };
      expect(
        value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "delete-1" }, other)),
      ).toEqual({ state: "missing" });
      expect(
        value(
          yield* call("goat_thread_delete", {
            threadId: "thread:elsewhere",
            clientRequestId: "delete-1",
          }),
        ),
      ).toMatchObject({ reason: "idempotency_mismatch" });
    }).pipe(Effect.provide(served)),
);

it.effect(
  "an issued live thread credential controls lifecycle without outside-client operate scope",
  () =>
    Effect.gen(function* () {
      const callerId = yield* create("thread:issued-caller");
      const callerRun = yield* queue(callerId, "message:issued-caller");
      yield* call("goat_queued_run_start", { threadId: callerId, queuedRunId: callerRun });
      const registry = yield* Sessions.__testing.make().pipe(
        Effect.provide(NodeCrypto.layer),
        Effect.provideService(ServerEnvironment.ServerEnvironment, {
          getEnvironmentId: Effect.succeed(scope.environmentId),
          getDescriptor: Effect.die("unused"),
        }),
        Effect.provideService(
          HttpServer.HttpServer,
          HttpServer.HttpServer.of({
            address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 43123),
            serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
          }),
        ),
      );
      const issued = yield* registry.issue({
        threadId: callerId,
        providerInstanceId: instanceId,
        grantedScopes: ["orchestration:read"],
        isLiveCaller: Effect.succeed(true),
      });
      const credential = yield* registry.resolve(
        issued.config.authorizationHeader.replace(/^Bearer\s+/, ""),
      );
      if (credential === undefined) return yield* Effect.die("Expected issued thread credential");
      expect(credential.grantedScopes).not.toContain(AuthOrchestrationOperateScope);
      const target = yield* create("thread:issued-target");
      expect(
        value(
          yield* call(
            "goat_thread_delete",
            { threadId: target, clientRequestId: "issued-delete" },
            credential,
          ),
        ),
      ).toMatchObject({ accepted: true });
      expect(
        value(
          yield* call(
            "goat_thread_lifecycle_receipt",
            { clientRequestId: "issued-delete" },
            credential,
          ),
        ),
      ).toMatchObject({ state: "completed", commandStatus: "accepted" });
      yield* registry.revokeThread(callerId);
      expect(
        (yield* call(
          "goat_thread_lifecycle_receipt",
          { clientRequestId: "issued-delete" },
          credential,
        )).isError,
      ).toBe(true);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "refuses missing capability, read-only, revoked, inactive callers and a lower target ceiling before replay",
  () =>
    Effect.gen(function* () {
      const threadId = yield* create("thread:permissions");
      const args = { threadId, clientRequestId: "permission-key" };
      const deniedScopes: ReadonlyArray<Invocation.McpInvocationScope> = [
        { ...scope, capabilities: new Set() },
        { ...scope, readOnly: true },
        { ...scope, client: { ...scope.client!, access: "read-only" } },
        {
          ...scope,
          reauthorize: () =>
            Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: AuthOrchestrationOperateScope,
                message: "Revoked",
              }),
            ),
        },
        { ...scope, client: { ...scope.client!, access: "auto" } },
        {
          ...scope,
          client: undefined,
          thread: { threadId, providerSessionId: "inactive", providerInstanceId: instanceId },
        },
      ];
      for (const denied of deniedScopes)
        expect((yield* call("goat_thread_delete", args, denied)).isError).toBe(true);
      expect((yield* call("goat_thread_delete", args)).isError).not.toBe(true);
      for (const denied of deniedScopes.slice(0, 5))
        expect((yield* call("goat_thread_delete", args, denied)).isError).toBe(true);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "refuses deletion of queued and active runs atomically without changing client delete semantics",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = yield* create("thread:queued-delete");
      yield* queue(threadId, "message:held");
      expect(
        (yield* call("goat_thread_delete", { threadId, clientRequestId: "queued-delete" })).isError,
      ).toBe(true);
      expect((yield* orchestrator.getThreadShell(threadId))?.deletedAt).toBeNull();
      yield* orchestrator.dispatch({
        type: "thread.delete",
        threadId,
        commandId: CommandId.make("client-delete"),
      });
      expect((yield* orchestrator.getThreadShell(threadId))?.deletedAt).not.toBeNull();
    }).pipe(Effect.provide(served)),
);

it.effect(
  "starts a selected queued run once and refuses stale selections and starts during drain",
  () =>
    Effect.gen(function* () {
      const threadId = yield* create("thread:queue-start");
      const runId = yield* queue(threadId, "message:first");
      yield* queue(threadId, "message:second");
      const args = { threadId, queuedRunId: runId, clientRequestId: "start-1" };
      const first = yield* call("goat_queued_run_start", args);
      expect(first.isError, JSON.stringify(first.content)).not.toBe(true);
      expect((yield* call("goat_queued_run_start", args)).content).toEqual(first.content);
      expect(
        (yield* call("goat_queued_run_start", { ...args, clientRequestId: "stale" })).isError,
      ).toBe(true);
      const resumedThread = yield* create("thread:resume");
      yield* queue(resumedThread, "message:resume");
      const resumeArgs = { threadId: resumedThread, clientRequestId: "resume" };
      const resumed = yield* call("goat_queue_resume", resumeArgs);
      expect(value(resumed)).toMatchObject({ accepted: true });
      expect((yield* call("goat_queue_resume", resumeArgs)).content).toEqual(resumed.content);
      expect(value(yield* call("goat_queue_receipt", { clientRequestId: "resume" }))).toMatchObject(
        { state: "completed", commandStatus: "accepted" },
      );
      const drainedThread = yield* create("thread:drained");
      const drainedRun = yield* queue(drainedThread, "message:drained");
      yield* (yield* RuntimeAdmission.RuntimeAdmission).beginDrain;
      expect(
        (yield* call("goat_queued_run_start", {
          threadId: drainedThread,
          queuedRunId: drainedRun,
          clientRequestId: "drain-start",
        })).isError,
      ).toBe(true);
      expect(
        (yield* call("goat_queue_resume", {
          threadId: drainedThread,
          clientRequestId: "drain-resume",
        })).isError,
      ).toBe(true);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "detaches only a session owned by the target, records acceptance, and refuses self detach/delete",
  () =>
    Effect.gen(function* () {
      const threadId = yield* create("thread:detach");
      const projections = yield* Projections.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const providerSessionId = ProviderSessionId.make("session:detach");
      yield* projections.apply({
        id: EventId.make("session:attached"),
        type: "provider-session.attached",
        threadId,
        occurredAt: now,
        payload: {
          id: providerSessionId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: "/repo",
          model: selection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      });
      expect(
        (yield* call("goat_provider_session_detach", {
          threadId,
          providerSessionId: "session:foreign",
          clientRequestId: "foreign",
        })).isError,
      ).toBe(true);
      const result = yield* call("goat_provider_session_detach", {
        threadId,
        providerSessionId,
        clientRequestId: "detach",
      });
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
      expect(
        value(yield* call("goat_provider_session_receipt", { clientRequestId: "detach" })),
      ).toMatchObject({ state: "completed", commandStatus: "accepted" });
      expect(yield* (yield* Worker.OrchestrationEffectWorkerV2).drain()).toBeGreaterThan(0);
      yield* queue(threadId, "message:after-detach");
      expect(
        (yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(threadId, [
          "messages",
        ])).messages.some((message) => message.id === "message:after-detach"),
      ).toBe(true);
      const selfId = yield* create("thread:self");
      const selfRun = yield* queue(selfId, "message:self");
      expect(
        value(yield* call("goat_queued_run_start", { threadId: selfId, queuedRunId: selfRun })),
      ).toMatchObject({ accepted: true });
      const self = {
        ...scope,
        client: undefined,
        thread: {
          threadId: selfId,
          providerSessionId: "session:self",
          providerInstanceId: instanceId,
        },
      };
      expect(
        value(
          yield* call(
            "goat_thread_delete",
            { threadId: selfId, clientRequestId: "self-delete" },
            self,
          ),
        ),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("own thread") });
      expect(
        value(
          yield* call(
            "goat_provider_session_detach",
            { threadId: selfId, providerSessionId, clientRequestId: "self-detach" },
            self,
          ),
        ),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("own thread") });
    }).pipe(Effect.provide(served)),
);

it.effect("concurrent identical starts cannot advance the next queued run twice", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:concurrent-start");
    const queuedRunId = yield* queue(threadId, "message:concurrent-first");
    const second = yield* queue(threadId, "message:concurrent-second");
    const args = { threadId, queuedRunId, clientRequestId: "concurrent" };
    const results = yield* Effect.all(
      [call("goat_queued_run_start", args), call("goat_queued_run_start", args)],
      { concurrency: "unbounded" },
    );
    expect(results.some((result) => value(result)?.accepted === true)).toBe(true);
    for (const result of results) {
      const reply = value(result);
      expect(reply?.accepted === true || reply?.reason === "in_progress").toBe(true);
    }
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(threadId, [
      "runs",
    ]);
    expect(projection.runs.find((run) => run.id === second)?.status).toBe("queued");
    const sql = yield* SqlClient.SqlClient;
    expect(
      yield* sql`SELECT COUNT(*) AS count FROM mcp_request_reservations WHERE path = 'queued_run.start' AND client_request_id = 'concurrent'`,
    ).toEqual([{ count: 1 }]);
    expect(value(yield* call("goat_queued_run_start", args))).toMatchObject({ accepted: true });
  }).pipe(Effect.provide(served)),
);

it.effect(
  "reconciles an accepted command when recording its result fails, without redispatch",
  () =>
    Effect.gen(function* () {
      const threadId = yield* create("thread:unknown-delete");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER refuse_lifecycle_settlement BEFORE UPDATE ON mcp_request_reservations
    BEGIN SELECT RAISE(ABORT, 'test settlement failure'); END`;
      const args = { threadId, clientRequestId: "unknown-delete" };
      expect(value(yield* call("goat_thread_delete", args))).toMatchObject({ accepted: true });
      expect(
        value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "unknown-delete" })),
      ).toEqual({ state: "unknown", commandStatus: "accepted" });
      expect(value(yield* call("goat_thread_delete", args))).toMatchObject({
        reason: "outcome_unknown",
      });
      const narrowed = { ...scope, grantedScopes: [] };
      expect(
        (yield* call(
          "goat_thread_lifecycle_receipt",
          { clientRequestId: "unknown-delete" },
          narrowed,
        )).isError,
      ).toBe(true);
      yield* sql`DROP TRIGGER refuse_lifecycle_settlement`;
      expect(
        value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "unknown-delete" })),
      ).toMatchObject({
        state: "completed",
        commandStatus: "accepted",
        result: { isError: false },
      });
      expect(value(yield* call("goat_thread_delete", args))).toMatchObject({ accepted: true });
    }).pipe(Effect.provide(served)),
);

it.effect("withholds completed receipts and replay after the recorded grant narrows", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:narrow-grant");
    const args = { threadId, clientRequestId: "narrow" };
    expect(value(yield* call("goat_thread_delete", args))).toMatchObject({ accepted: true });
    const narrowed = { ...scope, client: { ...scope.client!, access: "auto" as const } };
    expect(value(yield* call("goat_thread_delete", args, narrowed))).toMatchObject({
      code: "capability_denied",
    });
    expect(
      value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "narrow" }, narrowed)),
    ).toMatchObject({ code: "capability_denied" });
    expect(
      value(
        yield* call(
          "goat_thread_lifecycle_receipt",
          { clientRequestId: "narrow" },
          { ...scope, environmentId: EnvironmentId.make("another-environment") },
        ),
      ),
    ).toEqual({ state: "missing" });
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE mcp_request_reservations SET expires_at = '1969-01-01T00:00:00.000Z' WHERE client_request_id = 'narrow'`;
    expect(
      value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "narrow" })),
    ).toEqual({ state: "missing" });
  }).pipe(Effect.provide(served)),
);

it.effect("rechecks deletion against newly queued work after the target shell was read", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:delete-race");
    const realThreads = yield* Threads.ThreadManagementService;
    const captured = yield* Effect.context<
      Orchestrator.OrchestratorV2 | Projections.ProjectionStoreV2
    >();
    const wrapper = Threads.ThreadManagementService.of({
      ...realThreads,
      getThreadShell: (id) =>
        realThreads
          .getThreadShell(id)
          .pipe(
            Effect.tap(() =>
              queue(threadId, "message:racing-queue").pipe(
                Effect.provideContext(captured),
                Effect.orDie,
              ),
            ),
          ),
    });
    const built = yield* Layer.build(
      Layer.fresh(Lifecycle.layer).pipe(
        Layer.provide(Layer.succeed(Threads.ThreadManagementService, wrapper)),
        Layer.provide(NodeCrypto.layer),
      ),
    );
    const service = Context.get(built, Lifecycle.ThreadLifecycleMcpService);
    const result = yield* service.delete(scope, { threadId }).pipe(Effect.exit);
    expect(result._tag).toBe("Failure");
    expect((yield* realThreads.getThreadShell(threadId))?.deletedAt).toBeNull();
    expect(
      (yield* realThreads.getThreadRecords(threadId, ["runs"])).runs.some(
        (run) => run.status === "queued",
      ),
    ).toBe(true);
  }).pipe(Effect.provide(served)),
);

it.effect(
  "refuses every nonterminal run and active background subagent, including provider-native children",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* Projections.ProjectionStoreV2;
      const threadId = yield* create("thread:all-active-states");
      const runId = yield* queue(threadId, "message:active-states");
      const records = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
      const run = records.runs.find((run) => run.id === runId)!;
      const now = yield* DateTime.now;
      for (const status of ["preparing", "queued", "starting", "running", "waiting"] as const) {
        yield* projections.apply({
          id: EventId.make(`state:${status}`),
          type: "run.updated",
          threadId,
          runId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: { ...run, status },
        });
        const reply = value(
          yield* call("goat_thread_delete", { threadId, clientRequestId: `delete:${status}` }),
        );
        expect(reply).toMatchObject({
          code: "invalid_request",
          message: expect.stringContaining("nonterminal"),
        });
      }
      yield* projections.apply({
        id: EventId.make("state:completed"),
        type: "run.updated",
        threadId,
        runId,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      yield* projections.apply({
        id: EventId.make("subagent:active"),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        providerInstanceId: instanceId,
        payload: {
          id: NodeId.make("subagent:active"),
          threadId,
          runId,
          parentNodeId: NodeId.make("parent"),
          origin: "provider_native",
          createdBy: "agent",
          driver: adapter.driver,
          providerInstanceId: instanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Background work",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      expect(
        value(
          yield* call("goat_thread_delete", { threadId, clientRequestId: "delete:background" }),
        ),
      ).toMatchObject({ message: expect.stringContaining("background subagent") });
      const childId = yield* create("thread:native-child");
      const child = yield* orchestrator.getThreadRecords(childId, []);
      yield* projections.apply({
        id: EventId.make("native-child:metadata"),
        type: "thread.metadata-updated",
        threadId: childId,
        occurredAt: now,
        providerInstanceId: instanceId,
        payload: {
          ...child.thread,
          creationSource: "provider",
          lineage: {
            rootThreadId: threadId,
            parentThreadId: threadId,
            relationshipToParent: "subagent",
          },
        },
      });
      expect(
        value(
          yield* call("goat_thread_delete", {
            threadId: childId,
            clientRequestId: "delete:native-child",
          }),
        ),
      ).toMatchObject({ code: "invalid_request", message: expect.stringContaining("read-only") });
    }).pipe(Effect.provide(served)),
);

it.effect(
  "requires the goatclaw launch capability and withholds receipts when its profile narrows",
  () =>
    Effect.gen(function* () {
      const callerId = yield* create("thread:profile-caller");
      const runId = yield* queue(callerId, "message:profile-caller");
      expect(
        value(yield* call("goat_queued_run_start", { threadId: callerId, queuedRunId: runId })),
      ).toMatchObject({ accepted: true });
      const as = {
        ...scope,
        client: undefined,
        thread: {
          threadId: callerId,
          providerSessionId: "session:profile",
          providerInstanceId: instanceId,
        },
      };
      const settings = yield* Settings.ServerSettingsService;
      const policy = (yield* settings.getSettings).goatclaw;
      yield* settings.updateSettings({
        goatclaw: { ...policy, enabled: true, defaultProfile: "owner" },
      });
      const target = yield* create("thread:profile-target", "project:another");
      const args = { threadId: target, clientRequestId: "profile-delete" };
      expect(value(yield* call("goat_thread_delete", args, as))).toMatchObject({ accepted: true });
      const current = (yield* settings.getSettings).goatclaw;
      const owner = current.profiles.owner!;
      yield* settings.updateSettings({
        goatclaw: {
          ...current,
          profiles: {
            ...current.profiles,
            owner: {
              ...owner,
              capabilities: owner.capabilities.filter(
                (capability) => capability !== "threads.launch",
              ),
            },
          },
        },
      });
      expect((yield* call("goat_thread_delete", args, as)).isError).toBe(true);
      expect(
        value(
          yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "profile-delete" }, as),
        ),
      ).toMatchObject({ code: "capability_denied" });
    }).pipe(Effect.provide(served)),
);

it.effect(
  "returns explicit running and unknown receipt states and preserves recorded failures",
  () =>
    Effect.gen(function* () {
      const threadId = yield* create("thread:receipt-states");
      yield* queue(threadId, "message:receipt-states");
      const failed = yield* call("goat_thread_delete", {
        threadId,
        clientRequestId: "failed-delete",
      });
      expect(failed.isError).toBe(true);
      expect(
        (yield* call("goat_thread_delete", { threadId, clientRequestId: "failed-delete" })).content,
      ).toEqual(failed.content);
      expect(
        value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "failed-delete" })),
      ).toMatchObject({
        state: "completed",
        commandStatus: "rejected",
        result: { isError: true, content: failed.content },
        failure: { code: "invalid_request" },
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE mcp_request_reservations SET state = 'running', result_json = NULL WHERE client_request_id = 'failed-delete'`;
      expect(
        value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "failed-delete" })),
      ).toMatchObject({ state: "in_progress", commandStatus: "rejected" });
      yield* sql`UPDATE mcp_request_reservations SET boot_id = 'previous-process' WHERE client_request_id = 'failed-delete'`;
      expect(
        value(yield* call("goat_thread_lifecycle_receipt", { clientRequestId: "failed-delete" })),
      ).toMatchObject({
        state: "completed",
        commandStatus: "rejected",
        result: { isError: true },
        failure: { code: "invalid_request" },
      });
    }).pipe(Effect.provide(served)),
);
