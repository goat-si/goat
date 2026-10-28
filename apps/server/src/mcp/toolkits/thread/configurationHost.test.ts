import { layerNoFleetSync } from "../../../goatclaw/FleetSync.testkit.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type CommandId,
  type ModelSelection,
  type OrchestrationV2ServerCommand,
  type ServerProvider,
} from "@goat/contracts";
import { McpSchema, McpServer } from "effect/ai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import {
  OrchestratorCommandIdConflictError,
  OrchestratorCommandPreviouslyRejectedError,
} from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../../../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SshRemoteDispatch from "../../../sshRemote/SshRemoteDispatch.ts";
import { initialize, withRemote } from "../../../sshRemote/SshRemoteDispatch.hostCall.testkit.ts";
import { withLinkedHost } from "../../../sshRemote/testkit/LinkedHostFixture.ts";
import * as ThreadResultService from "../../../threadResults/ThreadResultService.ts";
import * as LaunchWatchService from "../../LaunchWatchService.ts";
import { newLaunchWatch } from "../../launchWatch.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadReplicaService from "../../ThreadReplicaService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";

const targetId = ThreadId.make("remote-target");
const otherTargetId = ThreadId.make("other-remote-target");
const callerId = ThreadId.make("caller");
const host = "box";
const sourceEnvironmentId = EnvironmentId.make("watched-destination");
const codex = ProviderInstanceId.make("codex");
const selection: ModelSelection = {
  instanceId: codex,
  model: "gpt-new",
  options: [{ id: "effort", value: "high" }],
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "configuration-host", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "configuration-host", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const outsideScope = (
  access: "full-access" | "read-only" = "full-access",
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("destination-environment"),
  requestNamespace: "client:configuration-host",
  thread: undefined,
  client: { sessionId: "configuration-host", label: "Fixture", access },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});

const planScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("origin-environment"),
  requestNamespace: "provider:plan-caller",
  thread: { threadId: callerId, providerSessionId: "plan-caller", providerInstanceId: codex },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { code?: string; message?: string })
    : undefined;
};

const provider = (models: ReadonlyArray<ServerProvider["models"][number]>) =>
  ({ instanceId: codex, models }) as ServerProvider;
const advertised = provider([
  {
    slug: "gpt-new",
    name: "New",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        },
      ],
    },
  },
] as ServerProvider["models"]);

type Receipt = { readonly status: "accepted" | "rejected"; readonly threadId: ThreadId };

