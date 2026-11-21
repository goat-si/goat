import { expect, it } from "@effect/vitest";
import { DEFAULT_SPEECH_CONFIGURATION } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechStreamConnection from "./SpeechStreamConnection.ts";

const randomFixture = vi.hoisted(() => ({ fail: false }));
vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return {
    ...crypto,
    randomUUID: () => {
      if (randomFixture.fail) throw new Error("fixture failure");
      return crypto.randomUUID();
    },
  };
});

it.effect("releases admission if the cancel request is interrupted during worker cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releasing = yield* Deferred.make<void>();
      const allowRelease = yield* Deferred.make<void>();
      const interruptStarted = yield* Deferred.make<void>();
      const speech = Layer.mock(SpeechManagement.SpeechManagement)({
        configuration: Effect.succeed(DEFAULT_SPEECH_CONFIGURATION),
        configurationRevision: Effect.succeed(0),
        configurationChanges: Effect.succeed(Stream.never),
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              configuration: DEFAULT_SPEECH_CONFIGURATION,
              feed: () => Effect.succeed({ revision: 0, text: null }),
              finish: Effect.succeed(""),
            }),
            () =>
              Deferred.succeed(releasing, undefined).pipe(
                Effect.andThen(Deferred.await(allowRelease)),
              ),
          ),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const cancelling = yield* connection.cancel(streamId).pipe(Effect.forkChild);
        yield* Deferred.await(releasing);
        const interrupting = yield* Deferred.succeed(interruptStarted, undefined).pipe(
          Effect.andThen(Fiber.interrupt(cancelling)),
          Effect.forkChild,
        );
        yield* Deferred.await(interruptStarted);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.succeed(allowRelease, undefined);
        yield* Fiber.join(interrupting);
        expect(yield* Effect.result(connection.start())).toMatchObject({ _tag: "Success" });
      }).pipe(Effect.ensuring(Deferred.succeed(allowRelease, undefined)), Effect.provide(speech));
    }),
  ),
);

it.effect("releases an acquired worker if stream setup defects before publishing its id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let released = false;
      const speech = Layer.mock(SpeechManagement.SpeechManagement)({
        configuration: Effect.succeed(DEFAULT_SPEECH_CONFIGURATION),
        configurationRevision: Effect.succeed(0),
        configurationChanges: Effect.succeed(Stream.never),
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              configuration: DEFAULT_SPEECH_CONFIGURATION,
              feed: () => Effect.succeed({ revision: 0, text: null }),
              finish: Effect.succeed(""),
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        randomFixture.fail = true;
        expect((yield* Effect.exit(connection.start()))._tag).toBe("Failure");
        expect(released).toBe(true);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            randomFixture.fail = false;
          }),
        ),
        Effect.provide(speech),
      );
    }),
  ),
);
