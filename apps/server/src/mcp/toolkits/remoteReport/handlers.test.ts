// @effect-diagnostics nodeBuiltinImport:off - the origin side hashes its read key with node:crypto.
import * as NodeCrypto_ from "node:crypto";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type OrchestratorMcpFailureCode,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as RemoteReportService from "../../../remoteReports/RemoteReportService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  idleThreadProjection,
  layerPermissionProfilesOff,
  liveThreadShell,
} from "../../McpToolAccess.testkit.ts";
import { layer, remoteReportFailure } from "./handlers.ts";
import { RemoteReportToolkit } from "./tools.ts";

// The origin coordinator decides from these codes whether to keep following a
// dispatch, so a reason that is permanent for the caller must not arrive as a
// retryable one (RemoteDispatchCoordinator's lost-task check).
const expected: Record<
  RemoteReportService.RemoteReportError["reason"],
  OrchestratorMcpFailureCode
> = {
  not_bound: "thread_not_found",
  thread_deleted: "thread_not_found",
  access_denied: "capability_denied",
  run_not_found: "run_not_found",
  storage: "orchestration_error",
  unavailable: "orchestration_error",
  invalid_request: "invalid_request",
  relay_unsupported: "invalid_request",
  relay_queue_full: "invalid_request",
  idempotency_mismatch: "conflict",
};

it.each(Object.entries(expected))("maps %s to %s", (reason, code) => {
  const failure = remoteReportFailure(
    new RemoteReportService.RemoteReportError({
      reason: reason as RemoteReportService.RemoteReportError["reason"],
    }),
  );
  expect(failure.code).toBe(code);
  expect(failure.message.length).toBeGreaterThan(0);
});

it.effect("keeps the permanent codes the coordinator treats as a lost task", () =>
  Effect.sync(() => {
    expect([expected.not_bound, expected.access_denied]).toEqual([
      "thread_not_found",
      "capability_denied",
    ]);
  }),
);

const remoteLane = ThreadId.make("remote-lane");
const localLane = ThreadId.make("local-lane");
const launcher = ThreadId.make("launcher-thread");
const readKey = "2".repeat(64);
const laneShell = (id: ThreadId) =>
  ({
    ...liveThreadShell(id),
    latestRunId: null,
    ...(id === localLane
      ? {
          launchedBy: {
            kind: "launch",
            threadId: launcher,
            environmentId: null,
            environmentLabel: null,
            threadTitle: "Supervisor",
            via: "thread_launch",
          },
        }
      : {}),
  }) as OrchestrationV2ThreadShell;
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "origin-report", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "origin-report", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("origin-report-environment"),
  requestNamespace: `session-${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

/**
 * goat_origin_report served through its real registration and RemoteReportService over migrated
 * SQLite. The orchestrator is a substitute whose dispatch keeps one message per command id, as
 * command receipts do; `dispatchFails` cuts a send off before or after it commits.
 */
const reportFixture = () => {
  const invocation: {
    -readonly [
      K in keyof McpInvocationContext.McpInvocationScope
    ]: McpInvocationContext.McpInvocationScope[K];
  } = threadScope(remoteLane);
  const wakes = new Map<string, string>();
  const control: { dispatchFails?: "before_commit" | "after_commit" } = {};
  const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
    getThreadShell: (id) => Effect.succeed(laneShell(id)),
    getThreadEventSequence: () => Effect.succeed(0),
    dispatch: (command) =>
      Effect.suspend(() => {
        const fails = control.dispatchFails;
        delete control.dispatchFails;
        if (fails === "before_commit") return Effect.die("dispatch cut off before commit");
        if (command.type === "message.dispatch" && !wakes.has(command.commandId))
          wakes.set(command.commandId, command.threadId);
        if (fails === "after_commit") return Effect.die("dispatch outcome lost after commit");
        return Effect.succeed({ sequence: wakes.size, storedEvents: [] });
      }),
  });
  const served = McpHttpServer.toolkitRegistration(RemoteReportToolkit, layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(
      Layer.mergeAll(
        layerPermissionProfilesOff,
        ServerSettings.layerTest(),
        NodeCrypto.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, invocation),
        Layer.mock(Threads.ThreadManagementService)({
          getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
          getProjectThreadRecords: ({ threadId }) =>
            Effect.succeed(idleThreadProjection(liveThreadShell(threadId))),
        }),
      ),
    ),
    Layer.provideMerge(RemoteReportService.layer.pipe(Layer.provide(orchestrator))),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  const call = (name: string, args: Record<string, unknown>) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
    );
  const receipt = (clientRequestId: string) =>
    call("goat_origin_report_receipt", { clientRequestId }).pipe(
      Effect.map((result) => result.structuredContent as { receipt: unknown }),
    );
  return { invocation, wakes, control, served, call, receipt };
};
const count = (table: "remote_reports" | "remote_report_inbox") =>
  SqlClient.SqlClient.pipe(
    Effect.flatMap((sql) => sql<{ n: number }>`SELECT COUNT(*) AS n FROM ${sql(table)}`),
    Effect.map((rows) => rows[0]?.n ?? 0),
  );

it.effect(
  "an origin-bound goat_origin_report records once per key, and its receipt outlives acknowledgement",
  () => {
    const { served, call, receipt } = reportFixture();
    return Effect.gen(function* () {
      const reports = yield* RemoteReportService.RemoteReportService;
      yield* reports.bind(remoteLane, {
        correlationId: "correlation-remote",
        originLabel: "origin laptop",
        originThreadId: ThreadId.make("origin-thread"),
        readKeyHash: NodeCrypto_.createHash("sha256").update(readKey, "utf8").digest("hex"),
      });
      const args = { status: "progress", summary: "Halfway.", clientRequestId: "remote-1" };
      expect(yield* receipt("remote-1")).toEqual({ receipt: null });
      const [first, concurrent] = yield* Effect.all(
        [call("goat_origin_report", args), call("goat_origin_report", args)],
        {
          concurrency: 2,
        },
      );
      expect(first.structuredContent).toEqual({ sequence: 1 });
      expect(concurrent.content).toEqual(first.content);
      expect(yield* count("remote_reports")).toBe(1);
      const before = {
        clientRequestId: "remote-1",
        status: "progress",
        sequence: 1,
        delivery: "origin",
        delivered: true,
        createdAt: expect.any(String),
      };
      expect(yield* receipt("remote-1")).toEqual({ receipt: before });
      // The origin collects and acknowledges the report, which deletes it.
      const collected = yield* reports.wait({
        correlationId: "correlation-remote",
        readKey,
        afterSequence: 1,
        watchRunId: null,
        knownRun: null,
        timeoutMs: 0,
      });
      expect(collected.reports).toEqual([]);
      expect(yield* count("remote_reports")).toBe(0);
      expect(yield* receipt("remote-1")).toEqual({ receipt: before });
      expect((yield* call("goat_origin_report", args)).content).toEqual(first.content);
      expect(yield* count("remote_reports")).toBe(0);
      const reused = yield* call("goat_origin_report", { ...args, summary: "Done." });
      expect(reused.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("idempotency_mismatch") }),
      ]);
      const next = yield* call("goat_origin_report", { ...args, clientRequestId: "remote-2" });
      expect(next.structuredContent).toEqual({ sequence: 2 });
    }).pipe(Effect.provide(served));
  },
);

it.effect(
  "a launcher-bound goat_origin_report keeps one inbox entry per key, and its receipt outlives the launcher's turn",
  () => {
    const { invocation, served, call, receipt } = reportFixture();
    return Effect.gen(function* () {
      invocation.thread = threadScope(localLane).thread;
      invocation.requestNamespace = threadScope(localLane).requestNamespace;
      const args = { status: "completed", summary: "Done.", clientRequestId: "local-1" };
      const first = yield* call("goat_origin_report", args);
      expect(first.structuredContent).toEqual({ sequence: 0, delivery: "launcher" });
      expect((yield* call("goat_origin_report", args)).content).toEqual(first.content);
      expect(yield* count("remote_report_inbox")).toBe(1);
      const before = {
        clientRequestId: "local-1",
        status: "completed",
        sequence: 0,
        delivery: "launcher",
        delivered: true,
        createdAt: expect.any(String),
      };
      expect(yield* receipt("local-1")).toEqual({ receipt: before });
      // The launcher's next turn consumes its inbox.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM remote_report_inbox`;
      expect(yield* receipt("local-1")).toEqual({ receipt: before });
      expect((yield* call("goat_origin_report", args)).content).toEqual(first.content);
      expect(yield* count("remote_report_inbox")).toBe(0);
      const reused = yield* call("goat_origin_report", { ...args, status: "failed" });
      expect(reused.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("idempotency_mismatch") }),
      ]);
    }).pipe(Effect.provide(served));
  },
);

