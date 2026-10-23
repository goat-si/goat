import { expect, it } from "@effect/vitest";
import {
  AuthProvidersManageScope,
  EnvironmentAuthorizationError,
  BUILTIN_PERMISSION_PROFILES,
  EnvironmentId,
  GoatclawRole,
  OrchestratorMcpFailure,
  PermissionProfile,
  type ProviderInteractionMode,
  type RuntimeMode,
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

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
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
      host: Schema.optional(Schema.String),
      // What a launch carries that narrows the grant it runs under.
      permissionProfileCeiling: Schema.optional(PermissionProfile),
      goatclawRole: Schema.optional(GoatclawRole),
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
  // What SSH dispatch reports when the remote stopped answering after the launch went out.
  uncertain: new OrchestratorMcpFailure({
    code: "host_unavailable",
    reason: "ssh_failed",
    mayHaveStarted: true,
    message: "The host stopped answering after the launch was sent.",
  }),
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

/** The calling thread's modes, which its user may change between a call and its replay. */
class ThreadModes extends Context.Service<
  ThreadModes,
  Ref.Ref<{ readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode }>
>()("goat/mcp/ToolAdmission.test/ThreadModes") {}

const threadsLayer = Layer.unwrap(
  Effect.map(ThreadModes, (modes) =>
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) =>
        Effect.map(Ref.get(modes), (current) => liveThreadShell(threadId, current)),
    }),
  ),
).pipe(
  Layer.provideMerge(
    Layer.effect(
      ThreadModes,
      Ref.make({
        runtimeMode: "full-access" as RuntimeMode,
        interactionMode: "default" as ProviderInteractionMode,
      }),
    ),
  ),
);

const served = (defaultProfile: string, enabled = true) =>
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
    // goat_call signs operation handles with the server's key.
    Layer.provideMerge(
      Layer.mock(ServerSecretStore.ServerSecretStore)({
        getOrCreateRandom: () => Effect.succeed(new Uint8Array(32).fill(1)),
      }),
    ),
    Layer.provideMerge(Profiles.layer),
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(threadsLayer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest({ goatclaw: { enabled, defaultProfile } })),
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
const callTool = (
  name: string,
  args: Record<string, unknown>,
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
const direct = (args: Record<string, unknown>, as?: McpInvocationContext.McpInvocationScope) =>
  callTool(keyed.name, args, as);
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
      client_request_id, receipt_id, tool_name, args_digest, grant_json, state, boot_id, created_at,
      expires_at)
      VALUES ('environment', ${`thread:${caller}`}, ${keyed.path}, 'k', 'receipt:stopped',
        ${keyed.name}, ${digest}, '{"runtimeMode":"full-access","interactionMode":"default","goatclaw":null,"role":null,"scopes":null,"readOnly":false}', 'running',
        'boot:stopped', '1970-01-01T00:00:00.000Z',
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

it.effect(
  "refuses a replay once the thread's grant narrows where the capability gate does not look",
  () =>
    Effect.gen(function* () {
      yield* seed;
      expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
      // settings.write stays, so the gate for project.delete still admits; threads.launch does not.
      const settings = yield* ServerSettings.ServerSettingsService;
      const policy = (yield* settings.getSettings).goatclaw;
      const owner = policy.profiles.owner!;
      yield* settings.updateSettings({
        goatclaw: {
          ...policy,
          profiles: {
            ...policy.profiles,
            owner: {
              ...owner,
              capabilities: owner.capabilities.filter(
                (capability) => capability !== "threads.launch",
              ),
            },
          },
        },
      });
      expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
        code: "capability_denied",
      });
      expect(yield* runs).toBe(1);
    }).pipe(Effect.provide(served("owner"))),
);

