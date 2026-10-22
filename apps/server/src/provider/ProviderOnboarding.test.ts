import { expect, it } from "@effect/vitest";
import {
  EnvironmentAuthorizationError,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSetupError,
  RunId,
  ThreadId,
  TurnItemId,
  handoffSummary,
  type Handoff,
  type ProviderAuthState,
  type ServerProvider,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as CloudAgents from "../cloudAgents/CloudAgentService.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Invocation from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Handlers from "../mcp/toolkits/provider/handlers.ts";
import { ProviderToolkit } from "../mcp/toolkits/provider/tools.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as HomeRequests from "./CodexHomeRequests.ts";
import * as HostSync from "./ProviderHostSync.ts";
import * as Routing from "./ProviderDiagnosisRouting.ts";
import * as ProviderAuthService from "./ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as Onboarding from "./ProviderOnboarding.ts";
import * as ProviderSettingsService from "./ProviderSettings.ts";

const SECRET = "sk-ant-SECRET-9f8e7d";
const environmentId = EnvironmentId.make("env-local");
const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("agent-thread");

const snapshot = (overrides: Partial<ServerProvider>) =>
  ({
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: "Claude",
    enabled: true,
    installed: true,
    version: "2.1.0",
    status: "warning",
    auth: { status: "unauthenticated" },
    setup: { canAuthenticate: true, canInstall: false },
    ...overrides,
  }) as ServerProvider;

// Every field a flow can carry that must not leave the owning client.
const leakyState = (flowId: string): ProviderAuthState => ({
  instanceId,
  phase: "waiting",
  flowId,
  authorizationUrl: `https://claude.ai/oauth/authorize?code_challenge=${SECRET}`,
  expiresAt: null,
  message: null,
  interaction: { type: "terminal", id: "terminal", output: `Paste code: ${SECRET}` },
  credentialOwner: "provider",
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const scopeBase = {
  environmentId,
  requestNamespace: "test",
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
  reauthorize: () => Effect.void,
};
const personClient: Invocation.McpInvocationScope = {
  ...scopeBase,
  thread: undefined,
  client: { sessionId: "person-session", label: "CLI", access: "full-access" },
  grantedScopes: ["orchestration:operate", "providers:manage"],
};
const otherClient: Invocation.McpInvocationScope = {
  ...personClient,
  client: { sessionId: "other-session", label: "Other", access: "full-access" },
};
const agentThread: Invocation.McpInvocationScope = {
  ...scopeBase,
  // liveThreadShell runs on the codex instance; the caller must match it to be live.
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  grantedScopes: ["orchestration:read"],
};

const harness = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const starts: Array<string> = [];
  const created: Array<Parameters<Handoffs.Handoffs["Service"]["create"]>[0]> = [];
  const owners = new Map<string, string>();
  const projection = {
    ...idleThreadProjection(liveThreadShell(threadId)),
    runs: [
      {
        id: RunId.make("run-1"),
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "test" },
        providerThreadId: null,
        userMessageId: MessageId.make("message-1"),
        rootNodeId: NodeId.make("node-1"),
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        memoryGrantCeiling: "none" as const,
      },
    ],
  };
  const dependencies = Layer.mergeAll(
    Layer.succeed(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) =>
        Effect.succeed(liveThreadShell(id, { activeRunId: RunId.make("run-1") })),
      getThreadSnapshot: () =>
        Effect.succeed({ schemaVersion: 1, snapshotSequence: 0, projection }),
    }),
    Layer.mock(Handoffs.Handoffs)({
      create: (input) =>
        Effect.sync(() => {
          created.push(input);
          const handoff: Handoff = {
            handoffId: TurnItemId.make("handoff:setup"),
            kind: input.kind,
            title: input.title,
            reason: input.reason,
            requestedBy: input.requestedBy,
            target: input.target,
            dedupeKey: "k",
            state: "pending",
            expiresAt: input.expiresAt ?? null,
            createdAt: now,
            actor: { type: "agent", threadId },
          };
          return handoffSummary(handoff);
        }),
    }),
    Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      getInstance: (id) =>
        Effect.succeed(
          id === instanceId
            ? ({
                instanceId,
                driverKind: ProviderDriverKind.make("claudeAgent"),
                displayName: "Claude",
                auth: {},
              } as never)
            : undefined,
        ),
      listInstances: Effect.succeed([
        { snapshot: { getSnapshot: Effect.succeed(snapshot({})) } } as never,
      ]),
      listUnavailable: Effect.succeed([]),
    }),
    Layer.mock(ProviderAuthService.ProviderAuthService)({
      start: (input, owner) =>
        input.methodId === "leaky-error"
          ? Effect.fail(
              new ProviderSetupError({
                instanceId,
                operation: "start",
                detail: `Callback https://localhost/cb?code=${SECRET} failed`,
              }),
            )
          : Effect.sync(() => {
              starts.push(owner);
              owners.set("flow-1", owner);
              return leakyState("flow-1");
            }),
      // Mirrors ProviderAuthFlow: another session sees no flow id.
      subscribe: (_, owner) =>
        Stream.make(owners.get("flow-1") === owner ? leakyState("flow-1") : leakyState("")).pipe(
          Stream.map((state) => (state.flowId === "" ? { ...state, flowId: null } : state)),
        ),
      cancel: (input, owner) =>
        Effect.sync(() => ({
          ...leakyState(input.flowId),
          phase: owners.get(input.flowId) === owner ? ("cancelled" as const) : ("waiting" as const),
        })),
    }),
  );
  const registered = McpHttpServer.toolkitRegistration(ProviderToolkit, Handlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(Layer.mock(HomeRequests.CodexHomeRequests)({})),
    Layer.provide(
      Layer.mock(ProviderSettingsService.ProviderSettings)({
        presentDiagnosis: (result) => Effect.succeed(result),
      }),
    ),
    Layer.provide(Layer.mock(Routing.ProviderDiagnosisRouting)({})),
    Layer.provide(Layer.mock(HostSync.ProviderHostSync)({})),
    Layer.provide(Layer.mock(CloudAgents.CloudAgentService)({})),
    Layer.provide(Onboarding.layer),
    Layer.provide(dependencies),
  );
  const call = (scope: Invocation.McpInvocationScope, name: string, args: object) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(Invocation.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provide(registered),
    );
  return { call, starts, created };
});

