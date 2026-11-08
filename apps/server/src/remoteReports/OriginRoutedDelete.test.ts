import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Legacy from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Lifecycle from "../mcp/ThreadLifecycleMcpService.ts";
import { ThreadLifecycleToolkit } from "../mcp/toolkits/threadLifecycle/tools.ts";
import * as LifecycleHandlers from "../mcp/toolkits/threadLifecycle/handlers.ts";
import * as LaunchWatch from "../mcp/LaunchWatchService.ts";
import * as ToolAdmission from "../mcp/ToolAdmission.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import { SshRemoteDispatchError } from "../sshRemote/dispatchFailure.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import { database, fixture, origin, remote } from "./RemoteDispatchCoordinator.testkit.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const sqlite = Sqlite.layerMemory;
const admission = RuntimeAdmission.layer;
const runtime = Replay.layerWithRegistry(
  { name: "origin-delete" },
  Registry.layerFromAdapters([adapter]),
  {
    databaseLayer: sqlite,
    runEffectWorker: false,
  },
).pipe(Layer.provideMerge(admission));
const settings = Settings.layerTest();
const management = Threads.layer.pipe(
  Layer.provide(runtime),
  Layer.provide(settings),
  Layer.provide(Receipts.layer.pipe(Layer.provide(sqlite))),
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
  sqlite,
  Projections.layer.pipe(Layer.provide(sqlite)),
  admission,
  settings,
  Profiles.layer.pipe(Layer.provide(Layer.merge(settings, sqlite))),
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
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "origin-delete", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "origin-delete", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const at = "2026-11-08T00:00:00.000Z";
const remoteId = ThreadId.make("thread:remote");
const environmentId = EnvironmentId.make("environment:lifecycle");

const threadScope = (threadId: ThreadId): Invocation.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider:origin",
  thread: {
    threadId,
    providerSessionId: "provider:origin",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});
const clientScope: Invocation.McpInvocationScope = {
  environmentId,
  requestNamespace: "client:origin",
  thread: undefined,
  client: { sessionId: "origin", label: "Test", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  grantedScopes: [AuthOrchestrationOperateScope],
  reauthorize: () => Effect.void,
};

const call = (name: string, args: object, as: Invocation.McpInvocationScope) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provideService(Invocation.McpInvocationContext, as),
  );

const textOf = (result: McpSchema.CallToolResult) => {
  const block = result.content.find((item) => item.type === "text");
  return block?.type === "text" ? block.text : "";
};

const sshError = (reason: SshRemoteDispatchError["reason"], message: string, remoteCode?: string) =>
  new SshRemoteDispatchError({
    reason,
    message,
    ...(remoteCode === undefined ? {} : { remoteCode }),
  });

const harness = Effect.gen(function* () {
  const replies = yield* Queue.unbounded<Effect.Effect<unknown, SshRemoteDispatchError>>();
  const seen = yield* Queue.unbounded<{
    readonly tool: string;
    readonly writes: boolean;
    readonly ceiling: string;
    readonly args: Readonly<Record<string, unknown>>;
  }>();
  const ssh = Layer.mock(Ssh.SshRemoteDispatch)({
    callHostTool: (call, authorize) =>
      Effect.gen(function* () {
        const ceiling = yield* authorize;
        yield* Queue.offer(seen, {
          tool: call.tool,
          writes: call.writes,
          ceiling,
          args: call.arguments,
        });
        return yield* yield* Queue.take(replies);
      }),
  });
  const watch = Layer.mock(LaunchWatch.LaunchWatchService)({ rearm: () => Effect.void });
  const dyingSsh = Layer.mock(Ssh.SshRemoteDispatch)({
    callHostTool: () =>
      Effect.fail(sshError("host_unavailable", "coordinator observation is not this test")),
  });
  return { replies, seen, ssh, watch, dyingSsh };
});

const withOrigin = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  remoteServices: {
    readonly ssh: Layer.Layer<Ssh.SshRemoteDispatch>;
    readonly watch: Layer.Layer<LaunchWatch.LaunchWatchService>;
    readonly dyingSsh: Layer.Layer<Ssh.SshRemoteDispatch>;
  },
) =>
  effect.pipe(
    Effect.provide(
      served.pipe(
        Layer.provide(remoteServices.ssh),
        Layer.provideMerge(
          Coordinator.layer.pipe(
            Layer.provide(remoteServices.dyingSsh),
            Layer.provide(remoteServices.watch),
            Layer.provide(services),
          ),
        ),
      ),
    ),
  );

