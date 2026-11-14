import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  type ModelSelection,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  driver,
  layerPlatformTest,
  layerServerConfig,
  modelSelection,
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerProjectServiceTest,
  layerTestProviderInstanceRegistry,
} from "./runtimeLayer.testkit.ts";

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ProjectStore.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ThreadCommandExecutor.layer,
).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStoreTest),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(layerTestProviderInstanceRegistry),
  Layer.provide(layerGitWorkflowTest),
  Layer.provide(layerProjectServiceTest),
  Layer.provide(layerPlatformTest),
);
const seedProject = (input: {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly defaultModelSelection: ModelSelection | null;
  readonly createdAt: string;
}) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`seed:${input.projectId}`),
      aggregateKind: "project",
      aggregateId: input.projectId,
      occurredAt: input.createdAt,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        defaultModelSelection: input.defaultModelSelection,
        scripts: [],
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      },
    }),
  );

it.layer(layerTest)("archive delegated work", (it) => {
  it.effect("rejects archiving an idle parent until its delegated child completes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("archive-delegated-parent");
      const projectId = ProjectId.make("archive-delegated-project");
      yield* seedProject({
        projectId,
        title: "Delegated archive",
        workspaceRoot: "/workspace/archive-delegated",
        defaultModelSelection: null,
        createdAt: "2026-09-07T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-delegated-create"),
        threadId,
        projectId,
        title: "Delegated archive",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-delegated-message"),
        threadId,
        messageId: MessageId.make("archive-delegated-message"),
        text: "Delegate the work, then finish your turn.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const parentRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "mcp",
        commandId: CommandId.make("archive-delegated-request"),
        parentThreadId: threadId,
        parentRunId: parentRun.id,
        parentNodeId: parentRun.rootNodeId!,
        task: "Keep working after the parent finishes.",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
      });
      const delegatedParentRun = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("archive-delegated-parent-completed"),
            type: "run.updated",
            threadId,
            runId: parentRun.id,
            occurredAt: now,
            payload: { ...delegatedParentRun, status: "completed", completedAt: now },
          },
        ],
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const task = parent.subagents[0]!;
      assert.equal(parent.runs[0]?.status, "completed");
      assert.equal(task.origin, "app_owned");
      assert.equal(task.status, "running");
      assert.isNotNull(task.childThreadId);

      // Archive must preserve the idle parent's path for receiving this child's result.
      const error = yield* orchestrator
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make("archive-delegated-blocked"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
      assert.equal(
        error.cause,
        `Thread ${threadId} has running delegated tasks. Wait for them or cancel them before archiving.`,
      );
      assert.isNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);

      const childThreadId = task.childThreadId!;
      const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("archive-delegated-child-run-completed"),
            type: "run.updated",
            threadId: childThreadId,
            runId: childRun.id,
            occurredAt: now,
            payload: { ...childRun, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("archive-delegated-child-completed"),
            type: "subagent.updated",
            threadId,
            nodeId: task.id,
            occurredAt: now,
            payload: { ...task, status: "completed", result: "Done", completedAt: now },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-delegated-allowed"),
        threadId,
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);
    }),
  );
  it.effect("permits archiving a parent with only a remote delegated task", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projectId = ProjectId.make("archive-remote-project");
      const threadId = ThreadId.make("archive-remote-parent");
      yield* seedProject({
        projectId,
        title: "Remote",
        workspaceRoot: "/workspace/remote",
        defaultModelSelection: null,
        createdAt: "2026-09-07T00:00:00.000Z",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-remote-create"),
        threadId,
        projectId,
        title: "Remote",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("archive-remote-message"),
        threadId,
        messageId: MessageId.make("archive-remote-message"),
        text: "Delegate remotely",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.register",
        commandId: CommandId.make("archive-remote-register"),
        parentThreadId: threadId,
        parentRunId: run.id,
        parentNodeId: run.rootNodeId!,
        createdBy: "agent",
        creationSource: "mcp",
        task: "Remote work",
        modelSelection,
        driver,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "settled_only",
        remote: { host: "build-box", threadId: null, correlationId: "archive-remote" },
      });
      const current = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("archive-remote-finished"),
            type: "run.updated",
            threadId,
            runId: current.id,
            occurredAt: now,
            payload: { ...current, status: "completed", completedAt: now },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive-remote-allowed"),
        threadId,
      });
      assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);
    }),
  );
});
