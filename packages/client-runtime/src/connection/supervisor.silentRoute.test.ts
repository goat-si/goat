import { vi } from "vite-plus/test";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { BearerConnectionProfile, type ConnectionCatalogEntry } from "./catalog.ts";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, awaitState, makeHarness, transient } from "./supervisorTestSupport.ts";

const LAN_TARGET = new BearerConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  connectionId: "bearer:lan",
});
const LAN_THEN_RELAY_ENTRY: ConnectionCatalogEntry = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
  alternateRoutes: [
    {
      target: new RelayConnectionTarget({
        environmentId: TARGET.environmentId,
        label: TARGET.label,
      }),
      profile: Option.none(),
    },
  ],
  enabled: true,
};

describe("EnvironmentSupervisor routes after a transient failure", () => {
  it.effect("retries instead of waiting on a LAN route that stayed silent after relay failed", () =>
    Effect.gen(function* () {
      const checkingLan = yield* Deferred.make<void>();
      const attempted: string[] = [];
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Deferred.succeed(checkingLan, undefined).pipe(
                Effect.andThen(Effect.sleep("2500 millis")),
                Effect.as("silent" as const),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => {
          attempted.push(target._tag);
          return target._tag === "RelayConnectionTarget"
            ? Effect.fail(transient("Relay socket closed."))
            : Effect.never;
        },
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(checkingLan);
      yield* TestClock.adjust("2500 millis");
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(attempted).toEqual(["RelayConnectionTarget"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
