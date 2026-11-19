import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SpeechManagement from "./SpeechManagement.ts";
import * as SpeechStreamConnection from "./SpeechStreamConnection.ts";
import * as SpeechInference from "./SpeechInference.ts";
import { DEFAULT_SPEECH_CONFIGURATION } from "@goat/contracts";

type TestStream = Omit<
  Effect.Success<ReturnType<SpeechManagement.SpeechManagement["Service"]["startStream"]>>,
  "configuration"
>;
const speechLayer = (
  overrides: Omit<Partial<SpeechManagement.SpeechManagement["Service"]>, "startStream"> & {
    readonly startStream?: (
      language?: string,
    ) => Effect.Effect<TestStream, SpeechManagement.SpeechManagementError, Scope.Scope>;
  },
) => {
  const { startStream: start, ...other } = overrides;
  return Layer.mock(SpeechManagement.SpeechManagement)({
    configuration: Effect.succeed(DEFAULT_SPEECH_CONFIGURATION),
    configurationRevision: Effect.succeed(0),
    configurationChanges: Effect.succeed(Stream.never),
    ...other,
    ...(start
      ? {
          startStream: (language) =>
            start(language).pipe(
              Effect.map((worker) => ({ ...worker, configuration: DEFAULT_SPEECH_CONFIGURATION })),
            ),
        }
      : {}),
  });
};

it.effect("keeps stream ids connection-local and emits ordered preview and final text", () =>
  Effect.gen(function* () {
    const speech = speechLayer({
      startStream: () =>
        Effect.succeed({
          feed: () =>
            Effect.succeed({ revision: 1, text: { committed: "hello", tentative: " world" } }),
          finish: Effect.succeed("hello world"),
        }),
    });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const first = yield* SpeechStreamConnection.make;
        const second = yield* SpeechStreamConnection.make;
        const { streamId } = yield* first.start();
        expect(
          yield* Effect.result(second.feed({ streamId, sequence: 0, audioBase64: "AAA=" })),
        ).toMatchObject({ _tag: "Failure" });
        const received = yield* Queue.unbounded<unknown>();
        const ended = yield* Deferred.make<void>();
        yield* first.events(streamId).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.ensuring(Deferred.succeed(ended, undefined)),
          Effect.forkChild,
        );
        yield* first.feed({ streamId, sequence: 0, audioBase64: "AAA=" });
        expect(yield* Queue.take(received)).toEqual({
          type: "partial",
          revision: 1,
          committed: "hello",
          tentative: " world",
        });
        yield* first.finish(streamId);
        expect(yield* Queue.take(received)).toEqual({ type: "final", text: "hello world" });
        yield* Deferred.await(ended);
      }).pipe(Effect.provide(speech)),
    );
  }),
);

