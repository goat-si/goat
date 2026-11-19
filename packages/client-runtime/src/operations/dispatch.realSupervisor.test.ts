import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";

import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ConnectionDriver from "../connection/driver.ts";
import type { ConnectionTransientError } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  PREPARED_CONNECTION,
  TARGET,
  awaitState,
  makeHarness,
  transient,
} from "../connection/supervisorTestSupport.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { startThreadTurn } from "./commands.ts";

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
  enabled: true,
};

const layerTestRandom = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => new Uint8Array(size)),
);

describe("message dispatch on the real supervisor", () => {
  it.effect("a socket that dies under a message resends it once on the replacement session", () =>
    Effect.gen(function* () {
      const dispatched: Array<readonly [session: number, commandId: string]> = [];
      const firstAttemptLost = yield* Deferred.make<void>();
      let sessions = 0;
      // Like RpcClient: the dying socket fails the pending request, then the session closes.
      const driver = ConnectionDriver.ConnectionDriver.of({
        connect: (_entry, reportProgress) =>
          Effect.gen(function* () {
            const session = ++sessions;
            yield* reportProgress({ stage: "preparing" });
            yield* reportProgress({ stage: "opening", prepared: PREPARED_CONNECTION });
            const closed = yield* Deferred.make<never, ConnectionTransientError>();
            const client = {
              [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
                Effect.gen(function* () {
                  dispatched.push([session, command.commandId]);
                  if (session > 1) return { sequence: dispatched.length };
                  yield* Deferred.fail(closed, transient("Socket closed.")).pipe(Effect.forkDetach);
                  yield* Deferred.succeed(firstAttemptLost, undefined);
                  return yield* new RpcClientError.RpcClientError({
                    reason: new RpcClientError.RpcClientDefect({
                      message: "socket closed",
                      cause: new Error("socket closed"),
                    }),
                  });
                }),
              [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () => Effect.succeed(v2Projection),
            } as unknown as WsRpcProtocolClient;
            const rpcSession: RpcSession.RpcSession = {
              client,
              initialConfig: Effect.succeed({
                environment: {
                  capabilities: { repositoryIdentity: true, serverResolvedCommandContext: true },
                },
              } as never),
              subscribeServerConfig: () => Stream.never,
              ready: Effect.void,
              probe: Effect.void,
              inboundFrames: Effect.succeed(0),
              closed: Deferred.await(closed),
            };
            yield* reportProgress({ stage: "synchronizing", prepared: PREPARED_CONNECTION });
            return {
              prepared: PREPARED_CONNECTION,
              session: rpcSession,
              openProbeSocket: Effect.fail(transient()),
              refusedRouteIds: [],
            } satisfies ConnectionDriver.EnvironmentConnectionLease;
          }),
        checkHost: () => Effect.succeed("unchecked" as const),
        checkRoute: () => Effect.succeed("unchecked" as const),
        preflight: () => Effect.succeed(false),
      });
      const harness = yield* makeHarness({ random: 0.25 });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(ConnectionDriver.ConnectionDriver, driver),
        Effect.provide(harness.dependencies),
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      const send = yield* startThreadTurn({
        commandId: CommandId.make("command-real-supervisor"),
        threadId: v2ThreadId,
        message: {
          messageId: MessageId.make("message-real-supervisor"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttemptLost);
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("30 seconds");

      expect(Exit.isSuccess(yield* Fiber.await(send))).toBe(true);
      expect(dispatched).toEqual([
        [1, "command-real-supervisor"],
        [2, "command-real-supervisor"],
      ]);
    }).pipe(Effect.provide(Layer.merge(layerTestRandom, TestClock.layer()))),
  );
});
