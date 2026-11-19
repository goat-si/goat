import {
  SPEECH_STREAM_WS_METHODS,
  SpeechStreamRpcError,
  WsSpeechStreamRpcGroup,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as SpeechStreamConnection from "./SpeechStreamConnection.ts";

export const ServerWsSpeechStreamRpcGroup = WsSpeechStreamRpcGroup.middleware(RpcInstrumentation);

export const makeSpeechStreamRpcHandlers = Effect.fn("SpeechStreamRpc.handlers")(function* () {
  const connection = yield* SpeechStreamConnection.make;
  const mapError = (error: SpeechStreamConnection.SpeechStreamError) =>
    new SpeechStreamRpcError({ code: error.code });
  return ServerWsSpeechStreamRpcGroup.of({
    [SPEECH_STREAM_WS_METHODS.start]: ({ locale }) =>
      connection.start(locale?.split("-")[0]).pipe(Effect.mapError(mapError)),
    [SPEECH_STREAM_WS_METHODS.feed]: (input) =>
      connection.feed(input).pipe(Effect.as({}), Effect.mapError(mapError)),
    [SPEECH_STREAM_WS_METHODS.finish]: ({ streamId }) =>
      connection.finish(streamId).pipe(Effect.as({}), Effect.mapError(mapError)),
    [SPEECH_STREAM_WS_METHODS.cancel]: ({ streamId }) =>
      connection.cancel(streamId).pipe(Effect.as({}), Effect.mapError(mapError)),
    [SPEECH_STREAM_WS_METHODS.events]: ({ streamId }) =>
      connection.events(streamId).pipe(Stream.mapError(mapError)),
  });
});
