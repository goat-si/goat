import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

const MAX_PENDING_WORKSPACE_RESCANS = 128;
const MAX_CONCURRENT_WORKSPACE_RESCANS = 1;
const WORKSPACE_RESCAN_COALESCE_WINDOW = "250 millis";

export const makeProviderWorkspaceRescanQueue = Effect.gen(function* () {
  const queue = yield* Queue.dropping<{
    readonly instance: ProviderInstance;
    readonly cwd: string;
  }>(MAX_PENDING_WORKSPACE_RESCANS);
  const concurrency = yield* Semaphore.make(MAX_CONCURRENT_WORKSPACE_RESCANS);
  const pending = new Map<ProviderInstance, Set<string>>();
  const offer = Effect.fn("ProviderWorkspaceRescanQueue.offer")(function* (
    instance: ProviderInstance,
    cwd: string,
  ) {
    const set = pending.get(instance) ?? new Set<string>();
    if (set.has(cwd)) return;
    set.add(cwd);
    pending.set(instance, set);
    if (!(yield* Queue.offer(queue, { instance, cwd }))) {
      set.delete(cwd);
      if (set.size === 0) pending.delete(instance);
      yield* Effect.logWarning("Provider workspace rescan queue is full.", {
        instanceId: instance.instanceId,
      });
    }
  });
  const run = (scan: (instance: ProviderInstance, cwd: string) => Effect.Effect<void>) =>
    Stream.runForEach(Stream.fromQueue(queue), ({ instance, cwd }) =>
      Effect.sleep(WORKSPACE_RESCAN_COALESCE_WINDOW).pipe(
        Effect.andThen(
          Effect.sync(() => {
            const set = pending.get(instance);
            set?.delete(cwd);
            if (set?.size === 0) pending.delete(instance);
          }),
        ),
        Effect.andThen(concurrency.withPermits(1)(scan(instance, cwd))),
      ),
    );
  return { offer, run };
});
