import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  WS_METHODS,
  type ServerConfig,
  type ServerSelfUpdateInput,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type { RpcSession } from "./session.ts";
import { requestGuarded, RpcPermissionGuard } from "./client.ts";

it.effect("sends stage-only only to the connection that advertises server update staging", () =>
  Effect.gen(function* () {
    const requests: boolean[] = [];
    const target = new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("staging-environment"),
      label: "Stage test",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    });
    const client = {
      [WS_METHODS.serverUpdateServer]: (input: ServerSelfUpdateInput) =>
        Effect.sync(() => {
          requests.push(input.stageOnly === true);
          return { targetVersion: input.targetVersion, method: "boot-service" as const };
        }),
    };
    const connection = (supportsStaging: boolean): RpcSession => ({
      client: client as unknown as WsRpcProtocolClient,
      initialConfig: Effect.succeed({
        environment: { capabilities: supportsStaging ? { serverUpdateStaging: true } : {} },
      } as ServerConfig),
      ready: Effect.void,
      probe: Effect.void,
      inboundFrames: Effect.succeed(0),
      closed: Effect.never,
      subscribeServerConfig: () => {
        throw new Error("Unexpected subscription");
      },
    });
    const session = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
      Option.some(connection(false)),
    );
    const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
      AVAILABLE_CONNECTION_STATE,
    );
    const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
    const supervisor = Layer.succeed(EnvironmentSupervisor, {
      target,
      session,
      state,
      prepared,
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const call = (
      input: Parameters<WsRpcProtocolClient[typeof WS_METHODS.serverUpdateServer]>[0],
    ) =>
      requestGuarded(WS_METHODS.serverUpdateServer, input).pipe(
        Effect.provide(supervisor),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
      );

    const denied = yield* call({ targetVersion: "1.1.0", stageOnly: true }).pipe(Effect.flip);
    expect(denied._tag).toBe("EnvironmentRpcUnavailableError");
    expect(requests).toEqual([]);
    yield* call({ targetVersion: "1.1.0" });
    yield* SubscriptionRef.set(session, Option.some(connection(true)));
    yield* call({ targetVersion: "1.1.0", stageOnly: true });
    expect(requests).toEqual([false, true]);
  }),
);
