import { EnvironmentId, WS_METHODS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import { isHubMachinesUnsupportedError, isHubNodesUnsupportedError } from "../hubNodes.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type * as RpcSession from "./session.ts";
import { EnvironmentRpcUnavailableError, requestGuarded, RpcPermissionGuard } from "./client.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("older-hub"),
  label: "Older hub",
  httpBaseUrl: "https://hub.example.test",
  wsBaseUrl: "wss://hub.example.test",
});

const supervisorFor = Effect.fn("TestOlderHub.supervisor")(function* (client: WsRpcProtocolClient) {
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.make(0).pipe(Effect.asVoid),
  });
});

describe("environment RPC against an older hub", () => {
  it.effect(
    "a hub without disposable machines answers hub.machines.* as unavailable, not a defect",
    () =>
      Effect.gen(function* () {
        const client = {
          [WS_METHODS.hubMachinesList]: () => Effect.die("Unknown request tag: hub.machines.list"),
        } as unknown as WsRpcProtocolClient;
        const result = yield* requestGuarded(WS_METHODS.hubMachinesList, {}).pipe(
          Effect.provideService(
            EnvironmentSupervisor.EnvironmentSupervisor,
            yield* supervisorFor(client),
          ),
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
          Effect.exit,
        );
        expect(Exit.isFailure(result) && Cause.hasDies(result.cause)).toBe(false);
        const failure = Exit.isFailure(result) ? Cause.squash(result.cause) : undefined;
        expect(failure).toBeInstanceOf(EnvironmentRpcUnavailableError);
        expect(isHubMachinesUnsupportedError(failure)).toBe(true);
        expect(isHubNodesUnsupportedError(failure)).toBe(false);
      }),
  );
});
