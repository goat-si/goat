import { vi } from "vite-plus/test";
vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
import { expect, it } from "@effect/vitest";
import { RelayClientTracer } from "@goat/shared/relayTracing";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Tracer from "effect/Tracer";
import { RelayConnectionTarget } from "./model.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, PREPARED_CONNECTION, awaitState, makeHarness } from "./supervisorTestSupport.ts";

it.effect("does not export the machine label on relay attempts", () =>
  Effect.gen(function* () {
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const target = new RelayConnectionTarget({
      environmentId: TARGET.environmentId,
      label: "secret-machine-label",
    });
    const harness = yield* makeHarness({
      prepare: () => Effect.succeed({ ...PREPARED_CONNECTION, target }),
    });
    const supervisor = yield* EnvironmentSupervisor.make(
      { target, profile: Option.none(), enabled: true },
      { initiallyDesired: true },
    ).pipe(
      Effect.provide(harness.dependencies),
      Effect.provideService(RelayClientTracer, Option.some(tracer)),
    );
    yield* awaitState(supervisor.state, (state) => state.phase === "connected");
    const attempts = spans.filter((span) => span.name === "relay.connection.attempt");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attributes.has("environment.label")).toBe(false);
  }),
);
