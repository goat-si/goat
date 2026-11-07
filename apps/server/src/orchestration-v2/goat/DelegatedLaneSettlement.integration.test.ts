import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import {
  layerTest,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "../DelegatedCompletionDelivery.testkit.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EffectOutbox from "../EffectOutbox.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import { deviceReleaseApplies } from "./CleanupEffects.ts";
import { makeDelegatedLaneSettlement } from "./DelegatedLaneSettlement.ts";

const seed = (name: string, continuationPending = false) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const parentThreadId = ThreadId.make(`thread:${name}-parent`);
    const projectId = ProjectId.make(`project:${name}`);
    const parentRunId = RunId.make(`run:${name}-parent`);
    const rootNodeId = NodeId.make(`node:${name}-root`);
    yield* seedParentWithTerminalTask({
      threadId: parentThreadId,
      projectId,
      runId: parentRunId,
      rootNodeId,
      taskId: NodeId.make(`node:${name}-earlier`),
      deliveryState: "delivered",
      now,
    });
    return yield* seedRestartCancelledChild({
      parentThreadId,
      projectId,
      parentRunId,
      rootNodeId,
      name: `${name}-lane`,
      completionWake: "settled_only",
      continuationPending,
      runStatus: "completed",
      now,
    });
  });

const candidate = (threadId: ThreadId) =>
  ProjectionStore.ProjectionStoreV2.pipe(
    Effect.flatMap((projections) => projections.getSettlementCandidates(threadId)),
    Effect.map((candidates) => candidates[0]!),
  );

const message = (threadId: ThreadId, id: string) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text: "Another round",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "agent",
        creationSource: "mcp",
      }),
    ),
  );

// The same in-memory database as the orchestrator, for reads it does not expose.
const layer = Layer.mergeAll(
  layerTest,
  ProjectionStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
);

it.layer(layer)("finished task lanes with the real orchestrator", (it) => {
  it.effect("a lane becomes settleable only once its parent records the latest run's result", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const settledAt = yield* makeDelegatedLaneSettlement;
      const lane = yield* seed("recorded");
      assert.isNull(yield* settledAt(yield* candidate(lane.childThreadId)));

      yield* orchestrator.recoverDelegatedTasks;
      const ready = yield* candidate(lane.childThreadId);
      assert.deepEqual(yield* settledAt(ready), ready.latestRunCompletedAt);
    }),
  );

  it.effect("a lane still owed a restart continuation is not settleable", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const settledAt = yield* makeDelegatedLaneSettlement;
      const lane = yield* seed("continuing", true);
      yield* orchestrator.recoverDelegatedTasks;
      assert.isNull(yield* settledAt(yield* candidate(lane.childThreadId)));
    }),
  );

  it.effect("a message that reaches the lane after the read makes its settlement stale", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const lane = yield* seed("raced");
      yield* orchestrator.recoverDelegatedTasks;
      const ready = yield* candidate(lane.childThreadId);
      const settledAt = yield* (yield* makeDelegatedLaneSettlement)(ready);
      assert.isNotNull(settledAt);

      yield* message(lane.childThreadId, "raced-round");
      const stale = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.auto-settle",
          commandId: CommandId.make("raced-settle"),
          threadId: lane.childThreadId,
          snapshotAt: ready.updatedAt,
          ...(settledAt === null ? {} : { settledAt }),
        }),
      );
      assert.isTrue(Exit.isFailure(stale));
      assert.isNull((yield* projections.getThreadShell(lane.childThreadId))?.settledOverride);
    }),
  );

  it.effect("settling a finished lane queues its device release, and a new round reopens it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const lane = yield* seed("settled");
      yield* orchestrator.recoverDelegatedTasks;
      const ready = yield* candidate(lane.childThreadId);
      const settledAt = yield* (yield* makeDelegatedLaneSettlement)(ready);
      yield* orchestrator.dispatch({
        type: "thread.auto-settle",
        commandId: CommandId.make("settle-finished-lane"),
        threadId: lane.childThreadId,
        snapshotAt: ready.updatedAt,
        ...(settledAt === null ? {} : { settledAt }),
      });
      const settled = yield* projections.getThreadShell(lane.childThreadId);
      assert.equal(settled?.settledOverride, "settled");
      const queued = yield* outbox.listByCommandId(CommandId.make("settle-finished-lane"));
      assert.isTrue(queued.some((effect) => effect.request.type === "device.release"));

      yield* message(lane.childThreadId, "next-round");
      assert.isFalse(deviceReleaseApplies(yield* projections.getThreadShell(lane.childThreadId)));
    }),
  );
});
