/**
 * Answers the resources work's GoalThreadOwnership reference from the goal store, so the
 * usage-limit recovery sweep and model fallback leave goal threads to the goal controller
 * (docs/internals/agentic-k8s.md, "Fallback chains": one owner per failed run).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { GoalThreadOwnership } from "../resources/Fallback.ts";
import * as GoalStore from "./GoalStore.ts";
import { workerThreadId } from "./GoalWorkerRuntime.ts";

/** Every local worker's thread id starts with this, so most answers need no read. */
const LOCAL_WORKER_PREFIX: string = workerThreadId("");

export const layer = Layer.effect(
  GoalThreadOwnership,
  Effect.gen(function* () {
    const store = yield* GoalStore.GoalStore;
    return {
      isGoalThread: (threadId) =>
        threadId.startsWith(LOCAL_WORKER_PREFIX)
          ? Effect.succeed(true)
          : // When the store cannot answer, the thread is treated as the goal's, so no second
            // owner acts on it; the goal controller still sees and handles it.
            store.ownsThread(threadId).pipe(Effect.orElseSucceed(() => true)),
    };
  }),
).pipe(Layer.provide(GoalStore.layer));
