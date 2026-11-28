import { expect, it } from "@effect/vitest";
import { AuthAccessWriteScope, AuthOrchestrationReadScope, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as RpcAuthorization from "./RpcAuthorization.ts";

it.effect("requires access and orchestration read to create guest links", () =>
  Effect.gen(function* () {
    const method = WS_METHODS.guestShareCreate;
    const denied = yield* Effect.flip(
      RpcAuthorization.authorizeRpcCall([AuthAccessWriteScope], method, {}),
    );
    expect(denied.requiredPermission).toBe(AuthOrchestrationReadScope);
    yield* RpcAuthorization.authorizeRpcCall(
      [AuthAccessWriteScope, AuthOrchestrationReadScope],
      method,
      {},
    );
  }),
);
