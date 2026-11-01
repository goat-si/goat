import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Snapshot from "./MemorySnapshot.ts";

class MemorySnapshotBinding extends Context.Service<
  MemorySnapshotBinding,
  { readonly bind: (service: Snapshot.MemorySnapshot["Service"]) => Effect.Effect<void> }
>()("goat/memory/MemorySnapshotBinding") {}

// Adapters capture this proxy before Sync (and therefore the real Snapshot) can be built.
// The Ref belongs to the application layer scope, never a module-global runtime.
const layer = Layer.effectContext(
  Effect.gen(function* () {
    const current = yield* Ref.make(Option.none<Snapshot.MemorySnapshot["Service"]>());
    const proxy = Snapshot.MemorySnapshot.of({
      forThread: (...args) =>
        Ref.get(current).pipe(
          Effect.flatMap((service) =>
            Option.isSome(service) ? service.value.forThread(...args) : Effect.succeed(undefined),
          ),
        ),
      revalidate: (...args) =>
        Ref.get(current).pipe(
          Effect.flatMap((service) =>
            Option.isSome(service) ? service.value.revalidate(...args) : Effect.succeed(undefined),
          ),
        ),
      invalidate: (...args) =>
        Ref.get(current).pipe(
          Effect.flatMap((service) =>
            Option.isSome(service) ? service.value.invalidate(...args) : Effect.void,
          ),
        ),
    });
    return Context.make(Snapshot.MemorySnapshot, proxy).pipe(
      Context.add(MemorySnapshotBinding, {
        bind: (service) => Ref.set(current, Option.some(service)),
      }),
    );
  }),
);
const layerInstalled = Layer.effectDiscard(
  Effect.gen(function* () {
    const binding = yield* MemorySnapshotBinding;
    const actual = yield* Snapshot.MemorySnapshot;
    yield* binding.bind(actual);
  }),
);

/** Build proxy → hydration → real Snapshot → bind → application, in one layer memo map. */
export const provide = <A, E, R, H, HE, HR, SE, SR>(
  application: Layer.Layer<A, E, R>,
  hydration: Layer.Layer<H, HE, HR>,
  snapshot: Layer.Layer<Snapshot.MemorySnapshot, SE, SR>,
) =>
  application.pipe(
    // Discard the actual tag: consumers must retain the same proxy hydration captured.
    Layer.provideMerge(layerInstalled.pipe(Layer.provide(snapshot))),
    Layer.provideMerge(hydration),
    Layer.provideMerge(layer),
  );