it.effect("a person's client starts its own flow and sees only the redacted state", () =>
  Effect.gen(function* () {
    const { call, starts, created } = yield* harness;
    const result = yield* call(personClient, "goat_provider_login_start", { instanceId });
    expect(result.isError).toBe(false);
    expect(starts).toEqual(["person-session"]);
    expect(created).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      kind: "flow",
      flow: { flowId: "flow-1", phase: "waiting", continueIn: "app", deviceCode: null },
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);

    const status = yield* call(personClient, "goat_provider_login_status", {
      instanceId,
      flowId: "flow-1",
    });
    expect(status.structuredContent).toMatchObject({ kind: "flow" });
    expect(JSON.stringify(status)).not.toContain(SECRET);
  }),
);

it.effect("a driver's error text never reaches the MCP result", () =>
  Effect.gen(function* () {
    const { call } = yield* harness;
    const result = yield* call(personClient, "goat_provider_login_start", {
      instanceId,
      methodId: "leaky-error",
    });
    expect(result.structuredContent).toMatchObject({ kind: "error", code: "sign_in_failed" });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  }),
);

it.effect("another session cannot read a flow id it did not start", () =>
  Effect.gen(function* () {
    const { call } = yield* harness;
    yield* call(personClient, "goat_provider_login_start", { instanceId });
    const replay = yield* call(otherClient, "goat_provider_login_status", {
      instanceId,
      flowId: "flow-1",
    });
    expect(replay.structuredContent).toMatchObject({ kind: "error", code: "not_found" });
    expect(JSON.stringify(replay)).not.toContain(SECRET);
  }),
);

