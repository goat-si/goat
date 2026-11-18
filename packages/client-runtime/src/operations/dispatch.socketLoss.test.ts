import {
  AuthOrchestrationOperateScope,
  CommandId,
  EnvironmentAuthorizationError,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { v2Projection, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import { archiveThread, startThreadTurn } from "./commands.ts";

const layerTestRandom = Layer.succeed(
  SecureRandom.SecureRandom,
  SecureRandom.make((size) => new Uint8Array(size)),
);

const CONNECTED_STATE: SupervisorConnectionState = {
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  phase: "connected",
};

const socketClosed = () =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({
      message: "socket closed",
      cause: new Error("socket closed"),
    }),
  });

// A connected supervisor whose session answers every dispatch; tests swap in a client that loses it.
const makeSupervisor = Effect.fn("TestDispatchSocketLoss.makeSupervisor")(function* (
  commands: OrchestrationV2Command[],
) {
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    [ORCHESTRATION_V2_WS_METHODS.getThreadProjection]: () => Effect.succeed(v2Projection),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        capabilities: { repositoryIdentity: true, serverResolvedCommandContext: true },
      },
    } as never),
    subscribeServerConfig: () => Effect.die("unused") as never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId: EnvironmentId.make("environment-1"),
      label: "Test environment",
      httpBaseUrl: "https://environment.example.test",
      wsBaseUrl: "wss://environment.example.test",
    }),
    state: yield* SubscriptionRef.make(CONNECTED_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

const message = (id: string, resendAfterSocketLoss?: boolean) => ({
  commandId: CommandId.make(`command-${id}`),
  threadId: v2ThreadId,
  message: {
    messageId: MessageId.make(`message-${id}`),
    role: "user" as const,
    text: "hello",
    attachments: [],
  },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
  ...(resendAfterSocketLoss === undefined ? {} : { resendAfterSocketLoss }),
});

describe("message dispatch after socket loss", () => {
  // A dead socket reaches the caller as a protocol error, or as an interrupt when
  // the supervisor closes the session before the protocol reports the error.
  it.effect.each([
    ["protocol error", Effect.fail(socketClosed())],
    ["session close", Effect.failCause(Cause.interrupt())],
  ] as const)("retries a message dispatch lost to a %s with the same command id", ([, loss]) =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const firstAttemptLost = yield* Deferred.make<void>();
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* Deferred.succeed(firstAttemptLost, undefined);
            return yield* loss;
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: lostClient }),
      );

      const sendFiber = yield* startThreadTurn(message("lost-ack")).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttemptLost);
      yield* SubscriptionRef.set(supervisor.session, Option.some(healthySession));
      const exit = yield* Fiber.await(sendFiber);

      expect(commands.map((command) => [command.type, command.commandId])).toEqual([
        ["message.dispatch", "command-lost-ack"],
        ["message.dispatch", "command-lost-ack"],
      ]);
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("stops resending a message whose dispatch keeps losing the socket", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const dyingClient: WsRpcProtocolClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(
              supervisor.session,
              Option.some({ ...healthySession, client: dyingClient }),
            );
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: dyingClient }),
      );

      const error = yield* startThreadTurn(message("socket-killer")).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(commands.map((command) => command.commandId)).toEqual([
        "command-socket-killer",
        "command-socket-killer",
        "command-socket-killer",
      ]);
      expect(error._tag).toBe("RpcClientError");
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("holds a lost message through reconnect backoff until disconnect", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      const send = (resendAfterSocketLoss: boolean) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(
            supervisor.session,
            Option.some({ ...healthySession, client: lostClient }),
          );
          return yield* startThreadTurn(
            message(`host-gone-${resendAfterSocketLoss}`, resendAfterSocketLoss),
          ).pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.flip,
            Effect.forkChild,
          );
        });

      const optedOut = yield* send(false);
      expect((yield* Fiber.join(optedOut))._tag).toBe("RpcClientError");

      const waiting = yield* send(true);
      yield* SubscriptionRef.set(supervisor.state, {
        ...CONNECTED_STATE,
        phase: "backoff" as const,
      });
      yield* TestClock.adjust("2 minutes");
      expect(waiting.pollUnsafe()).toBeUndefined();
      yield* SubscriptionRef.set(supervisor.state, AVAILABLE_CONNECTION_STATE);
      expect((yield* Fiber.join(waiting))._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-host-gone-false",
        "command-host-gone-true",
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect(
    "resends a lost message on the same session when it is still connected after the grace",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const landed = new Set<string>();
        const supervisor = yield* makeSupervisor(commands);
        const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
        const firstAttemptLost = yield* Deferred.make<void>();
        // A frame the client cannot parse fails the pending request; the socket stays open.
        const lossyClient = {
          ...healthySession.client,
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.gen(function* () {
              commands.push(command);
              landed.add(command.commandId);
              if (commands.length > 1) return { sequence: commands.length };
              yield* Deferred.succeed(firstAttemptLost, undefined);
              return yield* socketClosed();
            }),
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(
          supervisor.session,
          Option.some({ ...healthySession, client: lossyClient }),
        );

        const sendFiber = yield* startThreadTurn(message("reply-lost")).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.forkChild,
        );
        yield* Deferred.await(firstAttemptLost);
        yield* TestClock.adjust("5 seconds");

        expect(commands.map((command) => command.commandId)).toEqual([
          "command-reply-lost",
          "command-reply-lost",
        ]);
        expect(landed.size).toBe(1);
        expect(Exit.isSuccess(yield* Fiber.await(sendFiber))).toBe(true);
      }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("does not resend on a session the supervisor cleared inside the grace", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const firstAttemptLost = yield* Deferred.make<void>();
      const dyingClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* Deferred.succeed(firstAttemptLost, undefined);
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: dyingClient }),
      );

      const sendFiber = yield* startThreadTurn(message("session-cleared")).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttemptLost);
      yield* TestClock.adjust("1 minute");
      expect(commands).toHaveLength(1);
      expect(sendFiber.pollUnsafe()).toBeUndefined();

      const replacement = { ...healthySession };
      yield* SubscriptionRef.set(supervisor.session, Option.some(replacement));
      expect(Exit.isSuccess(yield* Fiber.await(sendFiber))).toBe(true);
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-session-cleared",
        "command-session-cleared",
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect(
    "gives up after ten minutes without a session and says the message may not have been sent",
    () =>
      Effect.gen(function* () {
        const commands: OrchestrationV2Command[] = [];
        const supervisor = yield* makeSupervisor(commands);
        const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
        const firstAttemptLost = yield* Deferred.make<void>();
        const dyingClient = {
          ...healthySession.client,
          [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
            Effect.gen(function* () {
              commands.push(command);
              yield* SubscriptionRef.set(supervisor.session, Option.none());
              yield* SubscriptionRef.set(supervisor.state, {
                ...CONNECTED_STATE,
                phase: "backoff" as const,
              });
              yield* Deferred.succeed(firstAttemptLost, undefined);
              return yield* socketClosed();
            }),
        } as unknown as WsRpcProtocolClient;
        yield* SubscriptionRef.set(
          supervisor.session,
          Option.some({ ...healthySession, client: dyingClient }),
        );

        const sendFiber = yield* startThreadTurn(message("asleep")).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.flip,
          Effect.forkChild,
        );
        yield* Deferred.await(firstAttemptLost);
        yield* TestClock.adjust("9 minutes");
        expect(sendFiber.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 minute");

        expect(sendFiber.pollUnsafe()).toBeDefined();
        const error = yield* Fiber.join(sendFiber);
        expect(error._tag).toBe("EnvironmentRpcUnavailableError");
        expect(error.message).toContain("may not have been sent");
        expect(commands).toHaveLength(1);
      }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("interrupts an in-flight resend at ten minutes even if the wall clock rewinds", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const firstAttemptLost = yield* Deferred.make<void>();
      const resendStarted = yield* Deferred.make<void>();
      const resendEnded = yield* Deferred.make<void>();
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            yield* SubscriptionRef.set(supervisor.state, {
              ...CONNECTED_STATE,
              phase: "backoff" as const,
            });
            yield* Deferred.succeed(firstAttemptLost, undefined);
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: lostClient }),
      );

      const send = yield* startThreadTurn(message("slow-resend")).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.forkChild,
      );
      yield* Deferred.await(firstAttemptLost);
      yield* TestClock.adjust("590 seconds");
      yield* TestClock.setTime(0);
      const slowClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* Deferred.succeed(resendStarted, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(resendEnded, undefined))),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: slowClient }),
      );
      yield* Deferred.await(resendStarted);
      yield* TestClock.adjust("9 seconds");
      expect(send.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");

      expect(send.pollUnsafe()).toBeDefined();
      const error = yield* Fiber.join(send).pipe(Effect.flip);
      expect(error._tag).toBe("EnvironmentRpcUnavailableError");
      expect(error.message).toContain("within 10 minutes. It may not have been sent.");
      yield* Deferred.await(resendEnded);
      expect(commands.map((command) => command.commandId)).toEqual([
        "command-slow-resend",
        "command-slow-resend",
      ]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("gives up on a lost message when the connection is blocked", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.none());
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: lostClient }),
      );

      const waiting = yield* startThreadTurn(message("blocked")).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
        Effect.forkChild,
      );
      yield* SubscriptionRef.set(supervisor.state, {
        ...CONNECTED_STATE,
        phase: "blocked" as const,
      });

      expect((yield* Fiber.join(waiting))._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.commandId)).toEqual(["command-blocked"]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("does not resend a message the server refused for authorization", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const refusingClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.sync(() => commands.push(command)).pipe(
            Effect.andThen(
              Effect.fail(
                new EnvironmentAuthorizationError({
                  message: "Not allowed to send.",
                  requiredScope: AuthOrchestrationOperateScope,
                }),
              ),
            ),
          ),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: refusingClient }),
      );

      const error = yield* startThreadTurn(message("denied")).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error._tag).toBe("EnvironmentAuthorizationError");
      expect(commands.map((command) => command.commandId)).toEqual(["command-denied"]);
    }).pipe(Effect.provide(layerTestRandom)),
  );

  it.effect("resends only messages: a thread command lost to the socket fails at once", () =>
    Effect.gen(function* () {
      const commands: OrchestrationV2Command[] = [];
      const supervisor = yield* makeSupervisor(commands);
      const healthySession = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const lostClient = {
        ...healthySession.client,
        [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
          Effect.gen(function* () {
            commands.push(command);
            yield* SubscriptionRef.set(supervisor.session, Option.some(healthySession));
            return yield* socketClosed();
          }),
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        supervisor.session,
        Option.some({ ...healthySession, client: lostClient }),
      );

      const error = yield* archiveThread({
        commandId: CommandId.make("command-archive"),
        threadId: v2ThreadId,
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.flip,
      );

      expect(error._tag).toBe("RpcClientError");
      expect(commands.map((command) => command.type)).toEqual(["thread.archive"]);
    }).pipe(Effect.provide(layerTestRandom)),
  );
});
