import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  GoatclawRole,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChannelSessionReceiptGate from "./ChannelSessionReceiptGate.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import { LifecycleAdmissionReceipt } from "./LifecycleAdmissionReceipt.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { newCommandId } from "./threadAccess.ts";
import { argumentsDigest } from "./ToolAdmission.ts";

class SettlementProbe extends Context.Service<
  SettlementProbe,
  {
    readonly runs: Ref.Ref<number>;
    readonly lastCommandId: Ref.Ref<string | null>;
    readonly shellPresent: Ref.Ref<boolean>;
    readonly runtimeMode: Ref.Ref<RuntimeMode>;
    readonly customCorrelationId: Ref.Ref<string | null>;
    readonly failUncertain: Ref.Ref<boolean>;
    readonly gateAllowed: Ref.Ref<boolean>;
  }
>()("goat/mcp/ToolAdmissionSettlement.test/SettlementProbe") {}

const projectDelete = agentSurfaceRegistry["project.delete"];
const projectList = agentSurfaceRegistry["project.list"];
const threadFork = agentSurfaceRegistry["thread.fork"];
const threadOrganize = agentSurfaceRegistry["thread.organize"];
const threadList = agentSurfaceRegistry["thread.list"];
const threadRead = agentSurfaceRegistry["thread.read"];
const sshLaunch = agentSurfaceRegistry["ssh.thread_launch"];