const fixture = (
  server: McpServer.McpServer["Service"],
  options: {
    readonly initialProviders?: ReadonlyArray<ServerProvider>;
    readonly refreshedProviders?: ReadonlyArray<ServerProvider>;
    readonly destinationAccess?: "full-access" | "read-only";
    readonly rejectFirstCommand?: boolean;
  } = {},
) => {
  let providers = options.initialProviders ?? [advertised];
  const refreshedProviders = options.refreshedProviders ?? providers;
  const receipts = new Map<CommandId, Receipt>();
  const commands: OrchestrationV2ServerCommand[] = [];
  const hostCalls: SshRemoteDispatch.SshHostToolCall[] = [];
  let acceptedCommands = 0;
  let catalogReads = 0;
  let refreshCalls = 0;
  let originAuthorizations = 0;
  let destinationCalls = 0;
  const shell = McpToolAccessTestkit.liveThreadShell(targetId);
  const otherShell = McpToolAccessTestkit.liveThreadShell(otherTargetId);
  const projections = new Map([
    [targetId, McpToolAccessTestkit.idleThreadProjection(shell)],
    [otherTargetId, McpToolAccessTestkit.idleThreadProjection(otherShell)],
  ]);
  const watch = newLaunchWatch({
    launcherThreadId: null,
    owner: outsideScope().requestNamespace,
    host,
    sourceEnvironmentId,
    threadId: targetId,
    projectId: null,
    title: null,
    incarnation: "watch-1",
    notifyWebhook: false,
    now: 0,
  });
  const threadManagement = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed(
        id === callerId
          ? McpToolAccessTestkit.liveThreadShell(callerId, { interactionMode: "plan" })
          : id === otherTargetId
            ? otherShell
            : shell,
      ),
    getProjectThreadRecords: ({ threadId }) =>
      Effect.succeed(projections.get(threadId) ?? projections.get(targetId)!),
    hasReceipt: (commandId) => Effect.succeed(receipts.has(commandId)),
    dispatch: (command) => {
      if (!("threadId" in command)) return Effect.die("Configuration commands name a thread");
      commands.push(command);
      const receipt = receipts.get(command.commandId);
      if (receipt !== undefined) {
        if (receipt.threadId !== command.threadId)
          return Effect.fail(
            new OrchestratorCommandIdConflictError({
              commandId: command.commandId,
              commandType: command.type,
              receiptThreadId: receipt.threadId,
              commandThreadId: command.threadId,
            }),
          );
        if (receipt.status === "rejected")
          return Effect.fail(
            new OrchestratorCommandPreviouslyRejectedError({
              commandId: command.commandId,
              commandType: command.type,
              detail: "Previously rejected.",
            }),
          );
        return Effect.succeed({ sequence: 7, storedEvents: [] });
      }
      const rejected = options.rejectFirstCommand === true;
      receipts.set(command.commandId, {
        status: rejected ? "rejected" : "accepted",
        threadId: command.threadId,
      });
      if (rejected)
        return Effect.fail(
          new OrchestratorCommandPreviouslyRejectedError({
            commandId: command.commandId,
            commandType: command.type,
            detail: "Previously rejected.",
          }),
        );
      acceptedCommands += 1;
      if (command.type === "thread.model-selection.set" || command.type === "provider.switch") {
        const projection = projections.get(command.threadId);
        if (projection !== undefined)
          projections.set(command.threadId, {
            ...projection,
            thread: { ...projection.thread, modelSelection: command.modelSelection },
          });
      }
      return Effect.succeed({ sequence: 7, storedEvents: [] });
    },
  });
  const layer = McpHttpServer.layerThreadToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(McpToolAccessTestkit.layerPermissionProfilesOff),
    Layer.provide(layerNoFleetSync),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(ThreadResultService.ThreadResultService)({})),
    Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
    Layer.provide(
      Layer.mock(LaunchWatchService.LaunchWatchService)({ find: () => Effect.succeed(watch) }).pipe(
        Layer.provideMerge(Layer.mock(ThreadReplicaService.ThreadReplicaService)({})),
      ),
    ),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({})),
    Layer.provide(threadManagement),
    Layer.provide(
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.sync(() => {
          catalogReads += 1;
          return providers;
        }),
        refreshInstance: () =>
          Effect.sync(() => {
            refreshCalls += 1;
            providers = refreshedProviders;
            return providers;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        connectedHosts: Effect.succeed([host]),
        callHostTool: (call, authorize) =>
          Effect.gen(function* () {
            hostCalls.push(call);
            yield* authorize;
            originAuthorizations += 1;
            destinationCalls += 1;
            const result = yield* server
              .callTool({ name: call.tool, arguments: call.arguments })
              .pipe(
                Effect.provideService(
                  McpInvocationContext.McpInvocationContext,
                  outsideScope(options.destinationAccess),
                ),
                Effect.provideService(McpSchema.McpServerClient, client),
                Effect.mapError(
                  (error) =>
                    new SshRemoteDispatch.SshRemoteDispatchError({
                      reason: "remote_refused",
                      message: `Destination MCP call failed: ${String(error)}`,
                    }),
                ),
              );
            const failure = declaredFailure(result);
            if (failure !== undefined)
              return yield* new SshRemoteDispatch.SshRemoteDispatchError({
                reason: "remote_refused",
                remoteCode: failure.code,
                message: failure.message ?? "Destination refused.",
              });
            return result.structuredContent;
          }),
      }),
    ),
  );
  const call = (name: string, args: Record<string, unknown>, scope = outsideScope()) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  return {
    layer,
    call,
    commands,
    hostCalls,
    receipts,
    invalidateCatalog: () => {
      providers = [];
    },
    counts: () => ({
      acceptedCommands,
      catalogReads,
      refreshCalls,
      originAuthorizations,
      destinationCalls,
    }),
  };
};

const configure = { host, threadId: targetId, modelSelection: selection };