it.effect.each(["before_commit", "after_commit"] as const)(
  "a launcher wake cut off %s is sent exactly once by a retry with the same key",
  (cut) => {
    const { invocation, wakes, control, served, call, receipt } = reportFixture();
    return Effect.gen(function* () {
      invocation.thread = threadScope(localLane).thread;
      invocation.requestNamespace = threadScope(localLane).requestNamespace;
      const args = { status: "needs_input", summary: "Which branch?", clientRequestId: "wake-1" };
      control.dispatchFails = cut;
      expect((yield* call("goat_origin_report", args)).isError).toBe(true);
      expect(yield* receipt("wake-1")).toEqual({
        receipt: expect.objectContaining({ delivery: "launcher", delivered: false }),
      });
      const retried = yield* call("goat_origin_report", args);
      expect(retried.structuredContent).toEqual({ sequence: 0, delivery: "launcher" });
      expect([...wakes.values()]).toEqual([launcher]);
      expect(yield* receipt("wake-1")).toEqual({
        receipt: expect.objectContaining({ delivered: true }),
      });
      yield* call("goat_origin_report", args);
      expect(wakes.size).toBe(1);
    }).pipe(Effect.provide(served));
  },
);

it.effect("only the reporting thread reads its receipts, and an outside client cannot", () => {
  const { invocation, served, call, receipt } = reportFixture();
  return Effect.gen(function* () {
    invocation.thread = threadScope(localLane).thread;
    invocation.requestNamespace = threadScope(localLane).requestNamespace;
    yield* call("goat_origin_report", {
      status: "progress",
      summary: "Mine.",
      clientRequestId: "own-1",
    });
    expect(yield* receipt("own-1")).toEqual({
      receipt: expect.objectContaining({ clientRequestId: "own-1" }),
    });
    // Another thread asking for the same key sees nothing, even naming the reporter.
    invocation.thread = threadScope(remoteLane).thread;
    expect(yield* receipt("own-1")).toEqual({ receipt: null });
    const forged = yield* call("goat_origin_report_receipt", {
      clientRequestId: "own-1",
      threadId: localLane,
    });
    // The read takes no thread argument at all: the caller's own thread is its only scope.
    expect(forged.isError).toBe(true);
    expect(JSON.stringify(forged.content)).not.toContain("Mine.");
    invocation.thread = undefined;
    invocation.client = { sessionId: "outside", label: "outside", access: "full-access" };
    const outside = yield* call("goat_origin_report_receipt", { clientRequestId: "own-1" });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).not.toContain("Mine.");
  }).pipe(Effect.provide(served));
});
