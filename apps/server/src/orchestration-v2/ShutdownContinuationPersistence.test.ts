import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
const layerShutdownTest = ProviderRuntimeRecovery.layer.pipe(
  Layer.provideMerge(
    EventSink.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          EventStore.layer,
          ProjectionStore.layer,
          EffectOutbox.layer,
          IdAllocator.layer,
        ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
      ),
    ),
  ),
  Layer.provide(ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true })),
);
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };
const driver = ProviderDriverKind.make("codex");

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:recovery:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:recovery"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* projections.apply({
    id: EventId.make(`event:${threadId}:created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"],
  overrides: Partial<OrchestrationV2Run> = {},
) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const ordinal = overrides.ordinal ?? 1;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* projections.apply({
    id: EventId.make(`event:${runId}:created`),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: now,
      startedAt: now,
      completedAt: status === "completed" ? now : null,
      checkpointId: null,
      contextHandoffId: null,
      ...overrides,
    },
  });
  return runId;
});

it.effect(
  "shutdown writes continuations for live and prepared work while excluding queued-only threads",
  () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      for (let index = 0; index < 50; index++) {
        yield* createRun(yield* createThread(`shutdown-queued-${index}`), "queued");
      }
      const expected: ThreadId[] = [];
      for (const status of ["running", "starting", "completed"] as const) {
        const threadId = yield* createThread(`shutdown-${status}`);
        expected.push(threadId);
        const sessionId = ProviderSessionId.make(`session:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        yield* projections.apply({
          id: EventId.make(`event:${threadId}:session`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId,
            status: status === "starting" ? "stopped" : "ready",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projections.apply({
          id: EventId.make(`event:${threadId}:provider-thread`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            appThreadId: threadId,
            ownerNodeId: null,
            driver,
            providerInstanceId,
            providerSessionId: sessionId,
            nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: status === "running" ? "active" : "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            pendingBackgroundTasks:
              status === "completed"
                ? [{ taskId: "task", description: "waiting", kind: "command", awaited: true }]
                : [],
          },
        });
        yield* createRun(threadId, status, {
          providerThreadId,
          ...(status === "starting"
            ? { restartContinuationOfRunId: RunId.make("run:previous") }
            : {}),
        });
        if (status === "running") {
          const nodeId = NodeId.make(`node:${threadId}`);
          yield* projections.apply({
            id: EventId.make(`event:${threadId}:node`),
            type: "node.updated",
            threadId,
            nodeId,
            driver,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "root_turn",
              status: "running",
              countsForRun: false,
              providerThreadId,
              providerTurnId: ProviderTurnId.make(`turn:${threadId}`),
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          });
          yield* projections.apply({
            id: EventId.make(`event:${threadId}:turn`),
            type: "provider-turn.updated",
            threadId,
            nodeId,
            driver,
            occurredAt: now,
            payload: {
              id: ProviderTurnId.make(`turn:${threadId}`),
              providerThreadId,
              nodeId,
              runAttemptId: null,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          });
        }
      }
      assert.deepEqual(
        new Set(yield* projections.getRecoveryThreadIds("shutdown-continuation")),
        new Set(expected),
      );
      for (const id of expected) {
        const projection = yield* projections.getRuntimeRecoveryProjection(id);
        assert.isDefined(restartContinuationRun(projection, now), id);
      }
      const eventSink = yield* EventSink.EventSinkV2;
      const blockedId = ThreadId.make("thread:recovery:shutdown-completed");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const committed = yield* Deferred.make<void>();
      const isolatedRecovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.succeed(ProjectionStore.ProjectionStoreV2, {
              ...projections,
              getRuntimeRecoveryProjection: (id) =>
                id === blockedId
                  ? Deferred.succeed(started, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(
                        Effect.fail(
                          new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                        ),
                      ),
                    )
                  : projections.getRuntimeRecoveryProjection(id),
            }),
            Layer.succeed(EventSink.EventSinkV2, {
              ...eventSink,
              writeWithEffects: (input) =>
                eventSink
                  .writeWithEffects(input)
                  .pipe(Effect.tap(() => Deferred.succeed(committed, undefined))),
            }),
          ),
        ),
      );
      const preparing = yield* isolatedRecovery.prepareForShutdown.pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.await(started);
      yield* Deferred.await(committed);
      const committedRows = yield* sql<{
        readonly thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-runtime.continue'`;
      assert.isAtLeast(committedRows.length, 1);
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* Fiber.join(preparing), { candidates: 3, continued: 2 });
      const summary = yield* recovery.prepareForShutdown;
      assert.deepEqual(summary, { candidates: 3, continued: 3 });
      const rows = yield* sql<{
        readonly thread_id: string;
      }>`SELECT thread_id FROM orchestration_v2_effect_outbox WHERE effect_type = 'provider-runtime.continue'`;
      assert.deepEqual(new Set(rows.map((row) => row.thread_id)), new Set(expected));
    }).pipe(Effect.provide(layerShutdownTest)),
);
