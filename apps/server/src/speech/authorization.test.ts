import { expect, it } from "@effect/vitest";
import {
  AuthSettingsWriteScope,
  AuthVoiceManageScope,
  DEFAULT_SPEECH_CONFIGURATION,
  WS_METHODS,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

it.effect("settings RPC requires voice management authority for speech configuration", () =>
  Effect.gen(function* () {
    const input = { patch: { speech: DEFAULT_SPEECH_CONFIGURATION } };
    const denied = yield* Effect.flip(
      RpcAuthorization.authorizeRpcCall(
        [AuthSettingsWriteScope],
        WS_METHODS.serverUpdateSettings,
        input,
      ),
    );
    expect(denied.requiredPermission).toBe(AuthVoiceManageScope);
    yield* RpcAuthorization.authorizeRpcCall(
      [AuthVoiceManageScope],
      WS_METHODS.serverUpdateSettings,
      input,
    );
  }),
);