it.effect("watches configuration while a stream is open", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const subscribed = yield* Deferred.make<void>();
      const speech = speechLayer({
        configuration: Effect.succeed(DEFAULT_SPEECH_CONFIGURATION),
        configurationRevision: Effect.succeed(0),
        configurationChanges: Deferred.succeed(subscribed, undefined).pipe(Effect.as(Stream.empty)),
        startStream: () =>
          Effect.succeed({
            feed: () => Effect.succeed({ revision: 0, text: null }),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        yield* connection.start();
        expect(yield* Deferred.isDone(subscribed)).toBe(true);
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("identifies a busy model slot without opening a stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.fail(
            new SpeechManagement.SpeechManagementError({
              operation: "stream",
              cause: "Speech is busy.",
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        expect(yield* Effect.result(connection.start())).toMatchObject({
          _tag: "Failure",
          failure: { code: "busy" },
        });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("rejects a second stream on the same connection", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () => Effect.succeed({ revision: 0, text: null }),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const first = yield* connection.start();
        expect(yield* Effect.result(connection.start())).toMatchObject({
          _tag: "Failure",
          failure: { code: "busy" },
        });
        yield* connection.cancel(first.streamId);
        expect(yield* Effect.result(connection.start())).toMatchObject({ _tag: "Success" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("rejects malformed audio and releases the stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () => Effect.succeed({ revision: 0, text: null }),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        expect(
          yield* Effect.result(connection.feed({ streamId, sequence: 0, audioBase64: "!" })),
        ).toMatchObject({ _tag: "Failure", failure: { code: "invalid-audio" } });
        expect(yield* Effect.result(connection.start())).toMatchObject({ _tag: "Success" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("identifies an unsupported model without opening a stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.fail(
            new SpeechManagement.SpeechManagementError({
              operation: "stream",
              cause: new SpeechInference.SpeechInferenceError({
                cause: "unsupported",
                code: "unsupported",
              }),
            }),
          ),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        expect(yield* Effect.result(connection.start())).toMatchObject({
          _tag: "Failure",
          failure: { code: "unsupported" },
        });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("ends an active stream when its model configuration changes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const changes = yield* Queue.unbounded<
        typeof DEFAULT_SPEECH_CONFIGURATION & { readonly revision: number }
      >();
      const released = yield* Deferred.make<void>();
      const speech = speechLayer({
        configurationRevision: Effect.succeed(0),
        configurationChanges: Effect.succeed(Stream.fromQueue(changes)),
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () => Effect.succeed({ revision: 0, text: null }),
              finish: Effect.succeed(""),
            }),
            () => Deferred.succeed(released, undefined),
          ),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const received = yield* Queue.unbounded<unknown>();
        yield* connection.events(streamId).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkChild,
        );
        yield* Queue.offer(changes, {
          ...DEFAULT_SPEECH_CONFIGURATION,
          modelId: "different-model",
          revision: 1,
        });
        expect(yield* Queue.take(received)).toEqual({ type: "error", code: "failed" });
        yield* Deferred.await(released);
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("does not open a stream after its connection has closed during model loading", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const loaded = yield* Deferred.make<void>();
    let interrupted = false;
    const speech = speechLayer({
      startStream: () =>
        Effect.acquireRelease(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(loaded)),
            Effect.as({
              feed: () => Effect.succeed({ revision: 0, text: null }),
              finish: Effect.succeed(""),
            }),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
          () => Effect.void,
          { interruptible: true },
        ),
    });
    yield* Effect.gen(function* () {
      const scope = yield* Scope.make();
      const connection = yield* SpeechStreamConnection.make.pipe(Scope.provide(scope));
      const running = yield* connection.start().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.succeed(loaded, undefined);
      expect(yield* Effect.result(Fiber.join(running))).toMatchObject({ _tag: "Failure" });
      expect(interrupted).toBe(true);
    }).pipe(Effect.provide(speech));
  }),
);

it.effect("interrupts model loading when the start request is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      const speech = speechLayer({
        startStream: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const running = yield* connection.start().pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(running);
        expect(interrupted).toBe(true);
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("releases the worker if an in-flight feed request is interrupted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let released = false;
      const speech = speechLayer({
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
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
        const { streamId } = yield* connection.start();
        const running = yield* connection
          .feed({ streamId, sequence: 0, audioBase64: "AAA=" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(running);
        expect(released).toBe(true);
        expect(yield* Effect.result(connection.start())).toMatchObject({ _tag: "Success" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("discards a late native update after cancellation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const result = yield* Deferred.make<{
        revision: number;
        text: { committed: string; tentative: string };
      }>();
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(result))),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const running = yield* connection
          .feed({ streamId, sequence: 0, audioBase64: "AAA=" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* connection.cancel(streamId);
        yield* Deferred.succeed(result, {
          revision: 1,
          text: { committed: "late", tentative: "" },
        });
        expect(yield* Effect.result(Fiber.join(running))).toMatchObject({
          _tag: "Failure",
          failure: { code: "expired" },
        });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("closes the subscription and treats repeated cancellation as a no-op", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () => Effect.succeed({ revision: 0, text: null }),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const received = yield* Queue.unbounded<unknown>();
        yield* connection.events(streamId).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkChild,
        );
        yield* connection.cancel(streamId);
        expect(yield* Effect.result(connection.cancel(streamId))).toMatchObject({
          _tag: "Success",
        });
        expect(yield* Queue.take(received)).toEqual({ type: "error", code: "cancelled" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("rejects a second subscriber to the same transcript", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () => Effect.succeed({ revision: 1, text: { committed: "one", tentative: "" } }),
            finish: Effect.succeed("one"),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const received = yield* Queue.unbounded<unknown>();
        yield* connection.events(streamId).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkChild,
        );
        yield* connection.feed({ streamId, sequence: 0, audioBase64: "AAA=" });
        yield* Queue.take(received);
        const second = yield* connection.events(streamId).pipe(Stream.runHead, Effect.forkChild);
        yield* connection.finish(streamId);
        expect(yield* Effect.result(Fiber.join(second))).toMatchObject({ _tag: "Failure" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("terminates a stream when another audio frame arrives while inference is busy", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const result = yield* Deferred.make<{ revision: number; text: null }>();
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () =>
              Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(result))),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const running = yield* connection
          .feed({ streamId, sequence: 0, audioBase64: "AAA=" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        expect(
          yield* Effect.result(connection.feed({ streamId, sequence: 1, audioBase64: "AAA=" })),
        ).toMatchObject({ _tag: "Failure" });
        yield* Deferred.succeed(result, { revision: 1, text: null });
        expect(yield* Effect.result(Fiber.join(running))).toMatchObject({ _tag: "Failure" });
        expect(yield* Effect.result(connection.start())).toMatchObject({ _tag: "Success" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("releases the worker if finish races an in-flight feed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const result = yield* Deferred.make<{ revision: number; text: null }>();
      let released = false;
      const speech = speechLayer({
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () =>
                Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(result))),
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
        const { streamId } = yield* connection.start();
        const running = yield* connection
          .feed({ streamId, sequence: 0, audioBase64: "AAA=" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        expect(yield* Effect.result(connection.finish(streamId))).toMatchObject({
          _tag: "Failure",
        });
        expect(released).toBe(true);
        yield* Deferred.succeed(result, { revision: 1, text: null });
        expect(yield* Effect.result(Fiber.join(running))).toMatchObject({ _tag: "Failure" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("releases a stream when finishing inference exceeds thirty seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let released = false;
      const started = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const speech = speechLayer({
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () => Effect.succeed({ revision: 1, text: null }),
              finish: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
            }),
            () =>
              Effect.sync(() => {
                released = true;
              }),
          ),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const running = yield* connection
          .finish(streamId)
          .pipe(Effect.ensuring(Deferred.succeed(done, undefined)), Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("30 seconds");
        expect(yield* Deferred.isDone(done)).toBe(true);
        expect(yield* Effect.result(Fiber.join(running))).toMatchObject({ _tag: "Failure" });
        expect(released).toBe(true);
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("ends the stream when a transcript exceeds one mebibyte", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let released = false;
      const speech = speechLayer({
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () =>
                Effect.succeed({
                  revision: 1,
                  text: { committed: "x".repeat(1_048_577), tentative: "" },
                }),
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
        const { streamId } = yield* connection.start();
        expect(
          yield* Effect.result(connection.feed({ streamId, sequence: 0, audioBase64: "AAA=" })),
        ).toMatchObject({ _tag: "Failure" });
        expect(released).toBe(true);
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("rejects a native preview whose revision moves backwards", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let count = 0;
      let released = false;
      const speech = speechLayer({
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () =>
                Effect.succeed({
                  revision: ++count === 1 ? 2 : 1,
                  text: { committed: "text", tentative: "" },
                }),
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
        const { streamId } = yield* connection.start();
        yield* connection.feed({ streamId, sequence: 0, audioBase64: "AAA=" });
        expect(
          yield* Effect.result(connection.feed({ streamId, sequence: 1, audioBase64: "AAA=" })),
        ).toMatchObject({ _tag: "Failure" });
        expect(released).toBe(true);
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("ends the stream and releases its slot when native inference fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let released = false;
      const speech = speechLayer({
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () =>
                Effect.fail(new SpeechInference.SpeechInferenceError({ cause: "failed" })),
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
        const { streamId } = yield* connection.start();
        const received = yield* Queue.unbounded<unknown>();
        yield* connection.events(streamId).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkChild,
        );
        expect(
          yield* Effect.result(connection.feed({ streamId, sequence: 0, audioBase64: "AAA=" })),
        ).toMatchObject({ _tag: "Failure" });
        expect(released).toBe(true);
        expect(yield* Queue.take(received)).toEqual({ type: "error", code: "failed" });
        expect(yield* Effect.result(connection.start())).toMatchObject({ _tag: "Success" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("does not publish stream failure before the worker is released for batch fallback", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releasing = yield* Deferred.make<void>();
      const allowRelease = yield* Deferred.make<void>();
      const received = yield* Deferred.make<void>();
      const preview = yield* Deferred.make<void>();
      let count = 0;
      const speech = speechLayer({
        startStream: () =>
          Effect.acquireRelease(
            Effect.succeed({
              feed: () =>
                ++count === 1
                  ? Effect.succeed({ revision: 1, text: { committed: "preview", tentative: "" } })
                  : Effect.fail(new SpeechInference.SpeechInferenceError({ cause: "failed" })),
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
        yield* connection.events(streamId).pipe(
          Stream.runForEach((event) =>
            Deferred.succeed(event.type === "partial" ? preview : received, undefined),
          ),
          Effect.forkChild,
        );
        yield* connection.feed({ streamId, sequence: 0, audioBase64: "AAA=" });
        yield* Deferred.await(preview);
        const running = yield* connection
          .feed({ streamId, sequence: 1, audioBase64: "AAA=" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(releasing);
        expect(yield* Deferred.isDone(received)).toBe(false);
        yield* Deferred.succeed(allowRelease, undefined);
        expect(yield* Effect.result(Fiber.join(running))).toMatchObject({ _tag: "Failure" });
        yield* Deferred.await(received);
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("expires a stream when no audio arrives for fifteen seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () => Effect.succeed({ revision: 1, text: null }),
            finish: Effect.succeed(""),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        yield* TestClock.adjust("15 seconds");
        expect(
          yield* Effect.result(connection.feed({ streamId, sequence: 0, audioBase64: "AAA=" })),
        ).toMatchObject({ _tag: "Failure", failure: { code: "expired" } });
      }).pipe(Effect.provide(speech));
    }),
  ),
);

it.effect("finalizes normally at the five-minute recording limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const speech = speechLayer({
        startStream: () =>
          Effect.succeed({
            feed: () => Effect.succeed({ revision: 1, text: null }),
            finish: Effect.succeed("complete"),
          }),
      });
      yield* Effect.gen(function* () {
        const connection = yield* SpeechStreamConnection.make;
        const { streamId } = yield* connection.start();
        const received = yield* Queue.unbounded<unknown>();
        yield* connection.events(streamId).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkChild,
        );
        for (let sequence = 0; sequence < 30; sequence++) {
          yield* connection.feed({ streamId, sequence, audioBase64: "AAA=" });
          yield* TestClock.adjust("10 seconds");
        }
        expect(yield* Queue.take(received)).toEqual({ type: "final", text: "complete" });
      }).pipe(Effect.provide(speech));
    }),
  ),
);
