import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadsLayer } from "./McpToolAccess.testkit.ts";
import { argumentsDigest } from "./ToolAdmission.ts";

/** What the keyed write did, so a test can tell a replay from a second run. */
class Probe extends Context.Service<
  Probe,
  {
    readonly runs: Ref.Ref<number>;
    readonly started: Deferred.Deferred<void>;
    readonly release: Deferred.Deferred<void>;
  }
>()("goat/mcp/ToolAdmission.test/Probe") {}

// A keyed write (project.delete: idempotency "key", settings.write) whose outcome the test picks.
const keyed = agentSurfaceRegistry["project.delete"];
const ProbeToolkit = Toolkit.make(
  Tool.make(keyed.name, {
    parameters: Schema.Struct({
      projectId: Schema.String,
      force: Schema.optional(Schema.Boolean),
      clientRequestId: Schema.optional(Schema.String),
    }),
    success: Schema.Struct({ run: Schema.Number }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Probe],
  }),
);

const outcomes: Readonly<Record<string, OrchestratorMcpFailure>> = {
  pressure: new OrchestratorMcpFailure({ code: "host_pressure", message: "busy" }),
  unreachable: new OrchestratorMcpFailure({ code: "host_unavailable", message: "gone" }),
  missing: new OrchestratorMcpFailure({ code: "not_found", message: "no project" }),
};

const handlers = {
  [keyed.name]: McpToolAccess.writesWithCapability(
    ({ projectId }: { readonly projectId: string }) =>
      Effect.gen(function* () {
        const probe = yield* Probe;
        const run = yield* Ref.updateAndGet(probe.runs, (runs) => runs + 1);
        if (projectId === "park") {
          yield* Deferred.succeed(probe.started, undefined);
          yield* Deferred.await(probe.release);
        }
        const failure = outcomes[projectId];
        return failure === undefined ? { run } : yield* failure;
      }),
  ),
} as unknown as McpToolAccess.Handlers<typeof ProbeToolkit.tools>;

const served = (defaultProfile: string) =>
  Layer.mergeAll(
    McpHttpServer.toolkitRegistration(ProbeToolkit, McpToolAccess.toLayer(ProbeToolkit, handlers)),
    McpHttpServer.catalogRegistrations.agentSurface,
  ).pipe(
    Layer.provideMerge(
      Layer.effect(
        Probe,
        Effect.all({
          runs: Ref.make(0),
          started: Deferred.make<void>(),
          release: Deferred.make<void>(),
        }),
      ),
    ),
    Layer.provideMerge(Profiles.layer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(liveThreadsLayer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest({ goatclaw: { enabled: true, defaultProfile } })),
  );

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "admission-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "admission-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

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

const seed = SqlClient.SqlClient.pipe(
  Effect.flatMap(
    (sql) => sql`INSERT INTO orchestration_v2_projection_threads
    (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
    VALUES (${caller}, 'project', 'Test', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`,
  ),
);

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const callTool = (name: string, args: Record<string, unknown>) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeJson(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
  );
const direct = (args: Record<string, unknown>) => callTool(keyed.name, args);
const viaGoatCall = (args: Record<string, unknown>) =>
  callTool("goat_call", { path: keyed.path, args });
const runs = Effect.flatMap(Probe, (probe) => Ref.get(probe.runs));

it.effect("replays a repeat with the same arguments, in any key order, without running again", () =>
  Effect.gen(function* () {
    yield* seed;
    const first = yield* direct({ projectId: "a", force: true, clientRequestId: "k" });
    expect(first).toEqual({ run: 1 });
    expect(yield* direct({ clientRequestId: "k", force: true, projectId: "a" })).toEqual(first);
    expect(yield* runs).toBe(1);
    // Without a key every call runs.
    expect(yield* direct({ projectId: "a", force: true })).toEqual({ run: 2 });
  }).pipe(Effect.provide(served("owner"))),
);

it.effect(
  "refuses a key reused with other arguments as idempotency_mismatch and runs nothing",
  () =>
    Effect.gen(function* () {
      yield* seed;
      yield* direct({ projectId: "a", clientRequestId: "k" });
      expect(yield* direct({ projectId: "b", clientRequestId: "k" })).toMatchObject({
        code: "conflict",
        reason: "idempotency_mismatch",
      });
      expect(yield* viaGoatCall({ projectId: "b", clientRequestId: "k" })).toMatchObject({
        status: "error",
        error: { code: "conflict", reason: "idempotency_mismatch", retryable: false },
      });
      expect(yield* runs).toBe(1);
    }).pipe(Effect.provide(served("owner"))),
);

it.effect("answers in_progress while the first call runs, then replays its result", () =>
  Effect.gen(function* () {
    yield* seed;
    const probe = yield* Probe;
    const first = yield* Effect.forkChild(direct({ projectId: "park", clientRequestId: "k" }));
    yield* Deferred.await(probe.started);
    expect(yield* direct({ projectId: "park", clientRequestId: "k" })).toMatchObject({
      code: "conflict",
      reason: "in_progress",
    });
    expect(yield* viaGoatCall({ projectId: "park", clientRequestId: "k" })).toMatchObject({
      status: "error",
      error: { code: "conflict", reason: "in_progress" },
    });
    yield* Deferred.succeed(probe.release, undefined);
    expect(yield* Fiber.join(first)).toEqual({ run: 1 });
    expect(yield* direct({ projectId: "park", clientRequestId: "k" })).toEqual({ run: 1 });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect(
  "holds a key a stopped server left running as unknown_outcome and never dispatches it",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const sql = yield* SqlClient.SqlClient;
      const digest = yield* argumentsDigest({ projectId: "a" });
      yield* sql`INSERT INTO mcp_request_reservations (environment_id, principal, path,
      client_request_id, receipt_id, tool_name, args_digest, state, boot_id, created_at, expires_at)
      VALUES ('environment', ${`thread:${caller}`}, ${keyed.path}, 'k', 'receipt:stopped',
        ${keyed.name}, ${digest}, 'running', 'boot:stopped', '1970-01-01T00:00:00.000Z',
        '1970-01-02T00:00:00.000Z')`;
      expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
        code: "conflict",
        reason: "outcome_unknown",
        mayHaveStarted: true,
        reconcile: "project.list",
      });
      expect(yield* viaGoatCall({ projectId: "a", clientRequestId: "k" })).toMatchObject({
        status: "error",
        error: {
          code: "unknown_outcome",
          reason: "outcome_unknown",
          retryable: false,
          details: { reconcile: "project.list" },
        },
      });
      // Unsettled keys never expire into a second dispatch.
      yield* TestClock.adjust("48 hours");
      expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
        reason: "outcome_unknown",
      });
      expect(yield* runs).toBe(0);
    }).pipe(Effect.provide(served("owner"))),
);

