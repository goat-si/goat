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
const threadId = ThreadId.make("remote-sender-target");
const environmentId = EnvironmentId.make("remote-sender-here");
const outside: McpInvocationScope = {
  environmentId,
  requestNamespace: "remote-sender",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: { sessionId: "link", label: "GOAT on mac-studio", access: "full-access" },
  thread: undefined,
};
const fromThread: McpInvocationScope = {
  ...outside,
  client: undefined,
  thread: { threadId, providerInstanceId: instanceId, providerSessionId: "session" },
};
const remoteSender = {
  environmentId: EnvironmentId.make("mac-studio"),
  environmentLabel: "mac-studio",
  threadId: ThreadId.make("coordinator"),
  title: "Coordinator",
};
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Send tests never start providers"),
};
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "remote-sender" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);

it.effect(
  "a send from another machine keeps its descriptive sender, and only an outside caller naming another environment may give one",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const persisted = yield* ProjectionStore.ProjectionStoreV2;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("remote-sender-create"),
        threadId,
        projectId: ProjectId.make("remote-sender-project"),
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
          .sendToThread(outside, {
            threadId,
            message: "Check the page",
            capabilities: ["browser"],
            remoteSender,
          })
          .pipe(Effect.ignore);
        const refusals = yield* Effect.all([
          service
            .sendToThread(fromThread, { threadId, message: "Claimed", remoteSender })
            .pipe(Effect.flip),
          service
            .sendToThread(outside, {
              threadId,
              message: "Here",
              remoteSender: { ...remoteSender, environmentId },
            })
            .pipe(Effect.flip),
        ]);
        assert.deepEqual(
          refusals.map((refusal) => refusal.code),
          ["invalid_request", "invalid_request"],
        );
      }).pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(layerNoFleetSync),
            Layer.provide(dependencies),
          ),
        ),
      );
      // Only the accepted send reached the thread; the refused ones sent nothing.
      assert.equal(sent.length, 1);
      const [received] = sent;
      assert.deepEqual(received!.context?.remoteSender, remoteSender);
      // The capability chip the same send asked for survives beside it.
      assert.deepEqual(
        requestedTurnCapabilities({
          text: received!.text,
          records: received!.context?.records ?? [],
        }),
        ["browser"],
      );
      // A label only: steering and permissions still see no sending thread.
      assert.isUndefined(received!.senderThreadId);
    }).pipe(Effect.provide(layerTest)),
);
