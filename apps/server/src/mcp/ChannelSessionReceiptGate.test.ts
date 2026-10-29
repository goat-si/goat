import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";
import { McpSchema, McpServer } from "effect/ai";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as UserDocs from "../userDocs/UserDocs.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ChannelLedger from "../channels/ChannelLedger.ts";
import { ChannelDeliveryId, EnvironmentAuthorizationError } from "@goat/contracts";
import * as ChannelSessionReceiptGate from "./ChannelSessionReceiptGate.ts";
import * as SessionReceiptGate from "../orchestration-v2/goat/SessionReceiptGate.ts";
import * as Fixture from "../orchestration-v2/goat/SessionReceipt.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ToolAdmission from "./ToolAdmission.ts";
import { fromFailure } from "@goat/contracts/agentSurface/envelope";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { layerPermissionProfilesOff } from "./McpToolAccess.testkit.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const sessionScope = (
  runId: RunId | undefined = RunId.make("receipt-run"),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("receipt-env"),
  requestNamespace: "receipt-test",
  thread: {
    threadId: ThreadId.make("goat-bot-session:receipt:1"),
    runId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "receipt-provider",
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

it.effect.each([
  "thread.launch",
  "create_task",
  "ssh.thread_launch",
  "delegate",
  "thread.report_result",
])("refuses %s from a session when the served gate is absent, before admission", (tool) =>
  Effect.gen(function* () {
    const profiles = yield* Profiles.PermissionProfiles;
    const result = yield* McpToolAccess.requireDeclaredCapability(profiles, tool, "write", {}).pipe(
      Effect.result,
    );
    expect(result._tag).toBe("Failure");
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, sessionScope()),
    Effect.provide(layerPermissionProfilesOff),
  ),
);

const testLayer = Layer.mergeAll(
  ChannelLedger.layer,
  ChannelSessionReceiptGate.layer,
  layerPermissionProfilesOff,
  Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(liveThreadShell(id, { activeRunId: Fixture.runId })),
  }),
).pipe(Layer.provideMerge(Fixture.layer));

it.effect.each([
  "goat_thread_launch",
  "create_threads",
  "goat_ssh_thread_launch",
  "delegate_task",
  "goat_task_create",
])(
  "%s waits without a reservation, refuses retryably at ten seconds, then launches exactly once",
  (tool) =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      expect(resolveAgentSurfaceEntry(tool)).toBeDefined();
      const sql = yield* SqlClient.SqlClient;
      const admit = yield* ToolAdmission.make();
      let launches = 0;
      const args = { clientRequestId: "receipt-launch" };
      const reserve = McpToolAccess.KeyedAdmission.pipe(
        Effect.flatMap((keyed) =>
          keyed.admit(args, { runtimeMode: "full-access", interactionMode: "default" }),
        ),
      );
      const launch = admit(tool, "write", args, () =>
        reserve.pipe(
          Effect.andThen(
            Effect.sync(() => {
              launches += 1;
              return new McpSchema.CallToolResult({
                content: [{ type: "text", text: "launched" }],
              });
            }),
          ),
        ),
      );
      const pending = yield* launch.pipe(Effect.forkChild);
      yield* TestClock.adjust("9 seconds");
      expect(launches).toBe(0);
      expect(yield* sql`SELECT * FROM mcp_request_reservations`).toHaveLength(0);
      yield* TestClock.adjust("1 second");
      const result = yield* Fiber.join(pending);
      expect("isError" in result && result.isError).toBe(true);
      expect(yield* sql`SELECT * FROM mcp_request_reservations`).toHaveLength(0);
      const refusal = new OrchestratorMcpFailure({
        code: "provider_unavailable",
        reason: "session_receipt_pending",
        message: "held",
      });
      const envelope = fromFailure(
        {
          _tag: refusal._tag,
          code: refusal.code,
          reason: refusal.reason,
          message: refusal.message,
        },
        { effect: "write" },
      );
      expect(envelope.status === "error" && envelope.error.retryable).toBe(true);
      yield* Fixture.settle;
      yield* launch;
      expect(launches).toBe(1);
    }).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, sessionScope()),
      Effect.provide(testLayer),
    ),
);

it.effect.each(["missing-run", "stale-generation", "missing-task", "read-failure"])(
  "refuses %s without executing a capability-none write",
  (reason) =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const sql = yield* SqlClient.SqlClient;
      if (reason === "stale-generation") yield* sql`UPDATE channel_tasks SET generation = 2`;
      if (reason === "missing-task") yield* sql`DELETE FROM channel_tasks`;
      if (reason === "read-failure")
        yield* sql`ALTER TABLE channel_tasks RENAME TO unavailable_tasks`;
      const profiles = yield* Profiles.PermissionProfiles;
      const scope = sessionScope(
        reason === "missing-run" ? RunId.make("unknown-run") : Fixture.runId,
      );
      const result = yield* McpToolAccess.requireDeclaredCapability(
        profiles,
        "thread.report_result",
        "write",
        {},
      ).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.result,
      );
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.provide(testLayer)),
);

