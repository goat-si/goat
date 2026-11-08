// @effect-diagnostics nodeBuiltinImport:off - the test hashes the binding read key the way the origin does.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { dispatchFailure } from "../mcp/threadAccess.ts";
import { RemoteReportToolkit } from "../mcp/toolkits/remoteReport/tools.ts";
import { layer as reportHandlers } from "../mcp/toolkits/remoteReport/handlers.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import * as Registry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Executor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Legacy from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as RuntimeAdmission from "../runtimeAdmission.ts";
import * as Settings from "../serverSettings.ts";
import { originBoundDeleteCommandId } from "./OriginBoundDeleteService.ts";
import * as OriginBoundDelete from "./OriginBoundDeleteService.ts";
import * as RemoteReportService from "./RemoteReportService.ts";

const instanceId = ProviderInstanceId.make("codex");
const selection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for a bound delete"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = Sqlite.layerMemory;
const admission = RuntimeAdmission.layer;
const runtime = Replay.layerWithRegistry(
  { name: "origin-bound-delete" },
  Registry.layerFromAdapters([adapter]),
  { databaseLayer: database, runEffectWorker: false },
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
const served = McpHttpServer.toolkitRegistration(RemoteReportToolkit, reportHandlers).pipe(
  Layer.provide(OriginBoundDelete.layer),
  Layer.provideMerge(RemoteReportService.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(services),
  Layer.provide(NodeCryptoLayer.layer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "bound-delete", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bound-delete", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:bound-delete"),
  requestNamespace: "client:bound-delete",
  thread: undefined,
  client: { sessionId: "bound-delete", label: "Origin", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const limited: Invocation.McpInvocationScope = {
  ...scope,
  client: { sessionId: "bound-delete", label: "Origin", access: "auto" },
};
const readKey = "cd".repeat(32);
const wrongKey = "ab".repeat(32);
const call = (name: string, args: object, as: Invocation.McpInvocationScope = scope) =>
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
const create = Effect.fn("test.createBoundDeleteThread")(function* (id: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(id);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: ProjectId.make("project:bound-delete"),
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
const queue = Effect.fn("test.queueBoundDeleteRun")(function* (threadId: ThreadId, id: string) {
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
  const run = projection.runs.find((item) => item.userMessageId === id);
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
});
const bind = (threadId: ThreadId, correlationId: string) =>
  RemoteReportService.RemoteReportService.use((reports) =>
    reports.bind(threadId, {
      correlationId,
      originLabel: "origin laptop",
      originThreadId: ThreadId.make("origin-thread"),
      readKeyHash: NodeCrypto.createHash("sha256").update(readKey, "utf8").digest("hex"),
    }),
  );
const deletedEvents = (threadId: ThreadId) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          readonly n: number;
        }>`SELECT COUNT(*) AS n FROM orchestration_events WHERE aggregate_kind = 'thread' AND stream_id = ${threadId} AND event_type = 'thread.deleted'`,
    ),
    Effect.map((rows) => Number(rows[0]?.n ?? 0)),
  );
const receiptRow = (commandId: CommandId) =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          readonly status: string;
          readonly error: string | null;
        }>`SELECT status AS "status", error AS "error" FROM orchestration_command_receipts WHERE command_id = ${commandId}`,
    ),
    Effect.map((rows) => rows[0] ?? null),
  );
const inputFor = (
  threadId: ThreadId,
  correlationId: string,
  requestKey: string,
  key = readKey,
) => ({
  correlationId,
  readKey: key,
  threadId,
  requestKey,
});

it.effect("a bound delete replays one thread.deleted for the same request key", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:replay");
    const correlationId = "correlation-replay";
    yield* bind(threadId, correlationId);
    const args = inputFor(threadId, correlationId, "delete-replay");
    const first = yield* call("goat_origin_bound_delete", args);
    expect(first.isError, JSON.stringify(first.content)).toBe(false);
    expect(first.structuredContent).toMatchObject({ _tag: "accepted" });
    expect(yield* deletedEvents(threadId)).toBe(1);
    const replay = yield* call("goat_origin_bound_delete", args);
    expect(replay.structuredContent).toEqual(first.structuredContent);
    expect(yield* deletedEvents(threadId)).toBe(1);
    expect(
      (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId))?.deletedAt,
    ).not.toBeNull();
  }).pipe(Effect.provide(served)),
);

it.effect("a fence before delete keeps the thread and replays did_not_run", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:fence-first");
    const correlationId = "correlation-fence-first";
    yield* bind(threadId, correlationId);
    const args = inputFor(threadId, correlationId, "delete-fence-first");
    const fenced = yield* call("goat_origin_bound_delete_receipt", args);
    expect(fenced.isError, JSON.stringify(fenced.content)).toBe(false);
    expect(fenced.structuredContent).toMatchObject({ _tag: "did_not_run" });
    const replay = yield* call("goat_origin_bound_delete", args);
    expect(replay.structuredContent).toMatchObject({ _tag: "did_not_run" });
    expect(yield* deletedEvents(threadId)).toBe(0);
    expect(
      (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId))?.deletedAt,
    ).toBeNull();
  }).pipe(Effect.provide(served)),
);

it.effect("a delete before the fence receipt reports accepted", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:delete-first");
    const correlationId = "correlation-delete-first";
    yield* bind(threadId, correlationId);
    const args = inputFor(threadId, correlationId, "delete-before-fence");
    const deleted = yield* call("goat_origin_bound_delete", args);
    expect(deleted.structuredContent).toMatchObject({ _tag: "accepted" });
    const receipt = yield* call("goat_origin_bound_delete_receipt", args);
    expect(receipt.structuredContent).toMatchObject({ _tag: "accepted" });
    expect(yield* deletedEvents(threadId)).toBe(1);
  }).pipe(Effect.provide(served)),
);

