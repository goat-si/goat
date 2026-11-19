// @effect-diagnostics nodeBuiltinImport:off - stream ids use the OS cryptographic source.
import * as NodeCrypto from "node:crypto";
import {
  base64ToUint8Array,
  VOICE_STREAM_MAX_AUDIO_BYTES,
  VOICE_STREAM_MAX_CHUNK_BYTES,
  type SpeechStreamFeed,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SpeechManagement from "./SpeechManagement.ts";

const STREAM_OPERATION_TIMEOUT = "30 seconds";
const STREAM_IDLE_TIMEOUT_MS = 15_000;
const STREAM_MAX_DURATION = "300 seconds";
const STREAM_MAX_TEXT_BYTES = 1024 * 1024;

export class SpeechStreamError extends Schema.TaggedError<SpeechStreamError>()(
  "SpeechStreamError",
  {
    code: Schema.Literals(["busy", "expired", "invalid-audio", "failed"]),
  },
) {}

type Event =
  | {
      readonly type: "partial";
      readonly revision: number;
      readonly committed: string;
      readonly tentative: string;
    }
  | { readonly type: "final"; readonly text: string }
  | { readonly type: "error"; readonly code: "expired" | "failed" | "invalid-audio" | "cancelled" };

type Session = {
  readonly id: string;
  readonly scope: Scope.Closeable;
  readonly timerScope: Scope.Closeable;
  readonly worker: Effect.Success<
    ReturnType<SpeechManagement.SpeechManagement["Service"]["startStream"]>
  >;
  readonly events: Queue.Queue<Event>;
  sequence: number;
  revision: number;
  bytes: number;
  busy: boolean;
  subscribed: boolean;
  lastAudioAt: number;
};

export const make = Effect.gen(function* () {
  const speech = yield* SpeechManagement.SpeechManagement;
  const connectionScope = yield* Scope.Scope;
  let session: Session | undefined;
  let starting = false;
  let closed = false;
  let lastCancelledId: string | undefined;
  const close = Effect.fnUntraced(function* () {
    const current = session;
    session = undefined;
    if (current) {
      yield* Scope.close(current.timerScope, Exit.void);
      yield* Scope.close(current.scope, Exit.void);
    }
  });
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      closed = true;
    }).pipe(Effect.andThen(close())),
  );
  const find = (id: string): Effect.Effect<Session, SpeechStreamError> =>
    session?.id === id
      ? Effect.succeed(session)
      : Effect.fail(new SpeechStreamError({ code: "expired" }));
  const failCurrent = Effect.fnUntraced(function* (
    current: Session,
    code: "expired" | "failed" | "invalid-audio",
  ) {
    if (session !== current) return;
    yield* close();
    yield* Queue.offer(current.events, { type: "error", code });
  });
  const finish = Effect.fn("SpeechStreamConnection.finish")(function* (id: string) {
    const current = yield* find(id);
    if (current.busy) return yield* new SpeechStreamError({ code: "busy" });
    current.busy = true;
    yield* Scope.close(current.timerScope, Exit.void);
    const result = yield* current.worker.finish.pipe(
      Effect.timeout(STREAM_OPERATION_TIMEOUT),
      Effect.result,
      Effect.onInterrupt(() => failCurrent(current, "failed")),
    );
    if (session !== current) return yield* new SpeechStreamError({ code: "expired" });
    if (
      result._tag === "Failure" ||
      typeof result.success !== "string" ||
      Buffer.byteLength(result.success) > STREAM_MAX_TEXT_BYTES
    ) {
      yield* failCurrent(current, "failed");
      return yield* new SpeechStreamError({ code: "failed" });
    }
    yield* close();
    yield* Queue.offer(current.events, { type: "final", text: result.success });
  });
  return {
    start: Effect.fn("SpeechStreamConnection.start")(function* () {
      if (closed) return yield* new SpeechStreamError({ code: "expired" });
      if (starting || session) return yield* new SpeechStreamError({ code: "busy" });
      starting = true;
      const scope = yield* Scope.make();
      const loading = yield* Effect.gen(function* () {
        const changes = yield* speech.configurationChanges;
        const configuration = yield* speech.configuration;
        const worker = yield* speech.startStream();
        return { worker, configuration, changes };
      }).pipe(Scope.provide(scope), Effect.forkIn(connectionScope));
      const result = yield* Fiber.await(loading).pipe(
        Effect.onInterrupt(() =>
          Fiber.interrupt(loading).pipe(
            Effect.andThen(Scope.close(scope, Exit.void)),
            Effect.tap(() =>
              Effect.sync(() => {
                starting = false;
              }),
            ),
          ),
        ),
      );
      starting = false;
      if (Exit.isFailure(result) || closed) {
        yield* Scope.close(scope, Exit.void);
        const failure = Exit.isFailure(result)
          ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
          : undefined;
        return yield* new SpeechStreamError({
          code: failure?.cause === "Speech is busy." ? "busy" : "failed",
        });
      }
      const current: Session = {
        id: NodeCrypto.randomUUID(),
        scope,
        worker: result.value.worker,
        timerScope: yield* Scope.make(),
        events: yield* Queue.sliding<Event>(1),
        sequence: 0,
        revision: -1,
        bytes: 0,
        busy: false,
        subscribed: false,
        lastAudioAt: yield* Clock.currentTimeMillis,
      };
      session = current;
      yield* result.value.changes.pipe(
        Stream.filter(
          (next) =>
            next.modelId !== result.value.configuration.modelId ||
            next.acceleration !== result.value.configuration.acceleration,
        ),
        Stream.take(1),
        Stream.runForEach(() => Effect.forkIn(failCurrent(current, "failed"), connectionScope)),
        Effect.forkIn(current.timerScope),
      );
      const expire = Effect.gen(function* () {
        if (session !== current) return;
        yield* Effect.forkIn(failCurrent(current, "expired"), connectionScope);
      });
      const idle = Effect.fnUntraced(function* (): Effect.fn.Return<void> {
        const now = yield* Clock.currentTimeMillis;
        const remaining = Math.max(0, STREAM_IDLE_TIMEOUT_MS - (now - current.lastAudioAt));
        if (remaining === 0) return yield* expire;
        yield* Effect.sleep(Duration.millis(remaining));
        return yield* idle();
      });
      yield* Effect.forkIn(idle(), current.timerScope);
      yield* Effect.forkIn(
        Effect.sleep(STREAM_MAX_DURATION).pipe(
          Effect.andThen(
            Effect.forkIn(finish(current.id).pipe(Effect.catch(() => expire)), connectionScope),
          ),
        ),
        current.timerScope,
      );
      return { streamId: current.id };
    }),
    feed: Effect.fnUntraced(function* (input: SpeechStreamFeed) {
      const current = yield* find(input.streamId);
      const bytes = base64ToUint8Array(input.audioBase64);
      if (
        !bytes ||
        bytes.byteLength > VOICE_STREAM_MAX_CHUNK_BYTES ||
        bytes.byteLength % 2 ||
        current.bytes + bytes.byteLength > VOICE_STREAM_MAX_AUDIO_BYTES ||
        input.sequence !== current.sequence
      ) {
        yield* failCurrent(current, "invalid-audio");
        return yield* new SpeechStreamError({ code: "invalid-audio" });
      }
      if (current.busy) {
        yield* failCurrent(current, "failed");
        return yield* new SpeechStreamError({ code: "busy" });
      }
      current.busy = true;
      current.sequence++;
      current.bytes += bytes.byteLength;
      current.lastAudioAt = yield* Clock.currentTimeMillis;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const pcm = new Float32Array(bytes.byteLength / 2);
      for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true) / 32768;
      const result = yield* current.worker.feed(pcm).pipe(
        Effect.timeout(STREAM_OPERATION_TIMEOUT),
        Effect.result,
        Effect.onInterrupt(() => failCurrent(current, "failed")),
      );
      current.busy = false;
      if (session !== current) return yield* new SpeechStreamError({ code: "expired" });
      if (result._tag === "Failure") {
        yield* failCurrent(current, "failed");
        return yield* new SpeechStreamError({ code: "failed" });
      }
      if (
        !Number.isSafeInteger(result.success.revision) ||
        result.success.revision < current.revision ||
        (result.success.text !== null &&
          (typeof result.success.text !== "object" ||
            typeof result.success.text.committed !== "string" ||
            typeof result.success.text.tentative !== "string"))
      ) {
        yield* failCurrent(current, "failed");
        return yield* new SpeechStreamError({ code: "failed" });
      }
      current.revision = result.success.revision;
      if (
        result.success.text &&
        Buffer.byteLength(result.success.text.committed) +
          Buffer.byteLength(result.success.text.tentative) >
          STREAM_MAX_TEXT_BYTES
      ) {
        yield* failCurrent(current, "failed");
        return yield* new SpeechStreamError({ code: "failed" });
      }
      if (result.success.text)
        yield* Queue.offer(current.events, {
          type: "partial",
          revision: result.success.revision,
          ...result.success.text,
        });
    }),
    finish,
    events: (id: string) => {
      const lookup = find(id);
      return Stream.unwrap(
        Effect.gen(function* () {
          const current = yield* lookup;
          if (current.subscribed) return yield* new SpeechStreamError({ code: "busy" });
          current.subscribed = true;
          return Stream.fromQueue(current.events).pipe(
            Stream.takeUntil((event) => event.type !== "partial"),
            Stream.ensuring(Effect.suspend(() => (session === current ? close() : Effect.void))),
          );
        }),
      );
    },
    cancel: Effect.fn("SpeechStreamConnection.cancel")(function* (id: string) {
      if (lastCancelledId === id) return;
      const current = yield* find(id);
      lastCancelledId = id;
      yield* close();
      yield* Queue.offer(current.events, { type: "error", code: "cancelled" });
    }),
  };
});
