import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as SqlClient from "effect/sql/SqlClient";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/**
 * delegate_task with target.host resolves the model against the remote machine's
 * orchestrator_capabilities. The untargeted listing is truncated, so a valid model can be
 * missing from it; these scenarios cover the targeted re-check that settles the question.
 */

const parentThreadId = ThreadId.make("thread:mcp-remote-model-parent");
const parentRunId = RunId.make("run:mcp-remote-model-parent");
const parentNodeId = NodeId.make("node:mcp-remote-model-root");
const projectId = ProjectId.make("project:mcp-remote-model");
const codexInstanceId = ProviderInstanceId.make("codex");
const clientRequestId = "remote-model-test";
const correlationId = "corr-remote-model";

const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-remote-model"),
  requestNamespace: "provider-session:mcp-remote-model",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:mcp-remote-model",
    providerInstanceId: codexInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

// stableCommandId in the service derives the task id from the scope and request key.
const commandId = CommandId.make(
  [
    "command",
    "mcp",
    encodeURIComponent(scope.requestNamespace),
    "delegate-task",
    encodeURIComponent(clientRequestId),
  ].join(":"),
);
const taskId = derive.delegatedTaskNode({ commandId });

const FEATURES = {
  appOwnedSubagents: true,
  asyncPolling: true,
  cancellation: true,
  batchThreadCreation: true,
  threadManagement: true,
  incrementalThreadRead: true,
  scheduledTasks: true,
  maxBatchThreads: 20,
};

type RemoteModelRow = {
  readonly id: string;
  readonly label?: null;
  readonly options?: ReadonlyArray<{
    readonly id: string;
    readonly values: ReadonlyArray<string>;
    readonly default?: string;
  }>;
};

type RemoteCatalogProviders = ReadonlyArray<{
  readonly instanceId: string;
  readonly models: ReadonlyArray<RemoteModelRow>;
}>;

const remoteCatalog = (providers: RemoteCatalogProviders) => ({
  parentThreadId: null,
  inheritedProviderInstanceId: codexInstanceId,
  inheritedModel: "gpt-5.4",
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: providers.map((provider) => ({
    providerInstanceId: provider.instanceId,
    driverKind: "codex",
    displayName: null,
    models: provider.models,
    canRunChildTask: true,
    canRunCrossProviderChildTask: true,
    constraints: [],
  })),
  features: FEATURES,
});

const UNTARGETED = remoteCatalog([
  { instanceId: codexInstanceId, models: [{ id: "gpt-6-luna", label: null }] },
]);

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(layerNoFleetSync),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

/**
 * Runs delegate_task against a fake remote whose untargeted capabilities omit the requested
 * model; "targeted" is what a capabilities call carrying { search: model } returns, or the
 * transport failure it hits.
 */
