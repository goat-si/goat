import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Semaphore from "effect/Semaphore";

import { runAsServerJob } from "./serverJob.ts";

it.effect("a job that dies is logged under its job name, and its permit is released", () => {
  const logged: Array<unknown> = [];
  const logger = Logger.make(({ message, logLevel }) => {
    if (logLevel === "Error") logged.push(message);
  });
  return Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const exit = yield* Effect.exit(
      runAsServerJob(permit, scope, "Test.job", () => Effect.die(new Error("boom"))),
    );
    expect(exit._tag).toBe("Failure");
    expect(JSON.stringify(logged)).toContain("Test.job");
    expect(yield* Semaphore.take(permit, 1)).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect("a job's defect log carries a fixed category and never the defect's own text", () => {
  const logged: Array<string> = [];
  const logger = Logger.make(({ message, cause }) => {
    logged.push(JSON.stringify(message), Cause.pretty(cause));
  });
  return Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    yield* Effect.exit(
      runAsServerJob(permit, scope, "Test.job", () =>
        Effect.die(new Error("token=sk-live-123 at /Users/someone/secret")),
      ),
    );
    expect(logged.join("\n")).toContain("Test.job");
    expect(logged.join("\n")).toContain("defect");
    expect(logged.join("\n")).not.toContain("sk-live-123");
    expect(logged.join("\n")).not.toContain("/Users/someone");
  }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
});

it.effect("a caller that stops waiting sets stopped, and the job still runs to its end", () =>
  Effect.gen(function* () {
    const permit = yield* Semaphore.make(1);
    const scope = yield* Effect.scope;
    const started = yield* Deferred.make<void>();
    const gate = yield* Deferred.make<void>();
    const seen = yield* Deferred.make<boolean>();
    const caller = yield* runAsServerJob(permit, scope, "Test.job", (stopped) =>
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(gate)),
        Effect.andThen(stopped),
        Effect.flatMap((value) => Deferred.succeed(seen, value)),
      ),
    ).pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.await(started);
    yield* Fiber.interrupt(caller);
    yield* Deferred.succeed(gate, undefined);
    expect(yield* Deferred.await(seen)).toBe(true);
  }).pipe(Effect.scoped),
);
