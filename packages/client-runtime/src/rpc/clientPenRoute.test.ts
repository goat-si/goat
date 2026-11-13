import {
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PenConnectionTarget,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import type * as RpcSession from "./session.ts";
import { requestGuarded } from "./client.ts";

const environmentId = EnvironmentId.make("environment-1");

it.effect(
  "a call the member's proxy policy refuses is not sent while the lease in use is a Pen route",
  () =>
    Effect.gen(function* () {
      let sent = false;
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: () =>
          Effect.sync(() => {
            sent = true;
            return { sequence: 1 };
          }),
      } as unknown as WsRpcProtocolClient;
      const pen = new PenConnectionTarget({
        environmentId,
        label: "Pen",
        connectionId: "pen:mesh:node",
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        // The entry's own target is direct: the route in use decides.
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Test environment",
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
          Option.some({
            client,
            initialConfig: Effect.never,
            subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
            ready: Effect.void,
            probe: Effect.void,
            inboundFrames: Effect.succeed(0),
            closed: Effect.never,
          }),
        ),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            environmentId,
            label: pen.label,
            target: pen,
            httpBaseUrl: "http://127.0.0.1/",
            socketUrl: "ws://127.0.0.1/ws",
            httpAuthorization: null,
          }),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const error = yield* requestGuarded(ORCHESTRATION_V2_WS_METHODS.dispatchCommand, {
        type: "thread.delete",
        commandId: CommandId.make("c-delete"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );
      expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
      expect(sent).toBe(false);
    }),
);