const createCaller = Effect.fn("test.createCaller")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("thread:origin");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:origin"),
    threadId,
    projectId: ProjectId.make("project:origin"),
    title: "origin",
    modelSelection: selection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  const messageId = MessageId.make("message:origin");
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("queue:origin"),
    threadId,
    messageId,
    text: "origin",
    attachments: [],
    dispatchMode: { type: "defer_start" },
    createdBy: "user",
    creationSource: "web",
  });
  const projection = yield* orchestrator.getThreadRecords(threadId, ["runs"]);
  const run = projection.runs.find((item) => item.userMessageId === messageId);
  if (run === undefined) return yield* Effect.die("Expected queued run");
  const projections = yield* Projections.ProjectionStoreV2;
  yield* projections.apply({
    id: EventId.make("held:origin"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId: instanceId,
    occurredAt: yield* DateTime.now,
    payload: { ...run, status: "queued", queueHeld: true },
  });
  const started = yield* call(
    "goat_queued_run_start",
    { threadId, queuedRunId: run.id, clientRequestId: "start-origin" },
    clientScope,
  );
  if (started.isError) return yield* Effect.die(textOf(started));
  return threadId;
});

const insertDispatch = (sql: SqlClient.SqlClient, originId: ThreadId, state: string, reports = 1) =>
  sql`INSERT INTO remote_dispatches (
    correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery,
    reports_supported, state, created_at, updated_at
  ) VALUES (
    'corr-1', 'thread', ${originId}, 'box', ${remoteId}, 'abc123', 'notify_only',
    ${reports}, ${state}, ${at}, ${at}
  )`;

const intentOf = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly delete_requested_at: string | null;
    readonly delete_request_key: string | null;
    readonly state: string;
  }>`
    SELECT delete_requested_at, delete_request_key, state FROM remote_dispatches WHERE correlation_id = 'corr-1'`;

const reservationOf = (sql: SqlClient.SqlClient, key: string) =>
  sql<{ readonly state: string; readonly result_json: string | null }>`
    SELECT state, result_json FROM mcp_request_reservations
    WHERE path = 'thread.delete' AND client_request_id = ${key}`;

it.effect("refuses a host delete before any remote call when the launch cannot be deleted", () =>
  Effect.gen(function* () {
    const gate = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const caller = yield* createCaller();
      const scope = threadScope(caller);
      yield* insertDispatch(sql, caller, "running");
      for (const [state, reports, key] of [
        ["running", 1, "running"],
        ["lost", 1, "lost"],
        ["launching", 1, "launching"],
        ["idle", 0, "no-reports"],
      ] as const) {
        yield* sql`UPDATE remote_dispatches SET state = ${state}, reports_supported = ${reports},
          delete_requested_at = NULL, delete_request_key = NULL WHERE correlation_id = 'corr-1'`;
        const result = yield* call(
          "goat_thread_delete",
          { threadId: remoteId, host: "box", clientRequestId: key },
          scope,
        );
        expect(result.isError, textOf(result)).toBe(true);
        expect(textOf(result)).not.toContain("approval-required");
      }
      yield* sql`DELETE FROM remote_dispatches WHERE correlation_id = 'corr-1'`;
      const missing = yield* call(
        "goat_thread_delete",
        { threadId: remoteId, host: "box", clientRequestId: "missing" },
        scope,
      );
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain("no launch");
      expect(yield* Queue.size(gate.seen)).toBe(0);
    }).pipe((effect) => withOrigin(effect, gate));
  }),
);

