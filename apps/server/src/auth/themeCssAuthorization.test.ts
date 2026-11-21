import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, WS_METHODS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import {
  AuthorizedWsRpcGroup as WsRpcGroup,
  RPC_REQUIRED_SCOPES as BASE_RPC_REQUIRED_SCOPES,
  MEMORY_RPC_REQUIRED_SCOPES,
  HUB_NODES_RPC_REQUIRED_SCOPES,
} from "./RpcAuthorization.ts";

const RPC_REQUIRED_SCOPES = {
  ...BASE_RPC_REQUIRED_SCOPES,
  ...MEMORY_RPC_REQUIRED_SCOPES,
  ...HUB_NODES_RPC_REQUIRED_SCOPES,
};

it.effect("requires an orchestration read grant before validating theme CSS", () =>
  Effect.gen(function* () {
    const method = WS_METHODS.themeValidateCss;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(method, () =>
            Effect.sync(() => {
              handled = true;
              return { css: "" };
            }),
          ),
          RpcAuthorization.layer([]),
        ),
      ),
    );
    expect(yield* client[method]({ css: "" }).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationReadScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);
