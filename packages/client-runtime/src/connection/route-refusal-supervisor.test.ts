import { vi } from "vite-plus/test";
vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { BearerConnectionTarget, RelayConnectionTarget } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, PREPARED_CONNECTION, awaitState, makeHarness } from "./supervisorTestSupport.ts";

it.effect("reports an earlier refused route after falling back, then clears it when it works", () =>
  Effect.gen(function* () {
    const first = new BearerConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      connectionId: "lan",
    });
    const relay = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: TARGET.label,
    });
    const reachable = yield* Ref.make(false);
    const refuses = yield* Ref.make(true);
    const checkRoute = (route: { target: { _tag: string } }) =>
      route.target._tag === "BearerConnectionTarget"
        ? Ref.get(reachable).pipe(
            Effect.map((value) => (value ? ("answered" as const) : ("silent" as const))),
          )
        : Effect.succeed("unchecked" as const);
    const harness = yield* makeHarness({
      checkRoute,
      preflight: (_route) =>
        Ref.get(refuses).pipe(
          Effect.map((value) => (value ? ("refused" as const) : ("ready" as const))),
        ),
      prepare: (_attempt, target) => Effect.succeed({ ...PREPARED_CONNECTION, target }),
    });
    const supervisor = yield* EnvironmentSupervisor.make(
      {
        target: first,
        profile: Option.none(),
        enabled: true,
        alternateRoutes: [{ target: relay, profile: Option.none() }],
      },
      { initiallyDesired: true },
    ).pipe(Effect.provide(harness.dependencies));
    const connected = yield* awaitState(supervisor.state, (s) => s.phase === "connected");
    expect(connected.refusedRouteIds).toEqual([]);
    yield* Ref.set(reachable, true);
    yield* harness.wake("network-changed");
    const marked = yield* awaitState(supervisor.state, (s) => s.refusedRouteIds.includes("lan"));
    expect(marked.generation).toBe(connected.generation);
    yield* Ref.set(refuses, false);
    yield* harness.wake("network-changed");
    const switched = yield* awaitState(
      supervisor.state,
      (s) => s.phase === "connected" && s.generation > connected.generation,
    );
    expect(switched.refusedRouteIds).toEqual([]);
  }),
);
