import { WS_METHODS, type ServerConfig } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import { refreshVcsBranch, subscribeVcsBranch } from "./client.ts";
import { makeHarness, session } from "./client.testkit.ts";
it.effect.each([true, false])(
  "refreshes branches using the connected server capability (%s)",
  (supported) =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness();
      const inputs: unknown[] = [];
      const client = {
        [supported ? WS_METHODS.vcsRefreshBranch : WS_METHODS.vcsRefreshStatus]: (
          input: unknown,
        ) => {
          inputs.push(input);
          return Effect.void;
        },
      } as unknown as WsRpcProtocolClient;
      yield* SubscriptionRef.set(
        activeSession,
        Option.some({
          ...session(client),
          initialConfig: Effect.succeed({
            environment: { capabilities: supported ? { vcsBranchStatus: true } : {} },
          } as ServerConfig),
        }),
      );
      expect(
        yield* refreshVcsBranch({ cwd: "/repo" }).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        ),
      ).toBeUndefined();
      expect(inputs).toEqual(supported ? [{ cwd: "/repo" }] : []);
    }).pipe(Effect.scoped),
);

it.effect("binds branch capability selection and execution to one session", () =>
  Effect.gen(function* () {
    const { activeSession, supervisor } = yield* makeHarness();
    const configRequested = yield* Deferred.make<void>();
    const config = yield* Deferred.make<ServerConfig>();
    const executed = yield* Deferred.make<void>();
    const original = {
      [WS_METHODS.vcsRefreshBranch]: () =>
        Deferred.succeed(executed, undefined).pipe(Effect.asVoid),
    } as unknown as WsRpcProtocolClient;
    const replacement = {
      [WS_METHODS.vcsRefreshStatus]: () => Effect.succeed({ refName: "replacement" }),
    } as unknown as WsRpcProtocolClient;
    yield* SubscriptionRef.set(
      activeSession,
      Option.some({
        ...session(original),
        initialConfig: Deferred.succeed(configRequested, undefined).pipe(
          Effect.andThen(Deferred.await(config)),
        ),
      }),
    );
    const refresh = yield* refreshVcsBranch({ cwd: "/repo" }).pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.forkChild,
    );
    yield* Deferred.await(configRequested);
    yield* SubscriptionRef.set(activeSession, Option.some(session(replacement)));
    yield* Deferred.succeed(config, {
      environment: { capabilities: { vcsBranchStatus: true } },
    } as ServerConfig);
    expect(yield* Fiber.join(refresh)).toBeUndefined();
    yield* Deferred.await(executed);
  }).pipe(Effect.scoped),
);

it.effect("renegotiates the branch stream after reconnecting to an older server", () =>
  Effect.gen(function* () {
    const { activeSession, supervisor } = yield* makeHarness();
    const values = yield* Queue.unbounded<string | null>();
    const oldInputs: unknown[] = [];
    const legacyClient = {
      [WS_METHODS.subscribeVcsStatus]: (input: unknown) => {
        oldInputs.push(input);
        return Stream.make(
          { _tag: "remoteUpdated", remote: null },
          {
            _tag: "localUpdated",
            local: { refName: "legacy" },
          },
        ).pipe(Stream.concat(Stream.never));
      },
    } as unknown as WsRpcProtocolClient;
    const supportedClient = {
      [WS_METHODS.subscribeVcsBranch]: () =>
        Stream.make({ refName: "modern" }).pipe(Stream.concat(Stream.never)),
    } as unknown as WsRpcProtocolClient;
    const connected = (client: WsRpcProtocolClient, capabilities: object) =>
      Option.some({
        ...session(client),
        initialConfig: Effect.succeed({ environment: { capabilities } } as ServerConfig),
      });
    yield* SubscriptionRef.set(
      activeSession,
      connected(supportedClient, { vcsBranchStatus: true }),
    );
    const subscription = yield* subscribeVcsBranch({ cwd: "/repo" }).pipe(
      Stream.runForEach(({ refName }) => Queue.offer(values, refName)),
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.forkScoped,
    );
    expect(yield* Queue.take(values)).toBe("modern");
    yield* SubscriptionRef.set(activeSession, connected(legacyClient, {}));
    expect(yield* Queue.take(values)).toBe("legacy");
    expect(oldInputs).toEqual([{ cwd: "/repo", includeRemote: false }]);
    yield* Fiber.interrupt(subscription);
  }).pipe(Effect.scoped),
);

it.effect.each([false, true])(
  "uses branch RPCs only when the Hub supports them (%s)",
  (relaySupported) =>
    Effect.gen(function* () {
      const { activeSession, supervisor } = yield* makeHarness();
      const branchCalls: unknown[] = [];
      const legacyCalls: unknown[] = [];
      const client = {
        [WS_METHODS.subscribeVcsBranch]: (input: unknown) => {
          branchCalls.push(input);
          return Stream.make({ refName: "branch", isRepo: true });
        },
        [WS_METHODS.vcsRefreshBranch]: (input: unknown) =>
          Effect.sync(() => {
            branchCalls.push(input);
          }),
        [WS_METHODS.subscribeVcsStatus]: (input: unknown) => {
          legacyCalls.push(input);
          return Stream.make({ _tag: "localUpdated", local: { refName: "branch", isRepo: true } });
        },
      } as unknown as WsRpcProtocolClient;
      const proxiedSession = {
        ...session(client),
        vcsBranchTransportSupported: relaySupported,
        initialConfig: Effect.succeed({
          environment: { capabilities: { vcsBranchStatus: true } },
        } as ServerConfig),
      };
      yield* SubscriptionRef.set(activeSession, Option.some(proxiedSession));
      const provide = Effect.provideService(
        EnvironmentSupervisor.EnvironmentSupervisor,
        supervisor,
      );
      expect(yield* Stream.runHead(subscribeVcsBranch({ cwd: "/repo" })).pipe(provide)).toEqual(
        Option.some({ refName: "branch", isRepo: true }),
      );
      yield* refreshVcsBranch({ cwd: "/repo" }).pipe(provide);
      expect(branchCalls).toEqual(relaySupported ? [{ cwd: "/repo" }, { cwd: "/repo" }] : []);
      expect(legacyCalls).toEqual(relaySupported ? [] : [{ cwd: "/repo", includeRemote: false }]);
    }).pipe(Effect.scoped),
);