const delegateWithRemote = (
  targeted: { readonly catalogs: RemoteCatalogProviders } | { readonly fails: true },
  options?: ReadonlyArray<{ readonly id: string; readonly value: string }>,
) =>
  Effect.gen(function* () {
    const commands: OrchestrationV2ServerCommand[] = [];
    const launchInputs: Array<RemoteDispatchCoordinator.RemoteLaunchInput> = [];
    const capabilitiesCalls: Array<Readonly<Record<string, unknown>>> = [];
    const subagents: Array<OrchestrationV2ThreadProjection["subagents"][number]> = [];
    const parentProjection = (): OrchestrationV2ThreadProjection =>
      ({
        thread: {
          id: parentThreadId,
          projectId,
          title: "MCP parent",
          createdBy: "user",
          creationSource: "web",
          modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        },
        runs: [
          {
            id: parentRunId,
            ordinal: 1,
            status: "running",
            rootNodeId: parentNodeId,
            providerInstanceId: codexInstanceId,
            modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
          },
        ],
        contextTransfers: [],
        subagents,
      }) as unknown as OrchestrationV2ThreadProjection;
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      ServerSettings.layerTest(),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () =>
          Effect.succeed(liveThreadShell(parentThreadId, { activeRunId: parentRunId })),
        hasReceipt: () => Effect.succeed(false),
        assertProviderInstanceEnabled: () => Effect.void,
        isProviderInstanceEnabledForProject: () => Effect.succeed(true),
        getThreadRecords: () => Effect.succeed(parentProjection()),
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            if (command.type !== "delegated_task.remote.register")
              throw new Error("Unexpected command " + command.type);
            subagents.push({
              id: taskId,
              threadId: parentThreadId,
              runId: parentRunId,
              origin: "app_owned",
              childThreadId: null,
              status: "running",
              providerInstanceId: codexInstanceId,
              model: command.modelSelection.model,
              modelSelection: command.modelSelection,
              result: null,
              remote: { host: "box", threadId: null, correlationId },
              completionDelivery: { state: "pending" },
            } as unknown as OrchestrationV2ThreadProjection["subagents"][number]);
            return { sequence: 1, storedEvents: [] } as never;
          }),
      }),
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        get: () => Effect.succeed(null),
        launch: (input, register) =>
          register.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                launchInputs.push(input);
              }),
            ),
            Effect.as({
              correlationId,
              launch: {
                host: "box",
                cwd: "/repo",
                projectId: "remote-project:goat",
                projectCreated: false,
                threadId: "remote-thread:1",
                reportsSupported: true,
                runId: "remote-thread:1:run:1",
                workspaceStrategy: { type: "cwd" },
                runtimeMode: "full-access",
                remoteServerKind: "managed",
                notes: [],
              } as never,
              reportsSupported: true,
            }),
          ),
        listForOrigin: () =>
          Effect.succeed([
            {
              memoryGrantCeiling: "none",
              correlationId,
              kind: "task",
              originThreadId: parentThreadId,
              host: "box",
              remoteThreadId: null,
              launchedRunId: null,
              delivery: "wake",
              reportsSupported: true,
              state: "launching",
              reportCursor: 0,
              knownRunId: null,
              knownRunStatus: null,
              latestKind: null,
              latestSummary: null,
              latestAt: null,
              cancelRequestedAt: null,
              cancelCeiling: null,
              task: { taskId, parentRunId },
              pendingRequestIds: [],
              observation: null,
              lastError: null,
              createdAt: "2026-10-23T00:00:00.000Z",
              updatedAt: "2026-10-23T00:00:00.000Z",
            } satisfies RemoteDispatchCoordinator.RemoteDispatchRecord,
          ]),
      }),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
        callHostTool: (call, authorize) =>
          authorize.pipe(
            Effect.andThen(() => {
              if (call.tool !== "orchestrator_capabilities") throw new Error(call.tool);
              capabilitiesCalls.push(call.arguments);
              if (call.arguments["search"] === undefined) return Effect.succeed(UNTARGETED);
              if ("fails" in targeted)
                return Effect.fail(
                  new SshRemoteDispatch.SshRemoteDispatchError({
                    reason: "host_unavailable",
                    message: "dropped",
                  }),
                );
              return Effect.succeed(remoteCatalog(targeted.catalogs));
            }),
          ),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    );
    const result = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
        VALUES (${parentThreadId}, ${projectId}, 'Caller', 'codex', 'full-access', 'default', '2026-10-23', '2026-10-23', '{}')`;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service
        .delegateTask(scope, {
          task: "Build it",
          mode: "async",
          clientRequestId,
          target: {
            host: "box",
            providerInstanceId: codexInstanceId,
            model: "gpt-6-astra",
            ...(options === undefined ? {} : { options }),
          },
          remote: { cwd: "/repo" },
        })
        .pipe(Effect.result);
    }).pipe(
      Effect.provide(
        layerOrchestratorService.pipe(
          Layer.provide(dependencies),
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    );
    return { result, commands, launchInputs, capabilitiesCalls };
  });

describe("remote delegate_task model resolution", () => {
  it.effect("confirms an omitted model with a targeted capabilities refresh", () =>
    Effect.gen(function* () {
      const { result, commands, launchInputs, capabilitiesCalls } = yield* delegateWithRemote({
        catalogs: [
          {
            instanceId: codexInstanceId,
            models: [{ id: "gpt-6-astra", label: null }],
          },
        ],
      });
      assert.equal(result._tag, "Success");
      const register = commands.find(
        (command) => command.type === "delegated_task.remote.register",
      );
      assert.equal(
        register && "modelSelection" in register ? register.modelSelection.model : undefined,
        "gpt-6-astra",
      );
      assert.equal(launchInputs[0]?.launch.modelSelection?.model, "gpt-6-astra");
      assert.deepEqual(capabilitiesCalls, [{}, { search: "gpt-6-astra" }]);
    }),
  );

  it.effect("stays unavailable when the targeted refresh does not list the model", () =>
    Effect.gen(function* () {
      const { result, capabilitiesCalls } = yield* delegateWithRemote({
        catalogs: [{ instanceId: codexInstanceId, models: [{ id: "gpt-6-luna", label: null }] }],
      });
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.code, "model_unavailable");
      assert.deepEqual(capabilitiesCalls, [{}, { search: "gpt-6-astra" }]);
    }),
  );

  it.effect("does not take another account's model as the selected one", () =>
    Effect.gen(function* () {
      const { result } = yield* delegateWithRemote({
        catalogs: [
          {
            instanceId: ProviderInstanceId.make("antigravity"),
            models: [{ id: "gpt-6-astra", label: null }],
          },
        ],
      });
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.code, "model_unavailable");
    }),
  );

  it.effect("treats a failed targeted refresh as unavailable", () =>
    Effect.gen(function* () {
      const { result } = yield* delegateWithRemote({ fails: true });
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.code, "model_unavailable");
    }),
  );

  it.effect("validates options against the descriptors the refresh carried", () =>
    Effect.gen(function* () {
      const { result } = yield* delegateWithRemote(
        {
          catalogs: [
            {
              instanceId: codexInstanceId,
              models: [
                {
                  id: "gpt-6-astra",
                  label: null,
                  options: [{ id: "effort", values: ["low", "high"], default: "high" }],
                },
              ],
            },
          ],
        },
        [{ id: "effort", value: "ludicrous" }],
      );
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.code, "invalid_request");
    }),
  );
});