it.effect("refuses an outside client's replay once its scope is revoked or turns read-only", () =>
  Effect.gen(function* () {
    const revoked = yield* Ref.make(false);
    const client = (readOnly: boolean): McpInvocationContext.McpInvocationScope => ({
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session",
      thread: undefined,
      client: { sessionId: "session", label: "Outside agent", access: "full-access" },
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
      readOnly,
      grantedScopes: [AuthProvidersManageScope],
      reauthorize: (required) =>
        Effect.flatMap(Ref.get(revoked), (gone) =>
          gone
            ? Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "The MCP session does not grant the required scope.",
                  requiredScope: required[0] ?? AuthProvidersManageScope,
                }),
              )
            : Effect.void,
        ),
    });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" }, client(false))).toEqual({
      run: 1,
    });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" }, client(false))).toEqual({
      run: 1,
    });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" }, client(true))).toMatchObject({
      code: "capability_denied",
    });
    yield* Ref.set(revoked, true);
    expect(yield* direct({ projectId: "a", clientRequestId: "k" }, client(false))).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("reserves the key as its declared schema decodes it and refuses any other key", () =>
  Effect.gen(function* () {
    yield* seed;
    expect(yield* direct({ projectId: "a", clientRequestId: " k " })).toEqual({ run: 1 });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    for (const clientRequestId of [17, "", "  ", "x".repeat(257)])
      expect(
        yield* direct({ projectId: "a", clientRequestId }),
        String(clientRequestId),
      ).toMatchObject({
        code: "invalid_request",
      });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

const changeProfile = (id: string, change: (profile: PermissionProfile) => PermissionProfile) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({
      goatclaw: { ...policy, profiles: { ...policy.profiles, [id]: change(policy.profiles[id]!) } },
    });
  });
const narrowProfile = (id: string, without: string) =>
  changeProfile(id, (profile) => ({
    ...profile,
    capabilities: profile.capabilities.filter((capability) => capability !== without),
  }));

it.effect("refuses a forwarded launch's replay once the destination's profile narrows", () =>
  Effect.gen(function* () {
    const dispatch: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:dispatch",
      thread: undefined,
      client: { sessionId: "dispatch", label: "GOAT SSH dispatch", access: "full-access" },
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    };
    const launch = {
      projectId: "a",
      clientRequestId: "k",
      permissionProfileCeiling: BUILTIN_PERMISSION_PROFILES.owner!,
    };
    expect(yield* direct(launch, dispatch)).toEqual({ run: 1 });
    expect(yield* direct(launch, dispatch)).toEqual({ run: 1 });
    yield* narrowProfile("owner", "worktree.create");
    expect(yield* direct(launch, dispatch)).toMatchObject({ code: "capability_denied" });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("refuses a role launch's replay once the role's profile narrows", () =>
  Effect.gen(function* () {
    yield* seed;
    const launch = { projectId: "a", clientRequestId: "k", goatclawRole: "merge-manager" };
    expect(yield* direct(launch)).toEqual({ run: 1 });
    expect(yield* direct(launch)).toEqual({ run: 1 });
    yield* narrowProfile("merge-manager", "pr.merge");
    expect(yield* direct(launch)).toMatchObject({ code: "capability_denied" });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("refuses a role launch's replay once the role's runtime ceiling drops", () =>
  Effect.gen(function* () {
    yield* seed;
    const launch = { projectId: "a", clientRequestId: "k", goatclawRole: "merge-manager" };
    expect(yield* direct(launch)).toEqual({ run: 1 });
    yield* changeProfile("merge-manager", (profile) => ({
      ...profile,
      runtimeModeCeiling: "approval-required",
    }));
    expect(yield* direct(launch)).toMatchObject({ code: "capability_denied" });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("refuses a replay once the profile's host allowlist narrows", () =>
  Effect.gen(function* () {
    yield* seed;
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    yield* changeProfile("owner", (profile) => ({ ...profile, hosts: [] }));
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("refuses an outside client's replay at a lower runtime ceiling with goatclaw off", () =>
  Effect.gen(function* () {
    const client = (access: "full-access" | "auto"): McpInvocationContext.McpInvocationScope => ({
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session",
      thread: undefined,
      client: { sessionId: "session", label: "Outside agent", access },
      capabilities: new Set(["orchestration"]),
      issuedAt: 0,
    });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" }, client("full-access"))).toEqual({
      run: 1,
    });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" }, client("auto"))).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner", false))),
);

it.effect("refuses a thread's replay once its interaction mode drops to plan", () =>
  Effect.gen(function* () {
    yield* seed;
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    yield* Ref.update(yield* ThreadModes, (modes) => ({
      ...modes,
      interactionMode: "plan" as const,
    }));
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner", false))),
);

it.effect("refuses a role launch's replay once the caller's own profile narrows", () =>
  Effect.gen(function* () {
    yield* seed;
    // merge-manager never holds cloud.launch, so only the caller's own profile shows the loss.
    const launch = { projectId: "a", clientRequestId: "k", goatclawRole: "merge-manager" };
    expect(yield* direct(launch)).toEqual({ run: 1 });
    yield* narrowProfile("owner", "cloud.launch");
    expect(yield* direct(launch)).toMatchObject({ code: "capability_denied" });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect(
  "keeps an uncertain keyed write unknown_outcome through goat_call and never runs it again",
  () =>
    Effect.gen(function* () {
      yield* seed;
      expect(yield* viaGoatCall({ projectId: "uncertain", clientRequestId: "u" })).toMatchObject({
        status: "error",
        error: { code: "unknown_outcome", retryable: false },
      });
      expect(yield* viaGoatCall({ projectId: "uncertain", clientRequestId: "u" })).toMatchObject({
        status: "error",
        error: { code: "unknown_outcome", reason: "outcome_unknown", retryable: false },
      });
      expect(yield* runs).toBe(1);
    }).pipe(Effect.provide(served("owner"))),
);

it.effect("names the host to read when a routed write's outcome is unknown", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const digest = yield* argumentsDigest({ projectId: "a", host: "box" });
    yield* sql`INSERT INTO mcp_request_reservations (environment_id, principal, path,
      client_request_id, receipt_id, tool_name, args_digest, grant_json, state, boot_id,
      created_at, expires_at)
      VALUES ('environment', ${`thread:${caller}`}, ${keyed.path}, 'k', 'receipt:routed',
        ${keyed.name}, ${digest}, '{"runtimeMode":"full-access","interactionMode":"default","goatclaw":null,"role":null,"scopes":null,"readOnly":false}',
        'running', 'boot:stopped', '1970-01-01T00:00:00.000Z', '1970-01-02T00:00:00.000Z')`;
    expect(yield* direct({ projectId: "a", host: "box", clientRequestId: "k" })).toMatchObject({
      reason: "outcome_unknown",
      message: expect.stringContaining("with host box"),
    });
    expect(yield* runs).toBe(0);
  }).pipe(Effect.provide(served("owner"))),
);

it.effect("reads a key unknown in this process once its outcome could not be saved", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TRIGGER reservations_refuse_updates BEFORE UPDATE ON mcp_request_reservations
      BEGIN SELECT RAISE(ABORT, 'refused'); END`;
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
      reason: "outcome_unknown",
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);

const setGoatclaw = (enabled: boolean) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const policy = (yield* settings.getSettings).goatclaw;
    yield* settings.updateSettings({ goatclaw: { ...policy, enabled } });
  });

it.effect(
  "replays a key recorded under goatclaw after goatclaw is turned off, without running again",
  () =>
    Effect.gen(function* () {
      yield* seed;
      expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
      yield* setGoatclaw(false);
      expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
      expect(yield* viaGoatCall({ projectId: "a", clientRequestId: "k" })).toEqual({
        status: "ok",
        value: { run: 1 },
      });
      expect(yield* runs).toBe(1);
    }).pipe(Effect.provide(served("owner"))),
);

it.effect("still refuses a key recorded with goatclaw off once goatclaw is on", () =>
  Effect.gen(function* () {
    yield* seed;
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toEqual({ run: 1 });
    yield* setGoatclaw(true);
    expect(yield* direct({ projectId: "a", clientRequestId: "k" })).toMatchObject({
      code: "capability_denied",
    });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner", false))),
);

it.effect("still refuses a role launch's replay once goatclaw is turned off", () =>
  Effect.gen(function* () {
    yield* seed;
    const launch = { projectId: "a", clientRequestId: "k", goatclawRole: "merge-manager" };
    expect(yield* direct(launch)).toEqual({ run: 1 });
    yield* setGoatclaw(false);
    expect(yield* direct(launch)).toMatchObject({ code: "capability_denied" });
    expect(yield* runs).toBe(1);
  }).pipe(Effect.provide(served("owner"))),
);