const writeSchema = {
  parameters: Schema.Struct({
    projectId: Schema.optional(Schema.String),
    threadId: Schema.optional(Schema.String),
    host: Schema.optional(Schema.String),
    action: Schema.optional(Schema.String),
    goatclawRole: Schema.optional(GoatclawRole),
    clientRequestId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({
    run: Schema.Number,
    commandId: Schema.String,
    sequence: Schema.optional(Schema.Number),
    targetThreadId: Schema.optional(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [SettlementProbe],
};

const readSchema = {
  parameters: Schema.Struct({
    host: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ ok: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
};

const SettlementToolkit = Toolkit.make(
  Tool.make(projectDelete.name, writeSchema),
  Tool.make(threadFork.name, writeSchema),
  Tool.make(threadOrganize.name, writeSchema),
  Tool.make(sshLaunch.name, writeSchema),
  Tool.make(projectList.name, readSchema),
  Tool.make(threadList.name, readSchema),
  Tool.make(threadRead.name, readSchema),
);

const runWrite = McpToolAccess.writesWithCapability(() =>
  Effect.gen(function* () {
    const probe = yield* SettlementProbe;
    const commandId = yield* newCommandId();
    yield* Ref.set(probe.lastCommandId, commandId);
    const customCorrelation = yield* Ref.get(probe.customCorrelationId);
    if (customCorrelation !== null) {
      const receipt = yield* Effect.serviceOption(LifecycleAdmissionReceipt);
      if (receipt._tag === "Some") {
        yield* receipt.value.correlate(customCorrelation);
      }
    }
    const run = yield* Ref.updateAndGet(probe.runs, (n) => n + 1);
    if (yield* Ref.get(probe.failUncertain)) {
      return yield* new OrchestratorMcpFailure({
        code: "host_unavailable",
        reason: "ssh_failed",
        message: "Connection dropped after dispatch.",
        mayHaveStarted: true,
      });
    }
    return { run, commandId };
  }),
);

const runRead = McpToolAccess.reads(() => Effect.succeed({ ok: true }));

const handlers = {
  [projectDelete.name]: runWrite,
  [threadFork.name]: runWrite,
  [threadOrganize.name]: runWrite,
  [sshLaunch.name]: runWrite,
  [projectList.name]: runRead,
  [threadList.name]: runRead,
  [threadRead.name]: runRead,
} as unknown as McpToolAccess.Handlers<typeof SettlementToolkit.tools>;

const caller = ThreadId.make("thread:caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${caller}`,
  thread: {
    threadId: caller,
    providerSessionId: `provider:${caller}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const probeLayer = Layer.effect(
  SettlementProbe,
  Effect.all({
    runs: Ref.make(0),
    lastCommandId: Ref.make<string | null>(null),
    shellPresent: Ref.make(true),
    runtimeMode: Ref.make<RuntimeMode>("full-access"),
    customCorrelationId: Ref.make<string | null>(null),
    failUncertain: Ref.make(false),
    gateAllowed: Ref.make(true),
  }),
);

const threadsLayer = Layer.unwrap(
  Effect.map(SettlementProbe, (probe) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.gen(function* () {
          if (!(yield* Ref.get(probe.shellPresent))) return null;
          const runtimeMode = yield* Ref.get(probe.runtimeMode);
          return liveThreadShell(threadId, { runtimeMode, interactionMode: "default" });
        }),
    }),
  ),
);

const gateLayer = Layer.unwrap(
  Effect.gen(function* () {
    const probe = yield* SettlementProbe;
    const sql = yield* SqlClient.SqlClient;
    const check = () =>
      sql`SELECT 1`.pipe(
        Effect.orDie,
        Effect.andThen(Ref.get(probe.gateAllowed)),
        Effect.flatMap((allowed) =>
          allowed
            ? Effect.void
            : Effect.fail(
                new OrchestratorMcpFailure({
                  code: "provider_unavailable",
                  reason: "session_receipt_pending",
                  message: "Session receipt pending.",
                }),
              ),
        ),
      );
    return Layer.succeed(
      ChannelSessionReceiptGate.ChannelSessionReceiptGate,
      ChannelSessionReceiptGate.ChannelSessionReceiptGate.of({
        require: check,
        requireSettled: check,
      }),
    );
  }),
);

const served = Layer.mergeAll(
  McpHttpServer.toolkitRegistration(
    SettlementToolkit,
    McpToolAccess.toLayer(SettlementToolkit, handlers),
  ),
  McpHttpServer.catalogRegistrations.agentSurface,
).pipe(
  Layer.provideMerge(threadsLayer),
  Layer.provideMerge(gateLayer),
  Layer.provideMerge(probeLayer),
  Layer.provideMerge(
    Layer.mock(ServerSecretStore.ServerSecretStore)({
      getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
    }),
  ),
  Layer.provideMerge(Profiles.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(Layer.mock(HostThreadsMcpService.HostThreadsMcpService)({})),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    ServerSettings.layerTest({ goatclaw: { enabled: true, defaultProfile: "owner" } }),
  ),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "settlement-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "settlement-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const seed = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${caller}, 'project', 'Test', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`,
  ),
);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const callTool = (
  name: string,
  args: Record<string, unknown> = {},
  as: McpInvocationContext.McpInvocationScope = scope,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeJson(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, as),
  );

const runs = Effect.flatMap(SettlementProbe, (probe) => Ref.get(probe.runs));
const lastCommandId = Effect.flatMap(SettlementProbe, (probe) => Ref.get(probe.lastCommandId));

it.effect("derives newCommandId from the held reservation receiptId", () =>
  Effect.gen(function* () {
    yield* seed;
    const first = (yield* callTool(projectDelete.name, {
      projectId: "p1",
      clientRequestId: "derive-1",
    })) as { readonly commandId: string };
    const sql = yield* SqlClient.SqlClient;
    const [row] = yield* sql<{ readonly receipt_id: string }>`
      SELECT receipt_id FROM mcp_request_reservations WHERE client_request_id = 'derive-1'`;
    expect(first.commandId).toBe(`mcp:${row!.receipt_id}`);
    expect(yield* lastCommandId).toBe(`mcp:${row!.receipt_id}`);
  }).pipe(Effect.provide(served)),
);

it.effect(
  "settles an unknown thread.fork with an accepted receipt to completed on reconcile read and refreshes its 24h TTL",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER block_fork_settle BEFORE UPDATE ON mcp_request_reservations
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      const first = (yield* callTool(threadFork.name, {
        threadId: "t1",
        clientRequestId: "fork-1",
      })) as { readonly commandId: string };
      const [row] = yield* sql<{ readonly receipt_id: string }>`
        SELECT receipt_id FROM mcp_request_reservations WHERE client_request_id = 'fork-1'`;
      expect(first.commandId).toBe(`mcp:${row!.receipt_id}`);
      yield* sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
        VALUES (${first.commandId}, 'thread', 't1', 'thread.fork', '2026-10-23T00:00:00.000Z', 42, 'accepted', NULL)`;
      // Before reconcile, the retry is blocked as outcome_unknown.
      expect(
        yield* callTool(threadFork.name, { threadId: "t1", clientRequestId: "fork-1" }),
      ).toMatchObject({ reason: "outcome_unknown" });

      // Even after 25 hours, settling via the reconcile read refreshes the 24h window so replay works.
      yield* TestClock.adjust("25 hours");
      yield* sql`DROP TRIGGER block_fork_settle`;
      expect(yield* callTool(threadList.name, {})).toEqual({ ok: true });

      const replayed = yield* callTool(threadFork.name, {
        threadId: "t1",
        clientRequestId: "fork-1",
      });
      expect(replayed).toEqual({
        sequence: 42,
        targetThreadId: `${first.commandId}:fork`,
      });
      expect(
        yield* callTool("goat_call", {
          path: threadFork.path,
          args: { threadId: "t1", clientRequestId: "fork-1" },
        }),
      ).toEqual({
        status: "ok",
        value: { sequence: 42, targetThreadId: `${first.commandId}:fork` },
      });
      expect(yield* runs).toBe(1);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "releases a correlated unknown project.delete when no command receipt exists, but keeps legacy uncorrelated rows unknown",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER block_del_settle BEFORE UPDATE ON mcp_request_reservations
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      yield* callTool(projectDelete.name, { projectId: "p1", clientRequestId: "del-1" });
      expect(
        yield* callTool(projectDelete.name, { projectId: "p1", clientRequestId: "del-1" }),
      ).toMatchObject({ reason: "outcome_unknown" });

      // Also seed a legacy reservation without correlated: true in grant_json.
      const legacyDigest = yield* argumentsDigest({ projectId: "p2" });
      yield* sql`INSERT INTO mcp_request_reservations
        (environment_id, principal, path, client_request_id, receipt_id, tool_name, args_digest, grant_json, state, boot_id, created_at, expires_at)
        VALUES ('environment', ${`thread:${caller}`}, ${projectDelete.path}, 'legacy-1', 'receipt:legacy',
          ${projectDelete.name}, ${legacyDigest},
          '{"runtimeMode":"full-access","interactionMode":"default","goatclaw":null,"role":null,"scopes":null,"readOnly":false}',
          'unknown', 'boot:stopped', '1970-01-01T00:00:00.000Z', '1970-01-02T00:00:00.000Z')`;

      yield* sql`DROP TRIGGER block_del_settle`;
      expect(yield* callTool(projectList.name, {})).toEqual({ ok: true });

      // The correlated pre-dispatch reservation was released and can now run again with the same key.
      expect(
        yield* callTool(projectDelete.name, { projectId: "p1", clientRequestId: "del-1" }),
      ).toMatchObject({ run: 2 });
      // The legacy uncorrelated reservation stays outcome_unknown.
      expect(
        yield* callTool(projectDelete.name, { projectId: "p2", clientRequestId: "legacy-1" }),
      ).toMatchObject({ reason: "outcome_unknown" });
    }).pipe(Effect.provide(served)),
);

it.effect(
  "keeps thread.organize unknown without an accepted receipt, and settles it when the receipt exists",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER block_org_settle BEFORE UPDATE ON mcp_request_reservations
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      const first = (yield* callTool(threadOrganize.name, {
        threadId: "t1",
        action: "settle",
        clientRequestId: "org-1",
      })) as { readonly commandId: string };
      yield* sql`DROP TRIGGER block_org_settle`;
      // Without a command receipt, thread.organize may have forked settleAfterRun, so it stays unknown.
      expect(yield* callTool(threadRead.name, {})).toEqual({ ok: true });
      expect(
        yield* callTool(threadOrganize.name, {
          threadId: "t1",
          action: "settle",
          clientRequestId: "org-1",
        }),
      ).toMatchObject({ reason: "outcome_unknown" });

      // Once the command receipt is present, thread.read settles it to completed.
      yield* sql`INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error)
        VALUES (${first.commandId}, 'thread', 't1', 'thread.settle', '2026-10-23T00:00:00.000Z', 19, 'accepted', NULL)`;
      expect(yield* callTool(threadRead.name, {})).toEqual({ ok: true });
      expect(
        yield* callTool(threadOrganize.name, {
          threadId: "t1",
          action: "settle",
          clientRequestId: "org-1",
        }),
      ).toEqual({ sequence: 19 });
      expect(yield* runs).toBe(1);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "releases an unknown ssh.thread_launch only after remote_dispatches records a fenced cancellation",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TRIGGER block_ssh_settle BEFORE UPDATE ON mcp_request_reservations
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-1" });
      const [row] = yield* sql<{ readonly receipt_id: string }>`
        SELECT receipt_id FROM mcp_request_reservations WHERE client_request_id = 'ssh-1'`;
      yield* sql`DROP TRIGGER block_ssh_settle`;

      // Without a fenced remote_dispatches row, thread.list keeps the reservation unknown.
      expect(yield* callTool(threadList.name, { host: "box" })).toEqual({ ok: true });
      expect(
        yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-1" }),
      ).toMatchObject({ reason: "outcome_unknown" });

      const correlationId = `rr-${row!.receipt_id}`;
      // A non-fence cancellation whose host name happens to contain "fenced" must not release the key.
      yield* sql`INSERT INTO remote_dispatches
        (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, last_error, created_at, updated_at, memory_grant_ceiling)
        VALUES (${correlationId}, 'thread', ${caller}, 'unfenced-buildbox', 'key', 'wake', 'cancelled',
          'The launched thread was deleted on unfenced-buildbox.',
          '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 'none')`;
      expect(yield* callTool(threadList.name, { host: "box" })).toEqual({ ok: true });
      expect(
        yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-1" }),
      ).toMatchObject({ reason: "outcome_unknown" });

      // Once the row carries the exact pre-launch fence message, thread.list releases the reservation.
      yield* sql`UPDATE remote_dispatches
        SET last_error = 'The launch never reached box; it is fenced there, so it cannot start late.'
        WHERE correlation_id = ${correlationId}`;

      expect(yield* callTool(threadList.name, { host: "box" })).toEqual({ ok: true });
      expect(
        yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-1" }),
      ).toMatchObject({ run: 2 });

      // A role-scoped SSH launch also releases on reconcile when fenced and the caller still holds the role.
      yield* sql`CREATE TRIGGER block_role_ssh_settle BEFORE UPDATE ON mcp_request_reservations
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      yield* callTool(sshLaunch.name, {
        host: "box",
        goatclawRole: "merge-manager",
        clientRequestId: "ssh-role-1",
      });
      const [roleRow] = yield* sql<{ readonly receipt_id: string }>`
        SELECT receipt_id FROM mcp_request_reservations WHERE client_request_id = 'ssh-role-1'`;
      yield* sql`DROP TRIGGER block_role_ssh_settle`;
      yield* sql`INSERT INTO remote_dispatches
        (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, last_error, created_at, updated_at, memory_grant_ceiling)
        VALUES (${`rr-${roleRow!.receipt_id}`}, 'thread', ${caller}, 'box', 'key', 'wake', 'cancelled',
          'The launch never reached box; it is fenced there, so it cannot start late.',
          '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 'none')`;
      expect(yield* callTool(threadList.name, { host: "box" })).toEqual({ ok: true });
      expect(
        yield* callTool(sshLaunch.name, {
          host: "box",
          goatclawRole: "merge-manager",
          clientRequestId: "ssh-role-1",
        }),
      ).toMatchObject({ run: 4 });

      // A channel-owned SSH launch that records a custom correlationId releases when that id is fenced.
      const probe = yield* SettlementProbe;
      yield* Ref.set(probe.customCorrelationId, "rr-channel-child-1");
      yield* Ref.set(probe.failUncertain, true);
      expect(
        yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-chan-1" }),
      ).toMatchObject({ reason: "ssh_failed", mayHaveStarted: true });
      yield* Ref.set(probe.failUncertain, false);
      yield* Ref.set(probe.customCorrelationId, null);
      const [chanRow] = yield* sql<{
        readonly state: string;
        readonly outcome_code: string | null;
        readonly cid: string | null;
      }>`SELECT state, outcome_code, json_extract(grant_json, '$.correlationId') AS cid
        FROM mcp_request_reservations WHERE client_request_id = 'ssh-chan-1'`;
      expect(chanRow).toEqual({
        state: "unknown",
        outcome_code: "unknown_outcome",
        cid: "rr-channel-child-1",
      });
      expect(
        yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-chan-1" }),
      ).toMatchObject({ reason: "outcome_unknown" });
      yield* sql`INSERT INTO remote_dispatches
        (correlation_id, kind, origin_thread_id, host, read_key, delivery, state, last_error, created_at, updated_at, memory_grant_ceiling)
        VALUES ('rr-channel-child-1', 'thread', ${caller}, 'box', 'key', 'wake', 'cancelled',
          'The launch never reached box; it is fenced there, so it cannot start late.',
          '2026-10-23T00:00:00.000Z', '2026-10-23T00:00:00.000Z', 'none')`;
      expect(yield* callTool(threadList.name, { host: "box" })).toEqual({ ok: true });
      expect(
        yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-chan-1" }),
      ).toMatchObject({ run: 6 });

      // If persisting custom correlationId fails, the launch stops before running and releases its reservation.
      yield* Ref.set(probe.customCorrelationId, "rr-channel-child-2");
      yield* sql`CREATE TRIGGER block_correlate_update BEFORE UPDATE OF grant_json ON mcp_request_reservations
        BEGIN SELECT RAISE(ABORT, 'correlate refused'); END`;
      expect(
        yield* callTool(sshLaunch.name, { host: "box", clientRequestId: "ssh-chan-fail" }),
      ).toMatchObject({ reason: "storage_failed", mayHaveStarted: false });
      yield* sql`DROP TRIGGER block_correlate_update`;
      yield* Ref.set(probe.customCorrelationId, null);
      expect(yield* runs).toBe(6);
      expect(
        yield* sql`SELECT receipt_id FROM mcp_request_reservations WHERE client_request_id = 'ssh-chan-fail'`,
      ).toHaveLength(0);
    }).pipe(Effect.provide(served)),
);

it.effect(
  "skips reconciliation settlement when the caller thread is unavailable, narrowed, or blocked by the channel session receipt gate",
  () =>
    Effect.gen(function* () {
      const botThread = ThreadId.make("goat-bot-session:conv-1");
      const botScope: McpInvocationContext.McpInvocationScope = {
        ...scope,
        requestNamespace: `provider:${botThread}`,
        thread: {
          threadId: botThread,
          providerSessionId: `provider:${botThread}`,
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
      };
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${botThread}, 'project', 'Bot', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`;

      yield* sql`CREATE TRIGGER block_gate_settle BEFORE UPDATE ON mcp_request_reservations
        BEGIN SELECT RAISE(ABORT, 'refused'); END`;
      yield* callTool(projectDelete.name, { projectId: "p1", clientRequestId: "gate-1" }, botScope);
      yield* sql`DROP TRIGGER block_gate_settle`;

      const probe = yield* SettlementProbe;
      const stillReserved = sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM mcp_request_reservations WHERE client_request_id = 'gate-1'`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
      );

      // 1. Channel session receipt gate refuses -> reconcile read does not release the reservation.
      yield* Ref.set(probe.gateAllowed, false);
      expect(yield* callTool(projectList.name, {}, botScope)).toEqual({ ok: true });
      expect(yield* stillReserved).toBe(1);
      yield* Ref.set(probe.gateAllowed, true);

      // 2. Thread shell lookup returns null -> reconcile read does not fall back to full-access.
      yield* Ref.set(probe.shellPresent, false);
      expect(yield* callTool(projectList.name, {}, botScope)).toEqual({ ok: true });
      expect(yield* stillReserved).toBe(1);
      yield* Ref.set(probe.shellPresent, true);

      // 3. Caller runtime mode narrowed -> reconcile read does not settle.
      yield* Ref.set(probe.runtimeMode, "approval-required");
      expect(yield* callTool(projectList.name, {}, botScope)).toEqual({ ok: true });
      expect(yield* stillReserved).toBe(1);
      yield* Ref.set(probe.runtimeMode, "full-access");

      // 4. Once gate and grant are restored, reconcile read releases the pre-dispatch reservation.
      expect(yield* callTool(projectList.name, {}, botScope)).toEqual({ ok: true });
      expect(yield* stillReserved).toBe(0);
    }).pipe(Effect.provide(served)),
);
