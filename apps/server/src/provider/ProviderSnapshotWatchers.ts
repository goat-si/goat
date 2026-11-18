import type { ProviderInstanceId } from "@goat/contracts";
import type { ProviderInstance } from "@goat/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export const makeProviderSnapshotWatchers = (scope: Scope.Scope) => {
  const active = new Map<
    ProviderInstanceId,
    { readonly instance: ProviderInstance; readonly fiber: Fiber.Fiber<void> }
  >();

  const retire = Effect.fn("ProviderSnapshotWatchers.retire")(function* (
    instances: ReadonlyMap<ProviderInstanceId, ProviderInstance>,
  ) {
    for (const [id, watcher] of active) {
      if (instances.get(id) === watcher.instance) continue;
      yield* Fiber.interrupt(watcher.fiber);
      active.delete(id);
    }
  });

  const start = Effect.fn("ProviderSnapshotWatchers.start")(function* (
    instance: ProviderInstance,
    watch: Effect.Effect<void>,
  ) {
    if (active.has(instance.instanceId)) return;
    const fiber = yield* Effect.forkIn(Effect.interruptible(watch), scope);
    active.set(instance.instanceId, { instance, fiber });
  }, Effect.uninterruptible);

  return { retire, start };
};
