import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { withSshConnectionTiming } from "./sshTiming.ts";

describe("SSH step timing", () => {
  it.effect.each([true, false])(
    "preserves the result and logs only bounded timing fields (ok=%s)",
    (ok) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const logs: Readonly<Record<string, unknown>>[] = [];
        const failure = {
          credential: "private-value",
          url: "http://private.invalid?token=private-value",
        };
        const operation = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(ok ? Effect.succeed(failure) : Effect.fail(failure)),
          withSshConnectionTiming("authorization"),
          Effect.result,
          Effect.provide(
            Logger.layer(
              [
                Logger.make(({ fiber, message }) => {
                  expect(String(message)).toBe("ssh.postConnect.cost");
                  logs.push(fiber.getRef(References.CurrentLogAnnotations));
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        );
        const fiber = yield* operation.pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("250 millis");
        yield* Deferred.succeed(release, undefined);
        const result = yield* Fiber.join(fiber);
        expect(result).toEqual(ok ? Result.succeed(failure) : Result.fail(failure));
        expect(logs).toEqual([
          { step: "authorization", wallMs: 250, outcome: ok ? "ok" : "failed" },
        ]);
        expect(JSON.stringify(logs)).not.toContain("private-value");
      }),
  );
});
