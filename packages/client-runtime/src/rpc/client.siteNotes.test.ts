import { type ServerConfig, EnvironmentId, WS_METHODS } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "./session.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import { requestGuarded, EnvironmentRpcUnavailableError, RpcPermissionGuard } from "./client.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

const makeHarness = Effect.fn("TestEnvironmentRpc.makeHarness")(function* (
  target: EnvironmentSupervisor.EnvironmentSupervisor["Service"]["target"] = TARGET,
) {
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE);
  const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.none(),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  const retryCount = yield* Ref.make(0);
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state,
    session: activeSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  return {
    activeSession,
    retryCount,
    supervisor,
  };
});

describe("site notes RPC", () => {
  it.effect("rejects site notes without the advertised capability before dispatch", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      let invoked = false;
      const client = {
        [WS_METHODS.siteNotesList]: () => {
          invoked = true;
          return Effect.succeed([]);
        },
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        h.activeSession,
        Option.some({
          ...session(client),
          initialConfig: Effect.succeed({
            environment: { capabilities: { memory: { protocolVersion: 1 } } },
          } as ServerConfig),
        }),
      );
      const result = yield* requestGuarded(WS_METHODS.siteNotesList, {}).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, h.supervisor),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        Effect.exit,
      );
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        expect(Cause.squash(result.cause)).toBeInstanceOf(EnvironmentRpcUnavailableError);
      }
      expect(invoked).toBe(false);
    }),
  );
});
