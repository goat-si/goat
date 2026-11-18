import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  TurnItemId,
  ProjectId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import {
  layerPlatformTest,
  layerServerConfig,
  modelSelection,
  layerCheckpointStoreTest,
  layerGitWorkflowTest,
  layerProjectServiceTest,
  layerTestProviderInstanceRegistry,
} from "./runtimeLayer.testkit.ts";
import { createAttachmentId } from "../attachmentStore.ts";

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

const writeHtmlRenderRun = Effect.fn("test.writeHtmlRenderRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly ordinal: number;
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`html-fork-run:${input.key}`);
  const messageId = MessageId.make(`html-fork-message:${input.key}`);
  const attachmentId = createAttachmentId(input.threadId, "html")!;
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`html-fork-run:${input.key}`),
        type: "run.created",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: input.threadId,
          ordinal: input.ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: messageId,
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make(`html-fork-message:${input.key}`),
        type: "message.updated",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId: input.threadId,
          runId,
          nodeId: null,
          role: "user",
          text: "Publish a page",
          attachments: [],
          streaming: false,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
        },
      },
      {
        id: EventId.make(`html-fork-item:${input.key}`),
        type: "turn-item.updated",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`html-fork-item:${input.key}`),
          type: "dynamic_tool",
          threadId: input.threadId,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          toolName: "mcp__t3-code__html_render",
          input: {},
          output: [
            {
              type: "text",
              text: JSON.stringify({ htmlRender: { attachmentId, title: "Page", height: 300 } }),
            },
          ],
        },
      },
    ],
  });
  return { runId, attachmentId };
});

it.layer(layerTest)("OrchestrationV2LayerLive fork deletion", (it) => {
  it.effect("deleting a source keeps the html_render page its live fork shows", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sourceThreadId = ThreadId.make("html-fork-source");
      const forkThreadId = ThreadId.make("html-fork-target");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("html-fork-create"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("html-fork-project"),
        title: "Page source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const inherited = yield* writeHtmlRenderRun({
        threadId: sourceThreadId,
        key: "inherited",
        ordinal: 1,
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("html-fork-fork"),
        sourceThreadId,
        targetThreadId: forkThreadId,
        sourcePoint: { type: "run", runId: inherited.runId },
        createdBy: "user",
        creationSource: "web",
      });
      const later = yield* writeHtmlRenderRun({
        threadId: sourceThreadId,
        key: "later",
        ordinal: 2,
      });
      const deleteCommandId = CommandId.make("html-fork-delete-source");
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: deleteCommandId,
        threadId: sourceThreadId,
      });
      const cleaned = (yield* outbox.listByCommandId(deleteCommandId)).flatMap((effect) =>
        effect.request.type === "attachment.cleanup" ? effect.request.attachmentIds : [],
      );
      assert.include(cleaned, later.attachmentId);
      assert.notInclude(
        cleaned,
        inherited.attachmentId,
        "deleted a page its live fork still shows",
      );
    }),
  );
});
