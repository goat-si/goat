import { expect, it } from "@effect/vitest";
import { SPEECH_STREAM_WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { PREPARED } from "./sessionTestFixtures.ts";
import {
  awaitRequest,
  awaitSocket,
  completeInitialConfig,
  encodeJson,
  ENCODED_SERVER_CONFIG,
  makeFactory,
} from "./sessionTestHarness.ts";

it.effect("transports ordered speech frames and transcript events on one websocket session", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const ready = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();
      yield* completeInitialConfig(socket, { ...ENCODED_SERVER_CONFIG, speechStreamingV1: true });
      yield* Fiber.join(ready);
      expect((yield* session.initialConfig).speechStreamingV1).toBe(true);

      const starting = yield* session.client[SPEECH_STREAM_WS_METHODS.start]({ locale: "en" }).pipe(
        Effect.forkChild,
      );
      const start = yield* awaitRequest(socket, 1);
      expect(start.tag).toBe(SPEECH_STREAM_WS_METHODS.start);
      socket.serverMessage(
        encodeJson({
          _tag: "Exit",
          requestId: start.id,
          exit: { _tag: "Success", value: { streamId: "fixture" } },
        }),
      );
      const { streamId } = yield* Fiber.join(starting);

      const listening = yield* session.client[SPEECH_STREAM_WS_METHODS.events]({ streamId }).pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      const events = yield* awaitRequest(socket, 2);
      socket.serverMessage(
        encodeJson({ _tag: "Chunk", requestId: events.id, values: [{ type: "ready" }] }),
      );

      const feeding = yield* session.client[SPEECH_STREAM_WS_METHODS.feed]({
        streamId,
        sequence: 0,
        audioBase64: "AAA=",
      }).pipe(Effect.forkChild);
      const feed = yield* awaitRequest(socket, 3);
      expect(feed).toMatchObject({
        tag: SPEECH_STREAM_WS_METHODS.feed,
        payload: { streamId, sequence: 0, audioBase64: "AAA=" },
      });
      socket.serverMessage(
        encodeJson({
          _tag: "Chunk",
          requestId: events.id,
          values: [{ type: "partial", revision: 1, committed: "hello", tentative: " world" }],
        }),
      );
      socket.serverMessage(
        encodeJson({ _tag: "Exit", requestId: feed.id, exit: { _tag: "Success", value: {} } }),
      );
      yield* Fiber.join(feeding);

      const finishing = yield* session.client[SPEECH_STREAM_WS_METHODS.finish]({ streamId }).pipe(
        Effect.forkChild,
      );
      const finish = yield* awaitRequest(socket, 4);
      socket.serverMessage(
        encodeJson({
          _tag: "Chunk",
          requestId: events.id,
          values: [{ type: "final", text: "hello world" }],
        }),
      );
      socket.serverMessage(
        encodeJson({ _tag: "Exit", requestId: finish.id, exit: { _tag: "Success", value: {} } }),
      );
      yield* Fiber.join(finishing);
      expect(Array.from(yield* Fiber.join(listening))).toEqual([
        { type: "ready" },
        { type: "partial", revision: 1, committed: "hello", tentative: " world" },
        { type: "final", text: "hello world" },
      ]);
    }),
  ),
);

it.effect("ends the live transcript when its websocket disconnects", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { factory, sockets } = yield* makeFactory();
      const session = yield* factory.connect(PREPARED);
      const ready = yield* Effect.forkChild(session.ready);
      const socket = yield* awaitSocket(sockets);
      socket.open();
      yield* completeInitialConfig(socket, { ...ENCODED_SERVER_CONFIG, speechStreamingV1: true });
      yield* Fiber.join(ready);
      const listening = yield* session.client[SPEECH_STREAM_WS_METHODS.events]({
        streamId: "fixture",
      }).pipe(Stream.runCollect, Effect.exit, Effect.forkChild);
      const events = yield* awaitRequest(socket, 1);
      socket.serverMessage(
        encodeJson({ _tag: "Chunk", requestId: events.id, values: [{ type: "ready" }] }),
      );
      socket.close(1012, "restart");
      expect((yield* Fiber.join(listening))._tag).toBe("Failure");
      expect(sockets).toHaveLength(1);
    }),
  ),
);
