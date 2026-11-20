import { expect, it } from "@effect/vitest";
import { DEFAULT_SPEECH_CONFIGURATION } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechStreamConnection from "./SpeechStreamConnection.ts";

it.effect("keeps a slow feed alive until its 30 second operation deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const speech = Layer.mock(SpeechManagement.SpeechManagement)({
        configuration: Effect.succeed(DEFAULT_SPEECH_CONFIGURATION),
        configurationRevision: Effect.succeed(0),
        configurationChanges: Effect.succeed(Stream.never),
        startStream: () =>
          Effect.succeed({
            configuration: DEFAULT_SPEECH_CONFIGURATION,
            feed: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        yield* connection
          .feed({ streamId, sequence: 0, audioBase64: "AAA=" })
          .pipe(
            Effect.result,
            Effect.ensuring(Deferred.succeed(done, undefined)),
            Effect.forkChild,
          );
        yield* Deferred.await(started);
        yield* TestClock.adjust("15 seconds");
        expect(yield* Deferred.isDone(done)).toBe(false);
        expect(yield* Effect.result(connection.start())).toMatchObject({
          _tag: "Failure",
          failure: { code: "busy" },
        });
        yield* TestClock.adjust("15 seconds");
        expect(yield* Deferred.isDone(done)).toBe(true);
      }).pipe(Effect.provide(speech));
    }),
  ),
);
