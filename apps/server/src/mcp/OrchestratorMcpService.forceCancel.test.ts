import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CommandId, EnvironmentId, ProviderInstanceId, type ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import {
  interruptResult,
  parentWithTask,
  runStatuses,
  updateChildProviderThread,
} from "../orchestration-v2/delegatedForceStop.testkit.ts";
import { layerTest } from "../orchestration-v2/ThreadStop.testkit.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { layerTestThreadLaunch } from "./OrchestratorMcpService.testkit.ts";

const scopeOf = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("force-cancel"),
  requestNamespace: "force-cancel",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: undefined,
  thread: {
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "force-cancel-session",
  },
});

/** The MCP service over the real ThreadManagementService; nothing here reaches another host. */
const withService = <A, E, R>(
  body: (
    service: OrchestratorMcpService.OrchestratorMcpService["Service"],
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const layer = OrchestratorMcpService.layer.pipe(
      Layer.provide(layerNoFleetSync),
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          ServerSettings.layerTest(),
          Layer.succeed(ThreadManagementService.ThreadManagementService, threads),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
          layerTestThreadLaunch(),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
            get: () => Effect.succeed(null),
          }),
          Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({
            callHostTool: () => Effect.die("A local task never calls a host"),
          }),
        ),
      ),
    );
    return yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
      Effect.flatMap(body),
      Effect.provide(layer),
    );
  });

it.effect("task.cancel with force: true ends a child whose Stop went unanswered", () =>
  Effect.gen(function* () {
    const task = yield* parentWithTask("mcp-force-ok", "unanswered");
    const result = yield* withService((service) =>
      service.cancelTask(scopeOf(task.parentThreadId), { taskId: task.taskId, force: true }),
    );
    assert.equal(result.taskId, task.taskId);
    assert.equal(result.forceStop?.outcome, "released");
    assert.match(result.forceStop?.note ?? "", /work may be incomplete/u);
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["interrupted"]);
    assert.match(
      (yield* interruptResult(task.childThreadId)) ?? "",
      /^Force stopped by parent thread/u,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  { name: "before Stop went unanswered", stop: "requested" as const, cloud: false },
  { name: "of a cloud child", stop: "unanswered" as const, cloud: true },
])("task.cancel with force: true $name answers task_not_cancellable and stops nothing", (row) =>
  Effect.gen(function* () {
    const task = yield* parentWithTask(`mcp-force-${row.stop}-${row.cloud}`, row.stop);
    if (row.cloud)
      yield* updateChildProviderThread(task.childThreadId, (thread, now) => ({
        ...thread,
        cloudTask: {
          taskId: "cloud-task-mcp",
          status: "running",
          tracking: "polled",
          source: { repository: "goat-si/goat", branch: "dev" },
          localChangesExcluded: false,
          updatedAt: DateTime.formatIso(now),
        },
      }));
    const error = yield* withService((service) =>
      service.cancelTask(scopeOf(task.parentThreadId), { taskId: task.taskId, force: true }),
    ).pipe(Effect.flip);
    assert.equal(error.code, "task_not_cancellable");
    assert.match(error.message, row.cloud ? /^cloud: /u : /^not_unresponsive: /u);
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("task.cancel with force: true above the parent's mode is refused for a person", () =>
  Effect.gen(function* () {
    const task = yield* parentWithTask("mcp-force-mode", "unanswered");
    // A person lowered the parent below the child it started.
    yield* (yield* Orchestrator.OrchestratorV2).dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("mcp-force-mode:lower"),
      threadId: task.parentThreadId,
      runtimeMode: "approval-required",
    });
    const error = yield* withService((service) =>
      service.cancelTask(scopeOf(task.parentThreadId), { taskId: task.taskId, force: true }),
    ).pipe(Effect.flip);
    assert.equal(error.code, "task_not_cancellable");
    assert.match(error.message, /^mode: Force stop was refused: .+ A person must use Force stop/u);
    assert.deepEqual(yield* runStatuses(task.childThreadId), ["running"]);
  }).pipe(Effect.provide(layerTest)),
);
