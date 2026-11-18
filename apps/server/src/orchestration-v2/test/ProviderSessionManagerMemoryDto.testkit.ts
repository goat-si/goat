import { assert } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ProjectId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Statement from "effect/sql/Statement";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ServerSettings from "../../serverSettings.ts";
import * as Receipts from "../CommandReceiptStore.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as EventSink from "../EventSink.ts";
import { emptyState, modelSelection, runtimePolicy } from "../ProviderSessionFixture.testkit.ts";
import { layerTest } from "./ProviderSessionManagerHarness.testkit.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";
import * as ThreadManagement from "../ThreadManagementService.ts";

// Exercise the real DTO decorator with the manager under test and committed
// destination state. Only the run fixture and unrelated transport ports are synthetic.
export const readPreparedRunDto = Effect.fnUntraced(function* (
  threadId: ThreadId,
  runId: RunId,
  delegatedTaskId: NodeId,
  pastRunCount = 0,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const committed = yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy);
  if (Option.isNone(committed)) return yield* Effect.die("test requires committed memory policy");
  const projection = yield* store.getThreadProjection(threadId);
  const run: OrchestrationV2Run = {
    id: runId,
    delegatedTaskId,
    threadId,
    ordinal: 1,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("reattach-message"),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: projection.thread.createdAt,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
    memoryGrantCeiling: "read_write",
  };
  const runs = [
    ...Array.from({ length: pastRunCount }, (_, index) => ({
      ...run,
      id: RunId.make(`historical-run-${index}`),
      ordinal: index + 2,
    })),
    run,
  ];
  let threadReads = 0;
  const countThreadReads: Statement.Transformer = (statement) => {
    const [query] = statement.compile();
    if (query.includes("SELECT payload_json FROM orchestration_v2_projection_threads")) {
      threadReads++;
    }
    return Effect.succeed(statement);
  };
  return yield* Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const records = yield* threads.getThreadRecords(threadId, ["runs"]);
    if (pastRunCount > 0) {
      assert.equal(threadReads, 1);
      for (const historical of records.runs.slice(0, -1)) {
        assert.notProperty(historical, "currentMemoryAccess");
      }
    }
    return records.runs.at(-1)!;
  }).pipe(
    Effect.provide(
      ThreadManagement.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, manager),
            Layer.succeed(ServerSettings.ServerSettingsService, settings),
            Layer.succeed(ServerSettings.MemoryProviderCommittedPolicy, committed.value),
            Layer.mock(Receipts.CommandReceiptStoreV2)({}),
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () => Effect.succeed({ ...projection, runs }),
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(Statement.CurrentTransformer, countThreadReads),
  );
});
export function makeThreadCreatedEvent(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly now: DateTime.Utc;
  readonly projectId?: ProjectId;
  readonly delegatedBy?: ThreadId;
}) {
  return Effect.gen(function* () {
    const projectId =
      input.projectId ??
      (yield* input.idAllocator.allocate.project({
        fixtureName: "provider-session-manager",
      }));
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId,
      title: "Provider session manager",
      providerInstanceId: modelSelection.instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage:
        input.delegatedBy === undefined
          ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
          : {
              parentThreadId: input.delegatedBy,
              relationshipToParent: "subagent",
              rootThreadId: input.delegatedBy,
            },
      forkedFrom: null,
      createdAt: input.now,
      updatedAt: input.now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return {
      id: yield* input.idAllocator.allocate.event({ threadId: input.threadId }),
      type: "thread.created" as const,
      threadId: input.threadId,
      occurredAt: input.now,
      payload: thread,
    };
  });
}

/** A thread with an open read_write run on a fresh session, as the memory DTO cases need. */
export const openMemoryRun = Effect.fnUntraced(function* (name: string) {
  const sink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threadId = ThreadId.make(name);
  const runId = RunId.make(name + "-run");
  const taskId = NodeId.make(name + "-task");
  const now = yield* DateTime.now;
  const providerSessionId = yield* ids.allocate.providerSession({
    providerInstanceId: modelSelection.instanceId,
    threadId,
  });
  yield* sink.write({
    events: [yield* makeThreadCreatedEvent({ idAllocator: ids, threadId, now })],
  });
  yield* manager.open({
    threadId,
    providerSessionId,
    modelSelection,
    runtimePolicy,
    runId,
    delegatedTaskId: taskId,
    memoryGrantCeiling: "read_write",
  });
  return { sink, ids, manager, threadId, runId, taskId, now };
});

/**
 * Holds the next committed-policy read made inside currentMemoryPolicy, and drives
 * the manager's rotation consumer by hand: rotate returns once its pass has ended.
 */
export const makeMemoryReadHold = Effect.gen(function* () {
  const armed = yield* Ref.make(false);
  const entered = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const rotations = yield* Queue.unbounded<Deferred.Deferred<void>>();
  const settingsLayer = Layer.effect(
    ServerSettings.MemoryProviderCommittedPolicy,
    Effect.gen(function* () {
      const policy = Option.getOrThrow(
        yield* Effect.serviceOption(ServerSettings.MemoryProviderCommittedPolicy),
      );
      const read = Effect.gen(function* () {
        const span = yield* Effect.option(Effect.currentSpan);
        if (
          Option.isSome(span) &&
          span.value.name === "MemoryProviderAuthority.currentMemoryPolicy" &&
          (yield* Ref.getAndSet(armed, false))
        ) {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
        }
        return yield* policy.read;
      });
      const subscribeRotations = Effect.succeed(
        Stream.fromQueue(rotations).pipe(
          Stream.flatMap((done) =>
            Stream.fromEffect(policy.read).pipe(
              Stream.concat(
                Stream.fromEffect(Deferred.succeed(done, undefined)).pipe(Stream.drain),
              ),
            ),
          ),
        ),
      );
      return { read, subscribeRotations };
    }),
  ).pipe(Layer.provideMerge(ServerSettings.layerTest()));
  const state = yield* Ref.make(emptyState);
  const rotate = Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    yield* Queue.offer(rotations, done);
    yield* Deferred.await(done);
  });
  return {
    layer: layerTest({ state, idleTimeoutMs: 60_000, serverSettingsLayer: settingsLayer }).pipe(
      Layer.provideMerge(settingsLayer),
    ),
    arm: Ref.set(armed, true),
    entered: Deferred.await(entered),
    release: Deferred.succeed(release, undefined),
    rotate,
  };
});
