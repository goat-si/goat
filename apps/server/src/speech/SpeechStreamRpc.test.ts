import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  DEFAULT_SPEECH_CONFIGURATION,
  SPEECH_STREAM_WS_METHODS,
  WsRpcGroup,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as SpeechManagement from "./SpeechManagement.ts";
import { makeSpeechStreamRpcHandlers, ServerWsSpeechStreamRpcGroup } from "./SpeechStreamRpc.ts";

it.effect("authorizes and routes live audio and terminal text through the RPC group", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const received = yield* Queue.unbounded<unknown>();
      const subscribed = yield* Deferred.make<void>();
      let language: string | undefined;
      const speech = Layer.mock(SpeechManagement.SpeechManagement)({
        configuration: Effect.succeed(DEFAULT_SPEECH_CONFIGURATION),
        configurationChanges: Effect.succeed(Stream.never),
        startStream: (value) =>
          Effect.sync(() => {
            language = value;
            return {
              feed: () =>
                Effect.succeed({ revision: 1, text: { committed: "hello", tentative: "" } }),
              finish: Effect.succeed("hello"),
            };
          }),
      });
      const handlers = yield* makeSpeechStreamRpcHandlers().pipe(Effect.provide(speech));
      const layer = Layer.mergeAll(
        ServerWsSpeechStreamRpcGroup.toLayer(handlers),
        RpcAuthorization.layer([AuthOrchestrationOperateScope]),
        Layer.succeed(RpcInstrumentation)((effect) => effect),
      );
      const client = yield* RpcTest.makeClient(ServerWsSpeechStreamRpcGroup).pipe(
        Effect.provide(layer),
      );
      const { streamId } = yield* client[SPEECH_STREAM_WS_METHODS.start]({ locale: "ko-KR" });
      expect(language).toBe("ko");
      yield* client[SPEECH_STREAM_WS_METHODS.events]({ streamId }).pipe(
        Stream.runForEach((event) =>
          Queue.offer(received, event).pipe(
            Effect.tap(() => Deferred.succeed(subscribed, undefined)),
          ),
        ),
        Effect.forkChild,
      );
      yield* client[SPEECH_STREAM_WS_METHODS.feed]({ streamId, sequence: 0, audioBase64: "AAA=" });
      yield* Deferred.await(subscribed);
      expect(yield* Queue.take(received)).toEqual({
        type: "partial",
        revision: 1,
        committed: "hello",
        tentative: "",
      });
      yield* client[SPEECH_STREAM_WS_METHODS.finish]({ streamId });
      expect(yield* Queue.take(received)).toEqual({ type: "final", text: "hello" });
    }),
  ),
);

it.effect("requires operate authority for each live speech operation", () =>
  Effect.gen(function* () {
    for (const method of [
      "speech.stream.start",
      "speech.stream.feed",
      "speech.stream.finish",
      "speech.stream.cancel",
      "speech.stream.events",
    ] as const) {
      expect(WsRpcGroup.requests.has(method)).toBe(true);
      const denied = yield* Effect.flip(RpcAuthorization.authorizeRpcCall([], method, {}));
      expect(denied.requiredPermission).toBe(AuthOrchestrationOperateScope);
      yield* RpcAuthorization.authorizeRpcCall([AuthOrchestrationOperateScope], method, {});
    }
  }),
);