it.effect(
  "keeps delete intent when the destination accepts and replays without calling again",
  () =>
    Effect.gen(function* () {
      const gate = yield* harness;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const caller = yield* createCaller();
        const scope = threadScope(caller);
        yield* insertDispatch(sql, caller, "idle");
        yield* Queue.offer(
          gate.replies,
          Effect.succeed({ _tag: "accepted", commandId: "origin-delete:corr-1:key", sequence: 4 }),
        );
        const result = yield* call(
          "goat_thread_delete",
          { threadId: remoteId, host: "box", clientRequestId: "accept-1" },
          scope,
        );
        expect(result.isError, textOf(result)).toBe(false);
        expect(textOf(result)).toContain("origin-delete:corr-1:key");
        const seen = yield* Queue.take(gate.seen);
        expect(seen).toMatchObject({
          tool: "goat_origin_bound_delete",
          writes: true,
          ceiling: "full-access",
          args: {
            correlationId: "corr-1",
            readKey: "abc123",
            threadId: remoteId,
            requestKey: "accept-1",
          },
        });
        expect((yield* intentOf(sql))[0]?.delete_request_key).toBe("accept-1");
        const replay = yield* call(
          "goat_thread_delete",
          { threadId: remoteId, host: "box", clientRequestId: "accept-1" },
          scope,
        );
        expect(textOf(replay)).toBe(textOf(result));
        expect(yield* Queue.size(gate.seen)).toBe(0);
      }).pipe((effect) => withOrigin(effect, gate));
    }),
);

it.effect("clears intent when the destination refuses and when the tool is missing", () =>
  Effect.gen(function* () {
    const gate = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const caller = yield* createCaller();
      const scope = threadScope(caller);
      yield* insertDispatch(sql, caller, "settled");
      yield* Queue.offer(
        gate.replies,
        Effect.succeed({ _tag: "refused", message: "nonterminal run" }),
      );
      const refused = yield* call(
        "goat_thread_delete",
        { threadId: remoteId, host: "box", clientRequestId: "refuse-1" },
        scope,
      );
      expect(textOf(refused)).toContain("nonterminal run");
      expect((yield* intentOf(sql))[0]?.delete_requested_at).toBeNull();
      expect((yield* reservationOf(sql, "refuse-1"))[0]?.state).toBe("completed");
      yield* Queue.offer(
        gate.replies,
        Effect.fail(sshError("remote_outdated", "GOAT on box has no goat_origin_bound_delete")),
      );
      const old = yield* call(
        "goat_thread_delete",
        { threadId: remoteId, host: "box", clientRequestId: "old-1" },
        scope,
      );
      expect(textOf(old)).toContain("no goat_origin_bound_delete");
      expect((yield* intentOf(sql))[0]?.delete_requested_at).toBeNull();
      expect((yield* reservationOf(sql, "old-1"))[0]?.state).toBe("completed");
      const again = yield* call(
        "goat_thread_delete",
        { threadId: remoteId, host: "box", clientRequestId: "old-1" },
        scope,
      );
      expect(textOf(again)).toContain("no goat_origin_bound_delete");
      expect(yield* Queue.size(gate.seen)).toBe(2);
    }).pipe((effect) => withOrigin(effect, gate));
  }),
);

it.effect(
  "retries a lost transport with the same request key and clears intent only for a definite no-receipt refusal",
  () =>
    Effect.gen(function* () {
      const gate = yield* harness;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const caller = yield* createCaller();
        const scope = threadScope(caller);
        yield* insertDispatch(sql, caller, "idle");
        yield* Queue.offer(gate.replies, Effect.fail(sshError("host_unavailable", "gone")));
        const lost = yield* call(
          "goat_thread_delete",
          { threadId: remoteId, host: "box", clientRequestId: "lost-1" },
          scope,
        );
        expect(lost.isError).toBe(true);
        expect((yield* reservationOf(sql, "lost-1"))[0]?.state).toBe("unknown");
        expect((yield* intentOf(sql))[0]?.delete_request_key).toBe("lost-1");
        yield* Queue.offer(
          gate.replies,
          Effect.succeed({ _tag: "accepted", commandId: "origin-delete:corr-1:lost", sequence: 2 }),
        );
        const retried = yield* call(
          "goat_thread_delete",
          { threadId: remoteId, host: "box", clientRequestId: "lost-1" },
          scope,
        );
        expect(retried.isError, textOf(retried)).toBe(false);
        const second = yield* Queue.take(gate.seen);
        expect(second.args.requestKey).toBe("lost-1");
        expect((yield* Queue.take(gate.seen)).tool).toBe("goat_origin_bound_delete");
        yield* sql`UPDATE remote_dispatches SET state = 'idle', delete_requested_at = NULL, delete_request_key = NULL`;
        yield* Queue.offer(
          gate.replies,
          Effect.fail(
            sshError("remote_refused", "above the caller", "runtime_mode_escalation_denied"),
          ),
        );
        yield* call(
          "goat_thread_delete",
          { threadId: remoteId, host: "box", clientRequestId: "ceiling-1" },
          scope,
        );
        expect((yield* reservationOf(sql, "ceiling-1"))[0]?.state).toBe("unknown");
        expect((yield* intentOf(sql))[0]?.delete_requested_at).toBeNull();
        expect(
          (yield* sql`SELECT receipt_id FROM mcp_request_reservations WHERE client_request_id = 'ceiling-1'`)
            .length,
        ).toBe(1);
      }).pipe((effect) => withOrigin(effect, gate));
    }),
);

