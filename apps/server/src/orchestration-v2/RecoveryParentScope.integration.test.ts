import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { createWatchingThread, delegate, layerTest, send } from "./ThreadStop.testkit.ts";
import { makeDeferredRecoveryResends } from "./goat/DeferredRecoveryResends.ts";

it.effect.each(["run.interrupt", "thread.stop"] as const)(
  "recovery follows %s scope for asynchronous and wait-mode children",
  (kind) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const sink = yield* EventSink.EventSinkV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const parent = ThreadId.make(`scope-parent:${kind}`);
      yield* createWatchingThread(parent, 8);
      yield* send(parent, "parent", "start_immediately");
      const parentRun = (yield* orchestrator.getThreadProjection(parent)).runs[0]!;
      const asyncChild = yield* delegate(parent, `async-${kind}`, "always");
      const waitChild = yield* delegate(parent, `wait-${kind}`, "settled_only");
      const deferred = makeDeferredRecoveryResends({ projections, sink, ids, outbox });
      const staged = [];
      for (const child of [asyncChild, waitChild]) {
        const projection = yield* orchestrator.getThreadProjection(child);
        const run = projection.runs[0]!;
        const original = Option.getOrThrow(yield* outbox.findOriginalStart(child, run.id));
        assert.isTrue(
          deferred.reserve({
            threadId: child,
            run,
            attemptId: run.activeAttemptId!,
            commandId: original.commandId,
            resendCount: 0,
          }),
        );
        yield* deferred.captureSequence(child);
        staged.push({ child, run });
      }
      const stopId = CommandId.make(`scope-stop:${kind}`);
      if (kind === "thread.stop")
        yield* orchestrator.dispatch({ type: "thread.stop", commandId: stopId, threadId: parent });
      else
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: stopId,
          threadId: parent,
          runId: parentRun.id,
          holdQueue: true,
        });
      yield* outbox.reconcileAfterProcessLoss;
      yield* deferred.drain(locks);
      for (const { child, run } of staged) {
        const resend = yield* outbox.get(`effect:recovery-resend:${run.id}:1`);
        assert.equal(Option.isSome(resend), kind === "run.interrupt" && child === asyncChild);
      }
      const stopEffect = Option.getOrThrow(
        yield* outbox.get(`effect:${stopId}:delegated-tasks.stop`),
      );
      assert.equal(stopEffect.request.type, "delegated-tasks.stop");
      if (stopEffect.request.type !== "delegated-tasks.stop") return;
      yield* threads.stopDelegatedTasks({
        threadId: parent,
        commandId: stopId,
        childThreadIds: stopEffect.request.childThreadIds,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(waitChild)).runs[0]?.status,
        "interrupted",
      );
      assert.equal(
        (yield* orchestrator.getThreadProjection(asyncChild)).runs[0]?.status,
        kind === "thread.stop" ? "interrupted" : "starting",
      );
    }).pipe(
      Effect.provide(Layer.mergeAll(layerTest, IdAllocator.layer, ThreadCommandExecutor.layer)),
    ),
);
