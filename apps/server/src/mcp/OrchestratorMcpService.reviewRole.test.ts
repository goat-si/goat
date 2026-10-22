import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  OrchestrationV2DomainEventJson,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as RemoteDispatchCoordinator from "../remoteReports/RemoteDispatchCoordinator.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

const encodeDomainEvent = Schema.encodeEffect(OrchestrationV2DomainEventJson);
const decodeDomainEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const isJson = Schema.is(Schema.Json);

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const parentModel = {
  instanceId,
  model: "author-model",
  options: [{ id: "reasoning", value: "high" }],
};
const childModel = { instanceId, model: "reviewer-model" };
const parentId = ThreadId.make("review-metadata-parent");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("review-metadata"),
  requestNamespace: "review-metadata",
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
  client: undefined,
  thread: { threadId: parentId, providerInstanceId: instanceId, providerSessionId: "session" },
};
const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: () => Effect.die("Metadata tests never start providers"),
};
const databaseLayer = SqlitePersistence.layerMemory;
const layerTest = ProviderReplayHarness.layerWithRegistry(
  { name: "review-role-metadata" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer, runEffectWorker: false },
);

it.effect.each([false, true])(
  "review role and both model selections survive persisted event replay, remote=%s",
  (remote) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const persisted = yield* ProjectionStore.ProjectionStoreV2;
      const events: OrchestrationV2DomainEvent[] = [];
      const dispatch = (command: OrchestrationV2ServerCommand) =>
        orchestrator
          .dispatch(command)
          .pipe(
            Effect.tap((result) =>
              Effect.sync(() => events.push(...result.storedEvents.map((row) => row.event))),
            ),
          );
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make("review-parent-create"),
        threadId: parentId,
        projectId: ProjectId.make("review-project"),
        title: "Author",
        modelSelection: parentModel,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("review-parent-start"),
        threadId: parentId,
        messageId: MessageId.make("review-parent-prompt"),
        text: "Delegate a review",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const run = (yield* persisted.getThreadRecords(parentId, ["runs"])).runs[0]!;
      // Changing the composer after starting the run must not rewrite the author's model.
      yield* dispatch({
        type: "thread.model-selection.set",
        commandId: CommandId.make("change-composer"),
        threadId: parentId,
        modelSelection: { instanceId, model: "next-author-model" },
      });
      const common = {
        commandId: CommandId.make("review-delegate"),
        parentThreadId: parentId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        task: "Review the diff",
        role: "review" as const,
        modelSelection: childModel,
        // The orchestrator derives the authoritative snapshot from the parent run.
        parentModelSelection: { instanceId, model: "forged-model" },
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      yield* dispatch(
        remote
          ? {
              ...common,
              type: "delegated_task.remote.register",
              driver,
              remote: {
                host: "box",
                threadId: ThreadId.make("remote-review"),
                correlationId: "review-correlation",
              },
            }
          : { ...common, type: "delegated_task.request" },
      );
      const task = (yield* persisted.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
      assert.deepInclude(task, {
        role: "review",
        modelSelection: childModel,
        parentModelSelection: parentModel,
      });
      const replayed = yield* ProjectionStore.ProjectionStoreV2.pipe(
        Effect.provide(ProjectionStore.layerMemory),
      );
      for (const event of events) {
        const encoded = yield* encodeDomainEvent(event);
        yield* replayed.apply(yield* decodeDomainEvent(JSON.parse(JSON.stringify(encoded))));
      }
      const dependencies = Layer.mergeAll(
        NodeServices.layer,
        ServerSettings.layerTest(),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (id, fields, filter) =>
            replayed.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
          getThreadShell: (id) => replayed.getThreadShell(id).pipe(Effect.orDie),
          getProjectThreadRecords: (target, fields, filter) =>
            replayed.getThreadRecords(target.threadId, fields, filter).pipe(Effect.orDie),
          getTimelinePage: (id, options) =>
            replayed.getTimelinePage(id, options).pipe(Effect.orDie),
          delegatedTaskResultPending: () => Effect.succeed(false),
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
        const status = yield* service.taskStatus(scope, task.id);
        assert.deepInclude(status, {
          role: "review",
          modelSelection: childModel,
          parentModelSelection: parentModel,
        });
        assert.isTrue(isJson(status));
        const read = yield* service.readThread(scope, { threadId: parentId, view: "activity" });
        const item = read.items.find((item) => item.subagentId === task.id);
        assert.deepInclude(item, {
          role: "review",
          modelSelection: childModel,
          parentModelSelection: parentModel,
        });
      }).pipe(
        Effect.provide(
          OrchestratorMcpService.layer.pipe(
            Layer.provide(layerNoFleetSync),
            Layer.provide(dependencies),
          ),
        ),
      );
    }).pipe(Effect.provide(layerTest)),
);