it.effect("a host lifecycle receipt fences did_not_run so goat_eval sees a replay", () =>
  Effect.gen(function* () {
    const gate = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const caller = yield* createCaller();
      const scope = threadScope(caller);
      yield* insertDispatch(sql, caller, "cancelled");
      yield* Queue.offer(gate.replies, Effect.fail(sshError("ssh_failed", "dropped")));
      yield* call(
        "goat_thread_delete",
        { threadId: remoteId, host: "box", clientRequestId: "fence-1" },
        scope,
      );
      yield* Queue.take(gate.seen);
      yield* Queue.offer(
        gate.replies,
        Effect.succeed({
          _tag: "did_not_run",
          message: "This delete did not run: the origin fenced the request before deletion.",
        }),
      );
      const receipt = yield* call(
        "goat_thread_lifecycle_receipt",
        { clientRequestId: "fence-1", host: "box" },
        scope,
      );
      expect(receipt.isError, textOf(receipt)).toBe(false);
      expect(textOf(receipt)).toContain("did not run");
      const row = (yield* reservationOf(sql, "fence-1"))[0];
      expect(row?.state).toBe("completed");
      expect(row?.result_json).not.toBeNull();
      expect((yield* intentOf(sql))[0]?.delete_requested_at).toBeNull();
      const fenced = yield* Queue.take(gate.seen);
      expect(fenced).toMatchObject({
        tool: "goat_origin_bound_delete_receipt",
        writes: true,
        ceiling: "full-access",
      });
      const evalAdmission = yield* ToolAdmission.makeEvalAdmission();
      const outcome = yield* evalAdmission
        .keyedOutcome("thread.delete", "fence-1", { threadId: remoteId, host: "box" })
        .pipe(Effect.provideService(Invocation.McpInvocationContext, scope));
      expect(outcome.kind).toBe("replay");
    }).pipe((effect) => withOrigin(effect, gate));
  }),
);

it.effect("a failed host receipt read leaves delete intent and the reservation unknown", () =>
  Effect.gen(function* () {
    const gate = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const caller = yield* createCaller();
      const scope = threadScope(caller);
      yield* insertDispatch(sql, caller, "cancelled");
      yield* Queue.offer(gate.replies, Effect.fail(sshError("ssh_failed", "dropped")));
      yield* call(
        "goat_thread_delete",
        { threadId: remoteId, host: "box", clientRequestId: "lost-1" },
        scope,
      );
      yield* Queue.take(gate.seen);
      yield* Queue.offer(
        gate.replies,
        Effect.fail(
          sshError("remote_refused", "The target thread was not found.", "thread_not_found"),
        ),
      );
      yield* call(
        "goat_thread_lifecycle_receipt",
        { clientRequestId: "lost-1", host: "box" },
        scope,
      );
      yield* Queue.take(gate.seen);
      // The lost delete may have committed there, so only a stored outcome may clear intent.
      expect((yield* intentOf(sql))[0]?.delete_requested_at).not.toBeNull();
      expect((yield* reservationOf(sql, "lost-1"))[0]?.state).toBe("unknown");
    }).pipe((effect) => withOrigin(effect, gate));
  }),
);