it.effect("wakes a waiting write on settlement and rechecks authority and generation", () =>
  Effect.gen(function* () {
    yield* Fixture.seed;
    const gate = yield* ChannelSessionReceiptGate.ChannelSessionReceiptGate;
    const sql = yield* SqlClient.SqlClient;
    const pending = yield* gate
      .require(sessionScope().thread!)
      .pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("1 second");
    yield* sql`UPDATE channel_tasks SET generation = 2`;
    yield* Fixture.settle;
    expect((yield* Fiber.join(pending))._tag).toBe("Failure");
    expect(
      (yield* (yield* SessionReceiptGate.SessionReceiptGate).inspect(
        Fixture.threadId,
        Fixture.runId,
      )).state,
    ).toBe("invalid");
  }).pipe(Effect.provide(testLayer)),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "receipt-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "receipt-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
it.effect.each(["direct", "call", "eval"] as const)(
  "F2: a real docs.read MCP tool through %s completes while this session's receipt is held",
  (route) =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const server = yield* McpServer.McpServer;
      const result = yield* server
        .callTool(
          route === "direct"
            ? { name: "goat_docs_read", arguments: {} }
            : route === "call"
              ? { name: "goat_call", arguments: { path: "docs.read" } }
              : { name: "goat_eval", arguments: { program: "(docs.read)" } },
        )
        .pipe(
          Effect.provideService(McpSchema.McpServerClient, mcpClient),
          Effect.provideService(McpInvocationContext.McpInvocationContext, sessionScope()),
        );
      expect(result.isError).not.toBe(true);
      expect(
        result.content.some((part) => part.type === "text" && part.text.includes("guides")),
      ).toBe(true);
      expect(
        (yield* (yield* SessionReceiptGate.SessionReceiptGate).inspect(
          Fixture.threadId,
          Fixture.runId,
        )).state,
      ).toBe("held");
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          McpHttpServer.catalogRegistrations.docs,
          McpHttpServer.catalogRegistrations.agentSurface,
        ).pipe(
          Layer.provide(
            Layer.mock(ServerSecretStore.ServerSecretStore)({
              getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
            }),
          ),
          Layer.provide(Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({})),
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(UserDocs.layer),
          Layer.provide(NodeServices.layer),
          Layer.provideMerge(testLayer),
        ),
      ),
    ),
);

it.effect(
  "real delivery settlement wakes a waiting write and revoked authority is checked after the wait",
  () =>
    Effect.gen(function* () {
      yield* Fixture.seed;
      const ledger = yield* ChannelLedger.ChannelLedger;
      const profiles = yield* Profiles.PermissionProfiles;
      let authorizationChecks = 0;
      const scope = {
        ...sessionScope(),
        reauthorize: () => {
          authorizationChecks += 1;
          return Effect.fail(
            new EnvironmentAuthorizationError({
              message: "Revoked",
              requiredScope: "orchestration:operate",
            }),
          );
        },
      };
      const pending = yield* McpToolAccess.requireDeclaredCapability(
        profiles,
        "thread.report_result",
        "write",
        {},
      ).pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.result,
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      expect(authorizationChecks).toBe(0);
      expect(
        yield* ledger.claimOwnership({
          token: "receipt-owner",
          now: "1970-01-01T00:00:01.000Z",
          staleBefore: "1970-01-01T00:00:00.000Z",
        }),
      ).toBe(true);
      yield* ledger.recordDelivery({
        owner: "receipt-owner",
        deliveryId: ChannelDeliveryId.make("receipt-delivery"),
        now: "1970-01-01T00:00:01.000Z",
        outcome: { type: "delivered" },
      });
      expect((yield* Fiber.join(pending))._tag).toBe("Failure");
      expect(authorizationChecks).toBe(1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect("refuses a session credential without an authenticated run identity", () =>
  Effect.gen(function* () {
    yield* Fixture.seed;
    const gate = yield* ChannelSessionReceiptGate.ChannelSessionReceiptGate;
    const result = yield* gate
      .require({
        threadId: Fixture.threadId,
        providerSessionId: Fixture.providerSessionId,
        providerInstanceId: Fixture.providerInstanceId,
      })
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(testLayer)),
);
