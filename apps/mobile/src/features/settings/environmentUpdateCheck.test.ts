import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import { TestClock } from "effect/testing";
import { vi } from "vite-plus/test";

vi.mock("./environment-maintenance", () => ({ findEnvironmentUpdate: vi.fn() }));

import { findEnvironmentUpdate } from "./environment-maintenance";
import { checkEnvironmentUpdate } from "./environmentUpdateCheck";

it.effect("aborts a hung release lookup and reports an explicit timeout", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>();
    vi.mocked(findEnvironmentUpdate).mockImplementation((_version, signal) => {
      Effect.runSync(Deferred.succeed(started, signal));
      return new Promise(() => {});
    });
    const lookup = yield* checkEnvironmentUpdate("1.0.0").pipe(Effect.result, Effect.forkChild);
    const signal = yield* Deferred.await(started);
    yield* TestClock.adjust("20 seconds");
    const result = yield* Fiber.join(lookup);
    expect(signal.aborted).toBe(true);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure.message).toBe("Checking for updates timed out. Try again.");
  }),
);

it.effect("propagates a release lookup failure instead of saying the environment is current", () =>
  Effect.gen(function* () {
    vi.mocked(findEnvironmentUpdate).mockRejectedValueOnce(
      new Error("Could not check releases (403). Try again."),
    );
    const result = yield* checkEnvironmentUpdate("1.0.0").pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).toContain("403");
  }),
);

it.effect("aborts the release lookup when its screen interrupts it", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<AbortSignal>();
    vi.mocked(findEnvironmentUpdate).mockImplementation((_version, signal) => {
      Effect.runSync(Deferred.succeed(started, signal));
      return new Promise(() => {});
    });
    const lookup = yield* checkEnvironmentUpdate("1.0.0").pipe(Effect.forkChild);
    const signal = yield* Deferred.await(started);
    yield* Fiber.interrupt(lookup);
    expect(signal.aborted).toBe(true);
  }),
);
