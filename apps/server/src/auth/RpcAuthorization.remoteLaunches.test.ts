import { describe, expect, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  REMOTE_LAUNCHES_WS_METHODS,
} from "@goat/contracts";

import { requiredScopeForRpcMethod } from "./RpcAuthorization.ts";

describe("remote launch RPC scopes", () => {
  it("lets readers list remote launches and only operators stop following one", () => {
    expect(requiredScopeForRpcMethod(REMOTE_LAUNCHES_WS_METHODS.list)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(REMOTE_LAUNCHES_WS_METHODS.dismiss)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
});
