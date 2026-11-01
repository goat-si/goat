import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@goat/contracts";
import { requestedTurnCapabilities } from "@goat/shared/turnCapabilities";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
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

const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("capability-send-target");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("capability-send"),
  requestNamespace: "capability-send",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: undefined,
  thread: { threadId, providerInstanceId: instanceId, providerSessionId: "session" },
};
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Send tests never start providers"),
};
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "capability-send" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);

it.effect("goat_thread_send capabilities reach the thread as the chips a person would add", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const persisted = yield* ProjectionStore.ProjectionStoreV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("capability-send-create"),
      threadId,
      projectId: ProjectId.make("capability-project"),
      title: "Target",
      modelSelection: { instanceId, model: "test" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const sent: ThreadManagementService.ThreadManagementSendInput[] = [];
    const dependencies = Layer.mergeAll(
      NodeServices.layer,
      ServerSettings.layerTest(),
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (id, fields, filter) =>
          persisted.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
        getThreadShell: (id) => persisted.getThreadShell(id).pipe(Effect.orDie),
        getProjectThreadRecords: (target, fields, filter) =>
          persisted.getThreadRecords(target.threadId, fields, filter).pipe(Effect.orDie),
        sendToThread: (input) =>
          Effect.sync(() => sent.push(input)).pipe(
            Effect.andThen(
              Effect.fail(
                new ThreadManagementService.ThreadManagementThreadArchivedError({ threadId }),
              ),
            ),
          ),
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      Layer.mock(RemoteDispatchCoordinator.RemoteDispatchCoordinator)({
        get: () => Effect.succeed(null),
      }),
      Layer.mock(SshRemoteDispatch.SshRemoteDispatch)({ callHostTool: () => Effect.succeed({}) }),
    );
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      yield* service
        .sendToThread(scope, { threadId, message: "Check the page", capabilities: ["browser"] })
        .pipe(Effect.ignore);
      yield* service.sendToThread(scope, { threadId, message: "Plain" }).pipe(Effect.ignore);
    }).pipe(
      Effect.provide(
        OrchestratorMcpService.layer.pipe(
          Layer.provide(layerNoFleetSync),
          Layer.provide(dependencies),
        ),
      ),
    );
    const [withChip, plain] = sent;
    assert.deepEqual(
      requestedTurnCapabilities({
        text: withChip!.text,
        records: withChip!.context?.records ?? [],
      }),
      ["browser"],
    );
    assert.include(withChip!.text, "Check the page");
    assert.deepEqual(plain && { text: plain.text, context: plain.context }, {
      text: "Plain",
      context: undefined,
    });
  }).pipe(Effect.provide(layerTest)),
);
