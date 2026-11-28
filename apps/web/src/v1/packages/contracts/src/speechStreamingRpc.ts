import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  SPEECH_STREAM_WS_METHODS,
  SpeechStreamEvent,
  SpeechStreamFeed,
  SpeechStreamId,
  SpeechStreamRpcError,
  SpeechStreamStart,
} from "./voice.ts";

const errors = Schema.Union([SpeechStreamRpcError, EnvironmentAuthorizationError]);
const empty = Schema.Struct({});

export const SpeechStreamRpcs = RpcGroup.make(
  Rpc.make(SPEECH_STREAM_WS_METHODS.start, {
    payload: SpeechStreamStart,
    success: SpeechStreamId,
    error: errors,
  }),
  Rpc.make(SPEECH_STREAM_WS_METHODS.feed, {
    payload: SpeechStreamFeed,
    success: empty,
    error: errors,
  }),
  Rpc.make(SPEECH_STREAM_WS_METHODS.finish, {
    payload: SpeechStreamId,
    success: empty,
    error: errors,
  }),
  Rpc.make(SPEECH_STREAM_WS_METHODS.cancel, {
    payload: SpeechStreamId,
    success: empty,
    error: errors,
  }),
  Rpc.make(SPEECH_STREAM_WS_METHODS.events, {
    payload: SpeechStreamId,
    success: SpeechStreamEvent,
    error: errors,
    stream: true,
  }),
);