it.effect("a nonterminal run refusal stores and replays its sentence", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:nonterminal");
    const correlationId = "correlation-nonterminal";
    yield* bind(threadId, correlationId);
    yield* queue(threadId, "message:nonterminal");
    const requestKey = "delete-nonterminal";
    const args = inputFor(threadId, correlationId, requestKey);
    const first = yield* call("goat_origin_bound_delete", args);
    expect(first.isError, JSON.stringify(first.content)).toBe(false);
    expect(first.structuredContent).toMatchObject({
      _tag: "refused",
      message: expect.stringContaining("nonterminal run"),
    });
    const replay = yield* call("goat_origin_bound_delete", args);
    expect(replay.structuredContent).toMatchObject({
      _tag: "refused",
      message: expect.stringContaining("nonterminal run"),
    });
    expect(yield* deletedEvents(threadId)).toBe(0);
    const commandId = originBoundDeleteCommandId(correlationId, requestKey);
    expect((yield* receiptRow(commandId))?.error ?? "").toContain("nonterminal run");
    const error = yield* (yield* Orchestrator.OrchestratorV2)
      .dispatch({ type: "thread.delete", threadId, commandId })
      .pipe(Effect.flip);
    expect(error._tag).toBe("OrchestratorCommandPreviouslyRejectedError");
    if (error._tag === "OrchestratorCommandPreviouslyRejectedError") {
      expect(error.detail).toContain("nonterminal run");
      expect(dispatchFailure(error).message).toContain("nonterminal run");
    }
  }).pipe(Effect.provide(served)),
);

it.effect(
  "a mode-limit refusal stores no receipt and the same key deletes once the limit allows it",
  () =>
    Effect.gen(function* () {
      const threadId = yield* create("thread:mode-limit");
      const correlationId = "correlation-mode-limit";
      yield* bind(threadId, correlationId);
      const requestKey = "delete-mode-limit";
      const args = inputFor(threadId, correlationId, requestKey);
      const denied = yield* call("goat_origin_bound_delete", args, limited);
      expect(denied.isError, JSON.stringify(denied.content)).toBe(true);
      expect(value(denied)?.code).toBe("runtime_mode_escalation_denied");
      const commandId = originBoundDeleteCommandId(correlationId, requestKey);
      expect(yield* receiptRow(commandId)).toBeNull();
      expect(yield* deletedEvents(threadId)).toBe(0);
      const allowed = yield* call("goat_origin_bound_delete", args);
      expect(allowed.isError, JSON.stringify(allowed.content)).toBe(false);
      expect(allowed.structuredContent).toMatchObject({ _tag: "accepted" });
      expect(yield* deletedEvents(threadId)).toBe(1);
    }).pipe(Effect.provide(served)),
);

it.effect("a wrong read key or thread is not bound and emits no delete", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:not-bound");
    const otherId = yield* create("thread:not-bound-other");
    const correlationId = "correlation-not-bound";
    yield* bind(threadId, correlationId);
    const wrongKeyResult = yield* call(
      "goat_origin_bound_delete",
      inputFor(threadId, correlationId, "delete-wrong-key", wrongKey),
    );
    expect(wrongKeyResult.isError).toBe(true);
    expect(value(wrongKeyResult)?.classification).toBe("not_bound");
    const wrongThread = yield* call(
      "goat_origin_bound_delete",
      inputFor(otherId, correlationId, "delete-wrong-thread"),
    );
    expect(wrongThread.isError).toBe(true);
    expect(value(wrongThread)?.classification).toBe("not_bound");
    expect(yield* deletedEvents(threadId)).toBe(0);
    expect(yield* deletedEvents(otherId)).toBe(0);
    expect(
      yield* receiptRow(originBoundDeleteCommandId(correlationId, "delete-wrong-key")),
    ).toBeNull();
    expect(
      yield* receiptRow(originBoundDeleteCommandId(correlationId, "delete-wrong-thread")),
    ).toBeNull();
    expect(
      (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId))?.deletedAt,
    ).toBeNull();
  }).pipe(Effect.provide(served)),
);

it.effect("a fence commits for a thread above the session ceiling", () =>
  Effect.gen(function* () {
    const threadId = yield* create("thread:fence-ceiling");
    const correlationId = "correlation-fence-ceiling";
    yield* bind(threadId, correlationId);
    const requestKey = "delete-fence-ceiling";
    const args = inputFor(threadId, correlationId, requestKey);
    const fenced = yield* call("goat_origin_bound_delete_receipt", args, limited);
    expect(fenced.isError, JSON.stringify(fenced.content)).toBe(false);
    expect(fenced.structuredContent).toMatchObject({ _tag: "did_not_run" });
    const commandId = originBoundDeleteCommandId(correlationId, requestKey);
    expect(yield* receiptRow(commandId)).toMatchObject({ status: "rejected" });
    expect(yield* deletedEvents(threadId)).toBe(0);
    expect(
      (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId))?.deletedAt,
    ).toBeNull();
    const replay = yield* call("goat_origin_bound_delete", args);
    expect(replay.structuredContent).toMatchObject({ _tag: "did_not_run" });
    expect(yield* deletedEvents(threadId)).toBe(0);
  }).pipe(Effect.provide(served)),
);