it.effect("holds an interrupted call's key as unknown_outcome", () =>
  Effect.gen(function* () {
    yield* seed;
    const probe = yield* Probe;
    const first = yield* Effect.forkChild(direct({ projectId: "park", clientRequestId: "k" }));
    yield* Deferred.await(probe.started);
    yield* Fiber.interrupt(first);
    expect(yield* direct({ projectId: "park", clientRequestId: "k" })).toMatchObject({
      reason: "outcome_unknown",
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("refuses a replay with permission_denied once the caller lost its grant", () =>
  Effect.gen(function* () {
    yield* seed;
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({ goatclaw: { ...policy, defaultProfile: "observer" } });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* viaGoatCall({ projectId: "a", clientRequestId: "k" })).toMatchObject({
      status: "error",
      error: { code: "permission_denied", reason: "capability_denied" },
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("shares one reservation between a direct call and goat_call", () =>
  Effect.gen(function* () {
    yield* seed;
    expect(yield* viaGoatCall({ projectId: "a", clientRequestId: "k" })).toEqual({
      status: "ok",
      value: { run: 1 },
    });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    expect(yield* direct({ projectId: "a", clientRequestId: "j" })).toEqual({ run: 2 });
    expect(yield* viaGoatCall({ projectId: "a", clientRequestId: "j" })).toEqual({
      status: "ok",
      value: { run: 2 },
    });
    expect(yield* runs).toBe(2);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect(
  "frees the key after a transient refusal that ran nothing, and replays other failures",
  () =>
    Effect.gen(function* () {
      yield* seed;
      expect(yield* direct({ projectId: "pressure", clientRequestId: "p" })).toMatchObject({
        code: "host_pressure",
      });
      expect(yield* direct({ projectId: "pressure", clientRequestId: "p" })).toMatchObject({
        code: "host_pressure",
      });
      expect(yield* runs).toBe(2);
      const missing = yield* direct({ projectId: "missing", clientRequestId: "m" });
      expect(missing).toMatchObject({ code: "not_found" });
      expect(yield* direct({ projectId: "missing", clientRequestId: "m" })).toEqual(missing);
      expect(yield* viaGoatCall({ projectId: "missing", clientRequestId: "m" })).toMatchObject({
        status: "error",
        error: { code: "not_found", reason: "not_found" },
      });
      expect(yield* runs).toBe(3);
      // A failure that may have reached its target holds the key.
      expect(yield* viaGoatCall({ projectId: "unreachable", clientRequestId: "u" })).toMatchObject({
        status: "error",
        error: { code: "unavailable", retryable: true },
      });
      expect(yield* viaGoatCall({ projectId: "unreachable", clientRequestId: "u" })).toMatchObject({
        status: "error",
        error: { code: "unknown_outcome", retryable: false },
      });
      expect(yield* runs).toBe(4);
    }).pipe(Effect.provide(served("owner"))),
);

it.effect("lets a completed key run again only after 24 hours", () =>
  Effect.gen(function* () {
    yield* seed;
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    yield* TestClock.adjust("23 hours");
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    yield* TestClock.adjust("1 hour");
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 2 });
  }).pipe(Effect.provide(served("owner"))),
);
