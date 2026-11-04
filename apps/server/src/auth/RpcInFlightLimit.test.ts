import { describe, expect, it } from "@effect/vitest";
import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  RpcScopeAuthorization,
  WS_METHODS,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcServer from "effect/rpc/RpcServer";

import { WS_RPC_SERVER_OPTIONS } from "../ws.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

const Group = RpcGroup.make(
  Rpc.make(WS_METHODS.serverProbe, { success: Schema.Number, payload: { n: Schema.Number } }),
  Rpc.make(WS_METHODS.subscribeResourceTelemetry, { success: Schema.Number, stream: true }),
).middleware(RpcScopeAuthorization);
type GroupRpcs = RpcGroup.Rpcs<typeof Group>;

describe("RPC in-flight limit", () => {
  it.effect(
    "rejects unary requests past the per-connection limit alone, while streams and later requests still run",
    () =>
      Effect.gen(function* () {
        const started = yield* Queue.unbounded<number>();
        const gate = yield* Deferred.make<void>();
        let client!: Effect.Success<
          ReturnType<typeof RpcClient.makeNoSerialization<GroupRpcs, never>>
        >;
        const server = yield* RpcServer.makeNoSerialization(Group, {
          ...WS_RPC_SERVER_OPTIONS,
          onFromServer: (response) => client.write(response),
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Group.toLayer({
                [WS_METHODS.serverProbe]: ({ n }) =>
                  Queue.offer(started, n).pipe(
                    Effect.andThen(n < 0 ? Deferred.await(gate) : Effect.void),
                    Effect.as(n),
                  ),
                [WS_METHODS.subscribeResourceTelemetry]: () => Stream.make(1, 2),
              }),
              RpcAuthorization.layer(
                [AuthOrchestrationReadScope, AuthDiagnosticsReadScope],
                undefined,
                2,
              ),
            ),
          ),
        );
        client = yield* RpcClient.makeNoSerialization(Group, {
          supportsAck: true,
          onFromClient: ({ message }) => server.write(0, message),
        });
        const rpc = client.client;

        const blocked = yield* Effect.forEach([-1, -2], (n) =>
          Effect.forkChild(rpc[WS_METHODS.serverProbe]({ n })),
        );
        yield* Queue.take(started);
        yield* Queue.take(started);

        const rejected = yield* Effect.exit(rpc[WS_METHODS.serverProbe]({ n: 3 }));
        expect(Exit.isFailure(rejected) && Cause.squash(rejected.cause)).toMatchObject({
          _tag: "RpcRequestLimitError",
          limit: 2,
        });
        expect(yield* rpc[WS_METHODS.subscribeResourceTelemetry]().pipe(Stream.runCollect)).toEqual(
          [1, 2],
        );

        yield* Deferred.succeed(gate, undefined);
        expect(yield* Fiber.joinAll(blocked)).toEqual([-1, -2]);
        expect(yield* rpc[WS_METHODS.serverProbe]({ n: 4 })).toBe(4);
      }).pipe(Effect.scoped),
  );
});