it.effect("does not settle a host-scoped lifecycle reservation from the local receipt", () =>
  Effect.gen(function* () {
    const gate = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const caller = yield* createCaller();
      const scope = threadScope(caller);
      yield* sql`INSERT INTO mcp_request_reservations (
        environment_id, principal, path, client_request_id, receipt_id, tool_name, args_digest,
        host, grant_json, state, boot_id, created_at, expires_at
      ) VALUES (
        ${environmentId}, ${"thread:" + caller}, 'thread.delete', 'host-row', 'receipt:host-row',
        'goat_thread_delete', 'digest', 'box',
        '{"runtimeMode":"full-access","interactionMode":"default","goatclaw":null,"role":null,"scopes":null,"readOnly":false}',
        'unknown', 'boot:other', ${at}, '2099-01-01T00:00:00.000Z'
      )`;
      const receipt = yield* call(
        "goat_thread_lifecycle_receipt",
        { clientRequestId: "host-row" },
        scope,
      );
      expect(textOf(receipt)).toContain("unknown");
      expect((yield* reservationOf(sql, "host-row")).length).toBe(1);
    }).pipe((effect) => withOrigin(effect, gate));
  }),
);

it.effect("a delete intent and resume cannot both win", () =>
  Effect.gen(function* () {
    const gate = yield* harness;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const caller = yield* createCaller();
      const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
      yield* insertDispatch(sql, caller, "idle");
      for (let i = 0; i < 8; i++) {
        yield* sql`UPDATE remote_dispatches SET state = 'idle', delete_requested_at = NULL, delete_request_key = NULL
          WHERE correlation_id = 'corr-1'`;
        const go = yield* Deferred.make<void>();
        const resumed = yield* Effect.forkChild(
          Deferred.await(go).pipe(Effect.andThen(coordinator.resume("box", remoteId))),
        );
        const claimed = yield* Effect.forkChild(
          Deferred.await(go).pipe(
            Effect.andThen(
              coordinator.claimDelete({
                originThreadId: caller,
                host: "box",
                remoteThreadId: remoteId,
                requestKey: "race-" + i,
              }),
            ),
          ),
        );
        yield* Deferred.succeed(go, undefined);
        yield* Fiber.join(resumed);
        yield* Fiber.join(claimed);
        const row = (yield* intentOf(sql))[0];
        expect(row?.state === "running" && row.delete_requested_at !== null).toBe(false);
      }
      yield* sql`UPDATE remote_dispatches SET state = 'running', delete_requested_at = NULL, delete_request_key = NULL`;
      const blocked = yield* coordinator.claimDelete({
        originThreadId: caller,
        host: "box",
        remoteThreadId: remoteId,
        requestKey: "while-running",
      });
      expect(blocked._tag).toBe("state");
      expect((yield* intentOf(sql))[0]?.delete_requested_at).toBeNull();
    }).pipe((effect) => withOrigin(effect, gate));
  }),
);

it.effect("a drain that loses a thread with delete intent does not invent a failure", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.sql`INSERT INTO remote_dispatches (
      correlation_id, kind, origin_thread_id, host, remote_thread_id, read_key, delivery,
      reports_supported, state, delete_requested_at, delete_request_key, created_at, updated_at
    ) VALUES (
      'gone', 'thread', ${origin}, 'box', ${remote}, 'abc123', 'wake',
      1, 'running', ${at}, 'delete-key', ${at}, ${at}
    )`;
    yield* Effect.gen(function* () {
      const read = yield* Queue.take(f.calls);
      expect(read.call.tool).toBe("goat_origin_reports_wait");
      yield* Queue.offer(
        read.reply,
        Effect.fail(sshError("remote_refused", "missing", "thread_not_found")),
      );
      yield* Queue.take(f.deleteKept);
      const row = yield* f.sql<{ readonly state: string; readonly last_error: string | null }>`
        SELECT state, last_error FROM remote_dispatches WHERE correlation_id = 'gone'`;
      expect(row[0]?.state).toBe("running");
      expect(row[0]?.last_error).toContain("not recorded as a failure");
      const inbox = yield* f.sql`SELECT id FROM remote_report_inbox`;
      expect(inbox).toEqual([]);
      expect(
        f.attemptedCommands.some((command) => command.type === "delegated_task.remote.result"),
      ).toBe(false);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);
