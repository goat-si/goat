import {
  AuthSettingsWriteScope,
  EnvironmentId,
  ServerSelfUpdateError,
  type AuthSessionState,
  type ServerConfig,
  WS_METHODS,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { RpcClientError } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { recordSessionPublished } from "../connection/sessionPublication.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  type matchesServerUpdateReadyEvent,
  createServerEnvironmentAtoms,
  serverUpdateStateAtom,
} from "./server.ts";

vi.mock("./session.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session.ts")>();
  return {
    ...actual,
    createEnvironmentSessionAtoms: (
      ...args: Parameters<typeof actual.createEnvironmentSessionAtoms>
    ) => ({ ...actual.createEnvironmentSessionAtoms(...args), sessionStateAtom: sessions }),
  };
});
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState>>(AsyncResult.initial()),
);

type ReadyEvent = Parameters<typeof matchesServerUpdateReadyEvent>[1];

const socketLoss = () =>
  new RpcClientError.RpcClientError({ reason: new Socket.SocketCloseError({ code: 1006 }) });

const ready = (serverVersion: string) =>
  ({
    version: 1,
    sequence: 1,
    type: "ready",
    payload: { at: "2026-09-01T00:00:00.000Z", environment: { serverVersion } },
  }) as ReadyEvent;

type UpdateProgress = { readonly type: "progress"; readonly stage: "downloading" };
type UpdateFailure = RpcClientError.RpcClientError | ServerSelfUpdateError;

/**
 * An update whose request on the first session loses its socket after accepting, as a server
 * restarting itself does. Later sessions reject the request outright, so a request that should
 * not have been sent fails quickly instead of waiting for a restart.
 */
const makeHarness = Effect.fn("TestServerUpdateSession.makeHarness")(function* (
  name: string,
  settingsWrite: Effect.Effect<never, RpcClientError.RpcClientError> = Effect.never,
) {
  const environmentId = EnvironmentId.make(name);
  const target = new PrimaryConnectionTarget({
    environmentId,
    label: name,
    httpBaseUrl: "https://environment.example.test",
    wsBaseUrl: "wss://environment.example.test",
  });
  const observing = yield* Deferred.make<void>();
  const readyEvents = yield* Queue.unbounded<ReadyEvent>();
  const updateRequests: Array<string> = [];
  const config = {
    availableEditors: [],
    issues: [],
    keybindings: {},
    keybindingsConfigPath: null,
    observability: null,
    providers: [],
    settings: {},
    environment: {
      serverVersion: "0.0.30",
      capabilities: { serverSelfUpdate: "boot-service", serverSelfUpdateProgress: true },
    },
  } as unknown as ServerConfig;
  const client = (label: string, publication: number) => {
    const outcome: Stream.Stream<UpdateProgress, UpdateFailure> =
      publication === 1
        ? Stream.succeed<UpdateProgress>({ type: "progress", stage: "downloading" }).pipe(
            Stream.concat(Stream.fail(socketLoss())),
          )
        : Stream.fail(new ServerSelfUpdateError({ reason: "Not expected on this session." }));
    return {
      [WS_METHODS.subscribeServerConfig]: () => Stream.never,
      [WS_METHODS.subscribeServerLifecycle]: () =>
        Stream.fromEffect(Deferred.succeed(observing, undefined)).pipe(
          Stream.drain,
          Stream.concat(Stream.fromQueue(readyEvents)),
        ),
      [WS_METHODS.serverUpdateServerWithProgress]: () =>
        Stream.fromEffect(Effect.sync(() => updateRequests.push(label))).pipe(
          Stream.drain,
          Stream.concat(outcome),
        ),
      [WS_METHODS.serverUpdateSettings]: () => settingsWrite,
    } as unknown as WsRpcProtocolClient;
  };
  const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
  let publications = 0;
  const publish = (label: string) =>
    Effect.suspend(() => {
      const rpcClient = client(label, ++publications);
      const next: RpcSession = {
        client: rpcClient,
        initialConfig: Effect.succeed(config),
        subscribeServerConfig: (input) => rpcClient.subscribeServerConfig(input ?? {}),
        ready: Effect.void,
        probe: Effect.void,
        inboundFrames: Effect.succeed(0),
        closed: Effect.never,
      };
      recordSessionPublished(environmentId, next);
      return SubscriptionRef.set(session, Option.some(next));
    });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
    _id,
    stream,
  ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run,
        runStream,
        followStream: runStream,
        stateChanges: () => Stream.never,
        retryNow: () => Effect.void,
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(Persistence.EnvironmentCacheStore, {
        loadServerConfig: () => Effect.succeedNone,
      } as unknown as Persistence.EnvironmentCacheStore["Service"]),
    ),
  );
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => Atom.make(config),
  });
  const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (value) =>
    Effect.sync(() => value.dispose()),
  );
  registry.set(
    sessions(environmentId),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable" as const,
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthSettingsWriteScope],
      permissions: [AuthSettingsWriteScope],
    }),
  );
  return {
    updateRequests,
    publish,
    reconnect: (label: string) =>
      SubscriptionRef.set(session, Option.none()).pipe(Effect.andThen(publish(label))),
    observing: Deferred.await(observing),
    offerReady: (serverVersion: string) => Queue.offer(readyEvents, ready(serverVersion)),
    updateState: () => registry.get(serverUpdateStateAtom(environmentId)),
    update: () =>
      atoms.updateServer.run(registry, { environmentId, input: { targetVersion: "0.0.31" } }),
    writeSettings: () =>
      atoms.updateSettings.run(registry, { environmentId, input: { patch: {} } }),
  };
});

