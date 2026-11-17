import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, ORCHESTRATION_V2_WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { authorizeRpcCall } from "./RpcAuthorization.ts";

it.effect("requires orchestration read for family title lookups", () =>
  Effect.gen(function* () {
    const method = ORCHESTRATION_V2_WS_METHODS.getThreadFamily;
    const input = { threadId: "root", lookupThreadIds: ["fork"] };
    const denied = yield* Effect.flip(authorizeRpcCall([], method, input));
    expect(denied.requiredPermission).toBe(AuthOrchestrationReadScope);
    yield* authorizeRpcCall([AuthOrchestrationReadScope], method, input);
  }),
);

it.effect("requires orchestration read for thread link lookups", () =>
  Effect.gen(function* () {
    const method = ORCHESTRATION_V2_WS_METHODS.getThreadFamily;
    const input = { threadId: "linked", lookupThreadIds: ["linked"], lookupOnly: true };
    const denied = yield* Effect.flip(authorizeRpcCall([], method, input));
    expect(denied.requiredPermission).toBe(AuthOrchestrationReadScope);
    yield* authorizeRpcCall([AuthOrchestrationReadScope], method, input);
  }),
);
