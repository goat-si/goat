import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const parentThreadId = ThreadId.make("thread:mcp-retry-command-parent");
const childThreadId = ThreadId.make("thread:mcp-retry-command-child");
const failedRunId = RunId.make("run:mcp-retry-command");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-retry-command"),
  requestNamespace: "provider-session:mcp-retry-command",
  thread: {
    threadId: parentThreadId,
    providerSessionId: "provider-session:mcp-retry-command",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const thread = (id: ThreadId) => ({
  id,
  projectId: ProjectId.make("project:mcp-retry-command"),
  runtimeMode: "full-access",
  interactionMode: "default",
  archivedAt: null,
});

/** A child whose first run failed while preparing its workspace, holding one queued message. */
const retryWith = (message: { readonly createdBy: "user" | "agent"; readonly text: string }) =>
  Effect.gen(function* () {
    const parent = {
      thread: thread(parentThreadId),
      runs: [
        {
          id: RunId.make("run:mcp-retry-command-live"),
          status: "running",
          ordinal: 1,
          providerInstanceId: scope.thread?.providerInstanceId,
        },
      ],
      subagents: [
        {
          id: NodeId.make("node:mcp-retry-command"),
          threadId: parentThreadId,
          origin: "app_owned",
          childThreadId,
        },
      ],
      providerThreads: [],
      messages: [],
      contextTransfers: [],
      turnItems: [],
      runtimeRequests: [],
    } as unknown as OrchestrationV2ThreadProjection;
    const child = {
      ...parent,
      thread: thread(childThreadId),
      subagents: [],
      runs: [
        {
          id: failedRunId,
          status: "failed",
          ordinal: 1,
          userMessageId: "message:mcp-retry-command",
          workspacePreparation: { type: "worktree", baseRef: "dev" },
        },
      ],
      messages: [{ id: "message:mcp-retry-command", ...message }],
    } as unknown as OrchestrationV2ThreadProjection;
    const retries: Array<unknown> = [];
    const records = (threadId: ThreadId) =>
      Effect.succeed(threadId === childThreadId ? child : parent);
    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provide(layerNoFleetSync),
      Layer.provide(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          retryPreparation: (input) => Effect.sync(() => retries.push(input) as never),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({})),
      Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: records,
            getProjectThreadRecords: (input) => records(input.threadId),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );
    const result = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.flatMap((service) => service.retryThread(scope, { threadId: childThreadId })),
      Effect.result,
      Effect.provide(layer),
    );
    return { result, retries };
  });

it.effect("an agent cannot run a person's failed slash command again", () =>
  Effect.gen(function* () {
    // A retry would start the person's /logout at a moment the agent chose.
    const { result, retries } = yield* retryWith({ createdBy: "user", text: "/logout" });
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") assert.equal(result.failure.code, "capability_denied");
    assert.lengthOf(retries, 0);
  }),
);

it.effect("an agent can retry a person's ordinary message or its own command", () =>
  Effect.gen(function* () {
    for (const message of [
      { createdBy: "user", text: "fix the build" },
      { createdBy: "agent", text: "/compact" },
    ] as const) {
      const { result, retries } = yield* retryWith(message);
      assert.equal(result._tag, "Success");
      assert.lengthOf(retries, 1);
    }
  }),
);