const refusal = (name: string) => ({
  _tag: "EnvironmentRpcUnavailableError",
  message: `${name} reconnected before this ran, so it was not sent. Try again.`,
});

describe("server update across a reconnect", () => {
  it.effect(
    "a second Update pressed during an update is refused after the restart, and the first completes across it",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("update-second-press");
        yield* h.publish("first");
        const first = h.update();
        yield* h.observing;
        const second = h.update();
        yield* h.reconnect("second");
        yield* h.offerReady("0.0.31");

        expect((yield* Effect.promise(() => first))._tag).toBe("Success");
        const result = yield* Effect.promise(() => second);
        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(Cause.squash(result.cause)).toMatchObject(refusal("update-second-press"));
        }
        expect(h.updateRequests).toEqual(["first"]);
        expect(h.updateState()).toEqual({ status: "idle" });
      }).pipe(Effect.scoped),
  );

  // The settings write fails only after the next session is up. A real socket loss fails it
  // first; forcing this order stands in for a reconnect that beats the queued request.
  it.effect("Update's request queued behind a settings write is refused after a reconnect", () =>
    Effect.gen(function* () {
      const settingsStarted = yield* Deferred.make<void>();
      const failSettings = yield* Deferred.make<void>();
      const h = yield* makeHarness(
        "update-behind-settings",
        Deferred.succeed(settingsStarted, undefined).pipe(
          Effect.andThen(Deferred.await(failSettings)),
          Effect.andThen(Effect.fail(socketLoss())),
        ),
      );
      yield* h.publish("first");
      const settings = h.writeSettings();
      yield* Deferred.await(settingsStarted);
      const update = h.update();
      yield* h.reconnect("second");
      yield* Deferred.succeed(failSettings, undefined);

      expect((yield* Effect.promise(() => settings))._tag).toBe("Failure");
      const result = yield* Effect.promise(() => update);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(Cause.squash(result.cause)).toMatchObject(refusal("update-behind-settings"));
      }
      expect(h.updateRequests).toEqual([]);
      expect(h.updateState()).toMatchObject({
        status: "failed",
        message: refusal("update-behind-settings").message,
      });
    }).pipe(Effect.scoped),
  );
});
