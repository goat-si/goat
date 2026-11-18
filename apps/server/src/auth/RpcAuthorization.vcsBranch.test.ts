import { expect, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, WS_METHODS, WsRpcGroup } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import { RPC_REQUIRED_SCOPES } from "./RpcAuthorization.ts";

it.effect.each([
  WS_METHODS.subscribeVcsBranch,
  WS_METHODS.subscribeVcsStatus,
  WS_METHODS.vcsRefreshBranch,
] as const)("enforces read permission on %s", (method) =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          | typeof WS_METHODS.subscribeVcsBranch
          | typeof WS_METHODS.subscribeVcsStatus
          | typeof WS_METHODS.vcsRefreshBranch
        > =>
          tag !== WS_METHODS.subscribeVcsBranch &&
          tag !== WS_METHODS.subscribeVcsStatus &&
          tag !== WS_METHODS.vcsRefreshBranch,
      ),
    );
    let handled = 0;
    const handlers = Layer.mergeAll(
      group.toLayerHandler(WS_METHODS.subscribeVcsBranch, () =>
        Stream.fromEffect(
          Effect.sync(() => {
            handled++;
            return { refName: "main" };
          }),
        ),
      ),
      group.toLayerHandler(WS_METHODS.subscribeVcsStatus, () =>
        Stream.fromEffect(
          Effect.sync(() => {
            handled++;
          }),
        ).pipe(Stream.drain),
      ),
      group.toLayerHandler(WS_METHODS.vcsRefreshBranch, () =>
        Effect.sync(() => {
          handled++;
        }),
      ),
    );
    const denied = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([]))),
    );
    const call = (client: typeof denied) => {
      const input = { cwd: "/repo" };
      if (method === WS_METHODS.vcsRefreshBranch) return client[method](input);
      const response = client[method](input);
      const stream: Stream.Stream<unknown, Stream.Error<typeof response>> = response;
      return Stream.runDrain(stream);
    };
    expect(yield* call(denied).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthOrchestrationReadScope,
    });
    expect(handled).toBe(0);
    const granted = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(Layer.merge(handlers, RpcAuthorization.layer([AuthOrchestrationReadScope]))),
    );
    yield* call(granted);
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);