it.effect("routes configuration through the watched destination and replays its receipt", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const f = fixture(server);
    yield* Effect.gen(function* () {
      const first = yield* f.call("goat_thread_configure", {
        ...configure,
        clientRequestId: "same",
      });
      expect(first.isError).toBe(false);
      expect(first.structuredContent).toMatchObject({ host, sequence: 7 });
      expect(f.hostCalls[0]).toMatchObject({
        environmentId: sourceEnvironmentId,
        tool: "goat_thread_configure",
        writes: true,
        requireHostRoutable: true,
      });
      expect(f.hostCalls[0]?.arguments).toMatchObject({
        threadId: targetId,
        clientRequestId: "same",
      });
      expect(f.hostCalls[0]?.arguments).not.toHaveProperty("host");
      expect(f.counts()).toMatchObject({
        acceptedCommands: 1,
        catalogReads: 1,
        originAuthorizations: 1,
      });
      f.invalidateCatalog();
      const replay = yield* f.call("goat_thread_configure", {
        ...configure,
        clientRequestId: "same",
      });
      expect(replay.isError).toBe(false);
      expect(f.counts()).toMatchObject({
        acceptedCommands: 1,
        catalogReads: 1,
        originAuthorizations: 2,
      });
      const read = yield* f.call("goat_thread_configuration_read", { host, threadId: targetId });
      expect(declaredFailure(read)).toBeUndefined();
      expect(read.structuredContent).toMatchObject({ host, modelSelection: selection });
      expect(f.commands).toHaveLength(2);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(McpServer.McpServer.layer)),
);

it.effect("distinguishes origin and destination denial before configuration writes", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const origin = fixture(server);
    yield* Effect.gen(function* () {
      const result = yield* origin.call("goat_thread_configure", configure, planScope);
      expect(declaredFailure(result)?.code).toBe("interaction_mode_escalation_denied");
      expect(origin.counts().destinationCalls).toBe(0);
      expect(origin.commands).toHaveLength(0);
    }).pipe(Effect.provide(origin.layer));

    const destination = fixture(server, { destinationAccess: "read-only" });
    yield* Effect.gen(function* () {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = yield* destination.call("goat_thread_configure", {
          ...configure,
          clientRequestId: "denied",
        });
        expect(declaredFailure(result)?.code).toBe("capability_denied");
      }
      expect(destination.counts().originAuthorizations).toBe(2);
      expect(destination.commands).toHaveLength(0);
    }).pipe(Effect.provide(destination.layer));
  }).pipe(Effect.provide(McpServer.McpServer.layer)),
);

it.effect.each([
  { name: "unknown provider", value: { instanceId: "missing", model: "gpt-new" }, refresh: 0 },
  {
    name: "model missing after refresh",
    value: { instanceId: codex, model: "missing" },
    refresh: 1,
  },
  {
    name: "unknown option",
    value: { ...selection, options: [{ id: "unknown", value: true }] },
    refresh: 0,
  },
  {
    name: "wrong option value",
    value: { ...selection, options: [{ id: "effort", value: "max" }] },
    refresh: 0,
  },
  {
    name: "wrong option type",
    value: { ...selection, options: [{ id: "effort", value: true }] },
    refresh: 0,
  },
  {
    name: "duplicate option",
    value: {
      ...selection,
      options: [
        { id: "effort", value: "high" },
        { id: "effort", value: "low" },
      ],
    },
    refresh: 0,
  },
])("rejects $name on the destination without dispatching", (testCase) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const f = fixture(server);
    yield* Effect.gen(function* () {
      const result = yield* f.call("goat_thread_configure", {
        ...configure,
        modelSelection: testCase.value,
      });
      expect(declaredFailure(result)?.code).toBe("invalid_request");
      expect(f.counts().acceptedCommands).toBe(0);
      expect(f.counts().refreshCalls).toBe(testCase.refresh);
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(McpServer.McpServer.layer)),
);

it.effect("refreshes a model miss once and preserves empty-catalog custom models", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const refreshed = fixture(server, {
      initialProviders: [
        provider([
          { slug: "gpt-old", name: "Old", isCustom: false } as ServerProvider["models"][number],
        ]),
      ],
      refreshedProviders: [advertised],
    });
    yield* Effect.gen(function* () {
      const result = yield* refreshed.call("goat_thread_configure", configure);
      expect(result.isError).toBe(false);
      expect(refreshed.counts()).toMatchObject({ acceptedCommands: 1, refreshCalls: 1 });
    }).pipe(Effect.provide(refreshed.layer));

    const empty = fixture(server, { initialProviders: [provider([])] });
    yield* Effect.gen(function* () {
      const result = yield* empty.call("goat_thread_configure", configure);
      expect(result.isError).toBe(false);
      expect(empty.counts()).toMatchObject({ acceptedCommands: 1, refreshCalls: 0 });
    }).pipe(Effect.provide(empty.layer));
  }).pipe(Effect.provide(McpServer.McpServer.layer)),
);

