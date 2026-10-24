import { expect, it } from "@effect/vitest";
import { EnvironmentId, TurnItemId, ProviderInstanceId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import * as HomeRequests from "../../../provider/CodexHomeRequests.ts";
import * as CloudAgents from "../../../cloudAgents/CloudAgentService.ts";
import * as Routing from "../../../provider/ProviderDiagnosisRouting.ts";
import * as HostSync from "../../../provider/ProviderHostSync.ts";
import * as Onboarding from "../../../provider/ProviderOnboarding.ts";
import * as Settings from "../../../provider/ProviderSettings.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../../../persistence/Sqlite.ts";
import * as PermissionSettings from "../../../serverSettings.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as Handlers from "./handlers.ts";
import { ProviderToolkit } from "./tools.ts";

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "provider-retry-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "provider-retry-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope: Invocation.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:retry-test"),
  requestNamespace: "retry-test",
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  thread: undefined,
  client: { sessionId: "retry-test", label: "Test", access: "full-access" },
};

it.effect.each([
  ["goat_provider_home_request", { instanceId: "codex", action: "disconnect" }],
  ["goat_provider_sync", { driver: "codex", login: false }],
  ["goat_provider_setup_open", { driver: "codex" }],
  ["goat_provider_login_start", { instanceId: "codex" }],
  ["goat_cloud_agent_launch", { provider: "cursorCloud", repo: "example/repo", prompt: "Build" }],
] as const)("%s retries the same clientRequestId without starting again", ([name, args]) => {
  const invocation =
    name === "goat_provider_home_request" || name === "goat_provider_setup_open"
      ? {
          ...scope,
          client: undefined,
          thread: {
            threadId: ThreadId.make("thread:retry-test"),
            providerSessionId: "provider:retry-test",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
        }
      : scope;
  const runs: Array<unknown> = [];
  const record = (input: unknown) =>
    Effect.sync(() => {
      runs.push(input);
    });
  const handoff = {
    handoffId: TurnItemId.make("handoff:test"),
    kind: "approval" as const,
    title: "Approve",
    state: "pending" as const,
    expiresAt: null,
    targetPath: "provider.setup",
  };
  const dependencies = Layer.mergeAll(
    PermissionSettings.layerTest(),
    Layer.succeed(Invocation.McpInvocationContext, invocation),
    Layer.mock(Threads.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
    }),
    Layer.mock(Routing.ProviderDiagnosisRouting)({}),
    Layer.mock(Settings.ProviderSettings)({}),
    Layer.mock(HomeRequests.CodexHomeRequests)({
      request: (input) =>
        record(input).pipe(
          Effect.as({
            kind: "needs_human" as const,
            handoff,
            next: { after: "approval" as const, call: "goat_provider_diagnose" as const },
          }),
        ),
    }),
    Layer.mock(HostSync.ProviderHostSync)({
      sync: (input) =>
        record(input).pipe(
          Effect.as({
            kind: "started" as const,
            sync: {
              syncId: "sync-1",
              driver: "codex" as const,
              version: null,
              login: false,
              startedAt: "2026-10-24T00:00:00.000Z",
              done: true,
              hosts: [],
            },
          }),
        ),
    }),
    Layer.mock(Onboarding.ProviderOnboarding)({
      setupOpen: (input) =>
        record(input).pipe(
          Effect.as({
            kind: "needs_human" as const,
            handoff,
            next: { after: "approval" as const, call: "goat_provider_addable_list" as const },
          }),
        ),
      loginStart: (input) =>
        record(input).pipe(
          Effect.as({
            kind: "flow" as const,
            flow: {
              instanceId: ProviderInstanceId.make("codex"),
              flowId: "flow-1",
              phase: "waiting" as const,
              continueIn: "app" as const,
              deviceCode: null,
              expiresAt: null,
              message: null,
            },
          }),
        ),
    }),
    Layer.mock(CloudAgents.CloudAgentService)({
      launch: (_scope, input) =>
        record(input).pipe(
          Effect.as({
            holder: {
              provider: "cursorCloud" as const,
              host: null,
              ready: true,
              runtime: "current" as const,
            },
            dryRun: true,
          }),
        ),
    }),
  );
  const call = (key: string, as: Invocation.McpInvocationScope = invocation) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) =>
        server.callTool({ name, arguments: { ...args, clientRequestId: key } }),
      ),
      Effect.map(({ content }) => content),
      Effect.provideService(McpSchema.McpServerClient, client),
      Effect.provideService(Invocation.McpInvocationContext, as),
    );
  return Effect.gen(function* () {
    const first = yield* call("request-1");
    expect(runs).toHaveLength(1);
    expect(yield* call("request-1")).toEqual(first);
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toHaveProperty("clientRequestId");
    const denied = yield* call("request-1", { ...invocation, readOnly: true });
    expect(JSON.stringify(denied)).toContain("capability_denied");
    expect(runs).toHaveLength(1);
    yield* call("request-2");
    expect(runs).toHaveLength(2);
  }).pipe(
    Effect.provide(
      McpHttpServer.toolkitRegistration(ProviderToolkit, Handlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provideMerge(Profiles.layer),
        Layer.provide(dependencies),
        Layer.provideMerge(Sqlite.layerMemory),
      ),
    ),
  );
});
