import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../project/ProjectService.ts";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as RemoteDispatch from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as GitVcs from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const projectId = ProjectId.make("schedule-reconcile-project");
const caller: McpInvocationScope = {
  environmentId: EnvironmentId.make("schedule-reconcile-environment"),
  requestNamespace: "schedule-reconcile-client",
  thread: undefined,
  client: { sessionId: "schedule-reconcile", label: "test", access: "full-access" },
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};
const disabledTask: ScheduledTask = {
  id: ScheduledTaskId.make("manual-schedule"),
  projectId,
  threadId: null,
  title: "Manual work",
  prompt: "Run work",
  enabled: false,
  schedule: { type: "interval", everyMs: 60_000 },
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "agent",
  creationSource: "mcp",
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: "2026-10-24T01:00:00.000Z",
  lastRunStatus: "succeeded",
  lastRunError: null,
  runCount: 2,
};

it.effect("schedule.list distinguishes another successful manual run of a disabled task", () =>
  Effect.gen(function* () {
    const stored = yield* Ref.make(disabledTask);
    const service = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.provide(
        OrchestratorMcpService.layer.pipe(
          Layer.provide(layerNoFleetSync),
          Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
          Layer.provide(Layer.mock(GitVcs.GitVcsDriver)({})),
          Layer.provide(Layer.mock(RemoteDispatch.RemoteDispatchCoordinator)({})),
          Layer.provide(Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({})),
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              ServerSettings.layerTest(),
              Layer.mock(Threads.ThreadManagementService)({}),
              Layer.mock(Projects.ProjectService)({}),
              Layer.mock(Providers.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
              Layer.mock(ProviderAdapters.ProviderAdapterRegistryV2)({
                list: () => Effect.succeed([]),
              }),
              Layer.mock(SecretRequests.SecretRequests)({}),
              Layer.mock(ScheduledTasks.ScheduledTaskService)({
                list: () => Ref.get(stored).pipe(Effect.map((task) => ({ tasks: [task] }))),
              }),
            ),
          ),
        ),
      ),
    );
    const before = yield* service.listScheduledTasks(caller, { projectId });
    expect(before.tasks[0]).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastRunStatus: "succeeded",
      runCount: 2,
      lastRunAt: "2026-10-24T01:00:00.000Z",
    });
    yield* Ref.update(stored, (task) => ({
      ...task,
      runCount: 3,
      lastRunAt: "2026-10-24T02:00:00.000Z",
    }));
    const after = yield* service.listScheduledTasks(caller, { projectId });
    expect(after.tasks[0]).toMatchObject({
      enabled: false,
      nextRunAt: null,
      lastRunStatus: "succeeded",
      runCount: 3,
      lastRunAt: "2026-10-24T02:00:00.000Z",
    });
  }),
);
