import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Latch from "effect/Latch";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { HostPathChanged } from "./hostPathChanged.ts";
import * as ProviderPathRefresh from "./ProviderPathRefresh.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it.effect(
  "refreshes providers once per PATH change and once more for a burst during a refresh",
  () =>
    Effect.gen(function* () {
      const changed = Latch.makeUnsafe(false);
      let refreshes = 0;
      const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
        refresh: () =>
          Effect.sleep("1 second").pipe(
            Effect.andThen(Effect.sync(() => void refreshes++)),
            Effect.as([]),
          ),
      });
      yield* Effect.gen(function* () {
        yield* TestClock.adjust("1 hour");
        expect(refreshes).toBe(0);

        yield* changed.open;
        yield* TestClock.adjust("500 millis");
        for (let burst = 0; burst < 5; burst++) yield* changed.open;
        yield* TestClock.adjust("1 hour");
        expect(refreshes).toBe(2);
      }).pipe(
        Effect.provide(ProviderPathRefresh.layer.pipe(Layer.provide(registry))),
        Effect.provideService(HostPathChanged, changed),
      );
    }),
);