it.effect("an agent thread never starts a flow; it gets a provider.setup handoff", () =>
  Effect.gen(function* () {
    const { call, starts, created } = yield* harness;
    const result = yield* call(agentThread, "goat_provider_login_start", { instanceId });
    expect(starts).toEqual([]);
    expect(result.structuredContent).toMatchObject({
      kind: "needs_human",
      handoff: { targetPath: "provider.setup", expiresAt: expect.any(String) },
      next: { call: "goat_provider_addable_list" },
    });
    expect(created[0]?.human.providerSetup).toEqual({ driver: "claudeAgent", instanceId });
    // Human instructions stay in the private payload.
    expect(JSON.stringify(result)).not.toContain(created[0]!.human.location);

    const status = yield* call(agentThread, "goat_provider_login_status", {
      instanceId,
      flowId: "flow-1",
    });
    expect(status.structuredContent).toMatchObject({ kind: "error", code: "not_found" });
  }),
);

it.effect("a client without providers:manage is routed to a person too", () =>
  Effect.gen(function* () {
    const { call, starts } = yield* harness;
    const result = yield* call(
      { ...personClient, grantedScopes: ["orchestration:operate"] },
      "goat_provider_login_start",
      { instanceId },
    );
    expect(starts).toEqual([]);
    expect(result.structuredContent).toMatchObject({ kind: "error", code: "unsupported" });
  }),
);

it.effect("setup_open validates the driver and lists addable providers with their state", () =>
  Effect.gen(function* () {
    const { call, created } = yield* harness;
    const unknown = yield* call(agentThread, "goat_provider_setup_open", { driver: "nope" });
    expect(unknown.structuredContent).toMatchObject({ kind: "error", code: "not_found" });
    const opened = yield* call(agentThread, "goat_provider_setup_open", { driver: "grok" });
    expect(opened.structuredContent).toMatchObject({ kind: "needs_human" });
    expect(created.at(-1)?.human.providerSetup).toEqual({ driver: "grok" });

    const listed = yield* call(agentThread, "goat_provider_addable_list", {});
    const claude = (
      listed.structuredContent as { drivers: ReadonlyArray<{ driver: string }> }
    ).drivers.find((entry) => entry.driver === "claudeAgent");
    expect(claude).toMatchObject({
      install: { state: "installed", inApp: false, version: "2.1.0" },
      signIn: { kind: "terminal", inApp: true, command: null },
      instances: [{ instanceId, auth: "unauthenticated" }],
    });
  }),
);

it.effect(
  "a thread with only orchestration:read gets setup and login handoffs; a read-only or dead turn does not",
  () =>
    Effect.gen(function* () {
      const { call, starts, created } = yield* harness;
      const seen: Array<ReadonlyArray<string>> = [];
      const thread: Invocation.McpInvocationScope = {
        ...agentThread,
        reauthorize: (required) => Effect.sync(() => void seen.push(required)),
      };
      const opened = yield* call(thread, "goat_provider_setup_open", { driver: "grok" });
      expect(opened.structuredContent).toMatchObject({ kind: "needs_human" });
      const login = yield* call(thread, "goat_provider_login_start", { instanceId });
      expect(login.structuredContent).toMatchObject({
        kind: "needs_human",
        handoff: { targetPath: "provider.setup" },
      });
      expect(seen).toEqual([["orchestration:read"], ["orchestration:read"]]);
      expect(starts).toEqual([]);

      const readOnly = yield* call({ ...thread, readOnly: true }, "goat_provider_login_start", {
        instanceId,
      });
      expect(readOnly.structuredContent).toMatchObject({ kind: "error", code: "unsupported" });
      const dead = yield* call(
        {
          ...thread,
          reauthorize: () =>
            Effect.fail(
              new EnvironmentAuthorizationError({
                requiredScope: "orchestration:read",
                message: "The turn is no longer live.",
              }),
            ),
        },
        "goat_provider_setup_open",
        { driver: "grok" },
      );
      expect(dead.structuredContent).toMatchObject({ kind: "error", code: "capability_denied" });
      expect(starts).toEqual([]);
      expect(created).toHaveLength(2);
    }),
);

it("derives the provider's own command when sign-in cannot run in the app", () => {
  const [opencode] = Onboarding.buildAddableDrivers(
    [{ driverKind: "opencode", displayName: "OpenCode" }],
    [],
  );
  expect(opencode).toMatchObject({
    install: { state: "unknown" },
    signIn: { kind: "command", inApp: false, command: "opencode auth login" },
  });
});