it.effect("keeps rejected and cross-thread receipt failures without revalidating", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const rejected = fixture(server, { rejectFirstCommand: true });
    yield* Effect.gen(function* () {
      const first = yield* rejected.call("goat_thread_configure", {
        ...configure,
        clientRequestId: "rejected",
      });
      expect(first.isError).toBe(true);
      rejected.invalidateCatalog();
      const replay = yield* rejected.call("goat_thread_configure", {
        ...configure,
        clientRequestId: "rejected",
      });
      expect(replay.isError).toBe(true);
      expect(rejected.counts().catalogReads).toBe(1);
      expect(rejected.counts().acceptedCommands).toBe(0);
    }).pipe(Effect.provide(rejected.layer));

    const conflict = fixture(server);
    yield* Effect.gen(function* () {
      const first = yield* conflict.call("goat_thread_configure", {
        ...configure,
        clientRequestId: "shared",
      });
      expect(first.isError).toBe(false);
      conflict.invalidateCatalog();
      const other = yield* conflict.call("goat_thread_configure", {
        ...configure,
        threadId: otherTargetId,
        clientRequestId: "shared",
      });
      expect(other.isError).toBe(true);
      expect(conflict.counts().catalogReads).toBe(1);
      expect(conflict.counts().acceptedCommands).toBe(1);
    }).pipe(Effect.provide(conflict.layer));
  }).pipe(Effect.provide(McpServer.McpServer.layer)),
);

const listed = (withHost: boolean) => ({
  result: {
    tools: [
      {
        name: "goat_thread_configure",
        inputSchema: {
          type: "object",
          properties: {
            threadId: {},
            modelSelection: {},
            clientRequestId: {},
            ...(withHost ? { host: {} } : {}),
          },
        },
      },
    ],
  },
});

it.effect.each(["ssh", "linked"] as const)(
  "requires host-capable declarations on %s dispatch",
  (route) =>
    Effect.gen(function* () {
      const exercise = () =>
        Effect.gen(function* () {
          const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;
          return yield* dispatch.callHostTool(
            {
              host: route === "ssh" ? "build-box" : host,
              tool: "goat_thread_configure",
              arguments: { threadId: targetId, modelSelection: selection, clientRequestId: "key" },
              timeoutMs: 5_000,
              writes: true,
              requireHostRoutable: true,
            } as SshRemoteDispatch.SshHostToolCall,
            Effect.succeed("full-access" as const),
          );
        });
      const answer = (request: { readonly method: string }) => {
        if (request.method === "tools/list") return listed(true);
        return { result: { structuredContent: { sequence: 7 } } };
      };
      for (const catalog of ["missing-host", "missing-tool", "failure"] as const) {
        const responder = (request: { readonly method: string }) => {
          if (request.method !== "tools/list") return answer(request);
          if (catalog === "missing-host") return listed(false);
          if (catalog === "missing-tool") return { result: { tools: [] } };
          return { rpcError: "catalog unavailable" };
        };
        if (route === "ssh") {
          const { result, record } = yield* withRemote(
            { answer: (request) => initialize(request) ?? responder(request) },
            exercise(),
          );
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure")
            expect(result.failure.reason).toBe(
              catalog === "failure" ? "host_unavailable" : "remote_outdated",
            );
          expect(record.toolCalls).toEqual([]);
          continue;
        }
        const { result, record } = yield* withLinkedHost(responder, exercise());
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure")
          expect(result.failure.reason).toBe(
            catalog === "failure" ? "host_unavailable" : "remote_outdated",
          );
        expect(record.filter((entry) => entry.method === "tools/call")).toEqual([]);
      }
      if (route === "ssh") {
        const { result, record } = yield* withRemote(
          { answer: (request) => initialize(request) ?? answer(request) },
          exercise(),
        );
        expect(result._tag).toBe("Success");
        expect(record.toolCallArguments).toHaveLength(1);
        expect(record.toolCallArguments[0]?.arguments).not.toHaveProperty("host");
        return;
      }
      const { result, record } = yield* withLinkedHost(answer, exercise());
      expect(result._tag).toBe("Success");
      expect(record.filter((entry) => entry.method === "tools/call")).toHaveLength(1);
    }),
);
