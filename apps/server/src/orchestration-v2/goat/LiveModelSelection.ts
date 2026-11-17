/**
 * Applies a thread's new model selection to the provider turn running now, where the adapter can
 * (Claude: effort and fast mode). Nothing is persisted (ruling C): a change this server never
 * applied waits for the next turn, which always starts with the thread's selection.
 */
import type { ModelSelection, OrchestrationV2DomainEvent, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProviderSessionManager from "../ProviderSessionManager.ts";

const CALL_DEADLINE = "10 seconds";
const MAX_THREADS = 256;

export const make = Effect.fn("LiveModelSelection.make")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const scope = yield* Effect.scope;
  // The latest selection per thread; one drain per thread, so a slow call holds only its thread.
  const pending = new Map<ThreadId, ModelSelection>();
  const draining = new Set<ThreadId>();
  let warnedFull = false;

  const apply = Effect.fn("LiveModelSelection.apply")(
    function* (threadId: ThreadId, modelSelection: ModelSelection) {
      const { providerThread, providerTurn } = yield* projections.getRunningTurnContext(threadId);
      if (providerThread?.providerSessionId == null || providerTurn === undefined) return;
      const session = yield* sessions.get(providerThread.providerSessionId);
      if (Option.isNone(session) || session.value.applyModelSelection === undefined) return;
      yield* session.value.applyModelSelection({ providerThread, modelSelection });
    },
    Effect.timeout(CALL_DEADLINE),
    (effect, threadId) => {
      const failed = (cause: unknown) =>
        Effect.logWarning("orchestration-v2.live-model-selection-failed", { threadId, cause });
      return effect.pipe(Effect.catch(failed), Effect.catchDefect(failed));
    },
  );

  const drain = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.suspend(() => {
      const next = pending.get(threadId);
      if (next === undefined) {
        draining.delete(threadId);
        return Effect.void;
      }
      pending.delete(threadId);
      return apply(threadId, next).pipe(Effect.andThen(drain(threadId)));
    });

  const handle = (event: OrchestrationV2DomainEvent): Effect.Effect<void> =>
    Effect.suspend(() => {
      // The provider's own report of its model comes with its raw event; applying it would echo.
      if (event.type !== "thread.model-selection-updated" || event.rawEventId !== undefined)
        return Effect.void;
      const threadId = event.threadId;
      if (!draining.has(threadId) && draining.size >= MAX_THREADS) {
        if (warnedFull) return Effect.void;
        warnedFull = true;
        return Effect.logWarning("orchestration-v2.live-model-selection-full", { threadId });
      }
      pending.set(threadId, event.payload.modelSelection);
      if (draining.has(threadId)) return Effect.void;
      draining.add(threadId);
      return drain(threadId).pipe(Effect.forkIn(scope), Effect.asVoid);
    });

  return { handle };
});

export const run = Effect.gen(function* () {
  const { handle } = yield* make();
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.runForEach(handle),
      Effect.catchCause((cause) =>
        Effect.logWarning("orchestration-v2.live-model-selection-ended", { cause }),
      ),
    ),
  );
});

export const layer = Layer.effectDiscard(run);
