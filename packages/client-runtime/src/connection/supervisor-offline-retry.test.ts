import { vi } from "vite-plus/test";
vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import { RelayConnectionTarget } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, PREPARED_CONNECTION, awaitState, makeHarness } from "./supervisorTestSupport.ts";

const relay: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId: TARGET.environmentId, label: TARGET.label }),
  profile: Option.none(),
  enabled: true,
};

describe("offline retry", () => {
  it.effect("explicit retry connects when the network still reports offline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        networkStatus: "offline",
        prepare: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.sleep("1 second")),
            Effect.as(PREPARED_CONNECTION),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(relay, { initiallyDesired: true }).pipe(
        Effect.provide(harness.dependencies),
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      yield* supervisor.connect;
      yield* supervisor.retryNow;
      yield* Deferred.await(started);
      yield* TestClock.adjust("1 second");
      const settled = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" || state.phase === "offline",
      );
      expect(settled.phase).toBe("connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );
});
