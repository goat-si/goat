import { describe, expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";

import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RpcAuthorization pull requests", () => {
  it.effect("refuses linked-thread refresh signals to a session without orchestration read", () =>
    Effect.gen(function* () {
      const method = WS_METHODS.pullRequestsSubscribeLinkedThreadRefreshes;
      const denied = yield* Effect.flip(RpcAuthorization.authorizeRpcCall([], method, {}));
      expect(denied.requiredPermission).toBe(AuthOrchestrationReadScope);
      yield* RpcAuthorization.authorizeRpcCall([AuthOrchestrationReadScope], method, {});
    }),
  );
});
