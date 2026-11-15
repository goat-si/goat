import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as McpProviderSessions from "@goat/provider-core/server/McpProviderSessions";
import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderTurnId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
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
import * as FileSystem from "effect/FileSystem";

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

it.layer(layerTest)("OrchestrationV2LayerLive rewind", (it) => {
  it.effect("captures and repeatedly rewinds non-Git conversations without losing run links", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "goat-non-git-rewind-" });
      const threadId = ThreadId.make("runtime-non-git-rewind");
      const rollbackThread = vi.fn(
        ({ providerThread }: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) =>
          Effect.succeed({
            providerThread: {
              ...providerThread,
              nativeThreadRef: {
                driver,
                nativeId: "rewound-native-thread",
                strength: "strong" as const,
              },
            },
          }),
      );
      const sessionSpy = vi.spyOn(sessions, "open").mockReturnValue(
        Effect.succeed({
          rollbackThread,
        } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => sessionSpy.mockRestore()));
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("non-git-create"),
        createdBy: "user",
        creationSource: "web",
        threadId,
        projectId: ProjectId.make("non-git-project"),
        title: "Non-Git rewind",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });

      const completeMessage = (name: string) =>
        Effect.gen(function* () {
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(name),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(name),
            text: name,
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.find((candidate) => candidate.userMessageId === name)!;
          const node = projection.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
          const providerThread = projection.providerThreads.find(
            (candidate) => candidate.id === run.providerThreadId,
          )!;
          const now = yield* DateTime.now;
          const commandId = CommandId.make(`${name}-complete`);
          // The provider completion is the fixture boundary; capture and rollback use real effects.
          yield* outbox.cancelUnsettled({
            threadId,
            effectTypes: ["provider-turn.start"],
            reason: "provider completion supplied by fixture",
          });
          yield* eventSink.writeWithEffects({
            commandId,
            events: [
              {
                id: EventId.make(`${name}-run`),
                type: "run.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "waiting", startedAt: now },
              },
              {
                id: EventId.make(`${name}-node`),
                type: "node.updated",
                threadId,
                runId: run.id,
                nodeId: node.id,
                occurredAt: now,
                payload: { ...node, status: "completed", completedAt: now },
              },
              {
                id: EventId.make(`${name}-turn`),
                type: "provider-turn.updated",
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make(`${name}-turn`),
                  providerThreadId: providerThread.id,
                  nodeId: node.id,
                  runAttemptId: run.activeAttemptId,
                  nativeTurnRef: null,
                  ordinal: run.ordinal,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
            effects: [
              {
                id: `${name}-capture`,
                commandId,
                threadId,
                request: {
                  type: "checkpoint.capture",
                  runId: run.id,
                  scopeId: node.checkpointScopeId!,
                },
              },
            ],
          });
          yield* worker.drain();
          const captured = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            captured.runs.find((candidate) => candidate.id === run.id)?.status,
            "completed",
          );
          const checkpoint = captured.checkpoints.find((candidate) => candidate.runId === run.id)!;
          assert.equal(checkpoint.status, "missing");
          return { run, checkpoint };
        });

      const first = yield* completeMessage("non-git-first");
      const second = yield* completeMessage("non-git-second");
      const before = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        before.checkpoints.find((checkpoint) => checkpoint.id === first.checkpoint.id)?.runId,
        first.run.id,
        "capturing a later run must preserve the earlier checkpoint's run link",
      );
      const baseline = before.checkpoints.find(
        (checkpoint) => checkpoint.ordinalWithinScope === 0,
      )!;
      assert.equal(baseline.status, "missing");
      for (const checkpoint of [baseline, first.checkpoint]) {
        for (const restoreFiles of [undefined, true]) {
          const commandId = CommandId.make(`non-git-files-${checkpoint.id}-${restoreFiles}`);
          yield* orchestrator
            .dispatch({
              type: "checkpoint.rollback",
              commandId,
              threadId,
              checkpointId: checkpoint.id,
              scopeId: checkpoint.scopeId,
              ...(restoreFiles === undefined ? {} : { restoreFiles }),
            })
            .pipe(Effect.flip);
          assert.deepEqual(yield* outbox.listByCommandId(commandId), []);
        }
      }
      assert.equal(rollbackThread.mock.calls.length, 0);

      const rewind = (name: string) =>
        Effect.gen(function* () {
          const commandId = CommandId.make(name);
          yield* orchestrator.dispatch({
            type: "checkpoint.rollback",
            commandId,
            threadId,
            checkpointId: baseline.id,
            scopeId: baseline.scopeId,
            restoreFiles: false,
          });
          yield* worker.drain();
          assert.deepEqual(
            (yield* outbox.listByCommandId(commandId)).map((effect) => effect.status),
            ["succeeded"],
          );
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.ok(projection.runs.every((run) => run.status === "rolled_back"));
          assert.isNull(projection.providerThreads[0]!.lastRunOrdinal);
          assert.equal(
            projection.providerThreads[0]!.nativeThreadRef?.nativeId,
            "rewound-native-thread",
          );
          assert.isNull(projection.thread.rollbackFailure);
        });

      yield* rewind("non-git-rewind-first");
      assert.equal(rollbackThread.mock.calls[0]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[0]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-first-turn"), ProviderTurnId.make("non-git-second-turn")],
      );
      const discardedCommandId = CommandId.make("non-git-discarded-target");
      yield* orchestrator
        .dispatch({
          type: "checkpoint.rollback",
          commandId: discardedCommandId,
          threadId,
          checkpointId: second.checkpoint.id,
          scopeId: second.checkpoint.scopeId,
          restoreFiles: false,
        })
        .pipe(Effect.flip);
      assert.deepEqual(yield* outbox.listByCommandId(discardedCommandId), []);
      assert.equal(rollbackThread.mock.calls.length, 1);

      const resent = yield* completeMessage("non-git-resent");
      assert.isAbove(resent.run.ordinal, second.run.ordinal);
      yield* rewind("non-git-rewind-again");
      assert.equal(rollbackThread.mock.calls.length, 2);
      assert.equal(rollbackThread.mock.calls[1]![0].target.type, "thread_start");
      assert.deepEqual(
        rollbackThread.mock.calls[1]![0].providerThreadTurns.map((turn) => turn.id),
        [ProviderTurnId.make("non-git-resent-turn")],
      );
    }).pipe(Effect.provide(Layer.merge(Layer.fresh(layerTest), NodeServices.layer))),
  );
});
