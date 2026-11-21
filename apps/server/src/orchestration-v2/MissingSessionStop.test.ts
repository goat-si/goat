import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";

it.effect("Stop while a malformed session opens wins over the missing-session failure", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const harness = makeLocalCommandHarness({ text: "Continue" });
    const driver = harness.projection().providerThreads[0]!.driver;
    harness.open.mockReturnValue(
      Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({ driver } as never),
      ),
    );
    const starting = yield* harness.start.pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(entered);
    const projection = harness.projection();
    harness.setProjection({
      ...projection,
      runs: projection.runs.map((run) => ({ ...run, status: "interrupted" as const })),
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(starting);
    expect(harness.projection().runs.at(-1)?.status).toBe("interrupted");
    expect(harness.writeIfRunCurrent).not.toHaveBeenCalled();
  }),
);
