import { it } from "@effect/vitest";
import {
  type ConnectionCatalogEntry,
  Connectivity,
  ConnectionTransientError,
  EnvironmentSupervisor,
  type PreparedConnection,
  PrimaryConnectionTarget,
  presentConnectionState,
  type SupervisorConnectionState,
  Wakeups,
} from "@goat/client-runtime/connection";
import * as Driver from "@goat/client-runtime/connection/driver";
import * as Resolver from "@goat/client-runtime/connection/resolver";
import { ClientCapabilities } from "@goat/client-runtime/platform";
import { layerRemoteHttpClient } from "@goat/client-runtime/rpc";
import * as RpcSession from "@goat/client-runtime/rpc/session";
import { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Atom } from "effect/reactivity";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

const STUDIO = EnvironmentId.make("studio");
const view = vi.hoisted(() => ({ connection: null as unknown }));

// The store the readers and the follower read: this tab's own server and its connection.
vi.mock("~/state/primaryEnvironment", async () => {
  const { Atom } = await import("effect/reactivity");
  return { primaryEnvironmentIdAtom: Atom.make<EnvironmentId | null>(null) };
});
vi.mock("~/state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return { environmentPresentations: { presentationsAtom: Atom.make(new Map()) } };
});
vi.mock("~/environments/primary/auth", () => ({ isPrimaryAuthGateAuthenticated: () => true }));
vi.mock("~/environments/primary/httpLayer", () => ({ isSameOriginBrowserPrimary: () => true }));
vi.mock("~/state/environments", () => ({
  readEnvironment: () => (view.connection === null ? null : { connection: view.connection }),
  readPrimaryEnvironmentId: () => STUDIO,
  useEnvironment: () => null,
  usePrimaryEnvironmentId: () => STUDIO,
}));

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primarySessionCheck } from "~/environments/primary/sessionCheck";
import { environmentPresentations } from "~/state/presentation";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { readGoatBotComputerReadable } from "./useGoatBotComputerReadable";

const target = new PrimaryConnectionTarget({
  environmentId: STUDIO,
  label: "Studio",
  httpBaseUrl: "http://localhost:6277",
  wsBaseUrl: "ws://localhost:6277",
});
const entry: ConnectionCatalogEntry = { target, profile: Option.none(), enabled: true };
const prepared: PreparedConnection = {
  target,
  environmentId: STUDIO,
  label: "Studio",
  httpBaseUrl: "http://localhost:6277",
  socketUrl: "ws://localhost:6277/ws",
  httpAuthorization: null,
};

/** A cookie tab's own server: its socket is refused while `server.signedIn` is false. */
function ownServer() {
  const server = { signedIn: false, attempts: 0 };
  const session: RpcSession.RpcSession = {
    client: {} as never,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const driver = Driver.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Resolver.ConnectionResolver)({ prepare: () => Effect.succeed(prepared) }),
        Layer.mock(RpcSession.RpcSessionFactory)({
          connect: () =>
            Effect.suspend(() => {
              server.attempts += 1;
              return server.signedIn
                ? Effect.succeed(session)
                : Effect.fail(
                    new ConnectionTransientError({
                      reason: "transport",
                      detail: "Studio could not establish a WebSocket connection.",
                      hop: "server",
                    }),
                  );
            }),
        }),
        Layer.succeed(ClientCapabilities.PrimaryEnvironmentAuth, {
          bearerToken: Effect.succeedNone,
          sessionEnded: () => Effect.sync(() => !server.signedIn),
        }),
        layerRemoteHttpClient(() =>
          Promise.resolve(
            Response.json({
              environmentId: STUDIO,
              label: "Studio",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "1",
              capabilities: {},
            }),
          ),
        ),
      ),
    ),
  );
  const layer = Layer.mergeAll(
    driver,
    Layer.succeed(Connectivity.Connectivity, {
      status: Effect.succeed("online" as const),
      changes: Stream.never,
    }),
    Layer.succeed(Wakeups.ConnectionWakeups, { changes: Stream.never }),
  );
  return { server, layer };
}

const settled = (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  done: (value: SupervisorConnectionState) => boolean,
) => SubscriptionRef.changes(state).pipe(Stream.filter(done), Stream.runHead);

it.effect(
  "a cookie tab its own server refused stays unreadable for GOAT Bot through Retry, at every connection change, until it connects (#3473, steady refusal)",
  () =>
    Effect.gen(function* () {
      const { server, layer } = ownServer();
      appAtomRegistry.set(
        primaryEnvironmentIdAtom as unknown as Atom.Writable<EnvironmentId | null>,
        STUDIO,
      );
      // A mounted reader starts the follower, as GOAT Bot's screens do.
      primarySessionCheck.subscribe(() => {});
      const supervisor = yield* EnvironmentSupervisor.make(entry).pipe(Effect.provide(layer));
      const samples: Array<{ readonly phase: string; readonly readable: boolean }> = [];
      yield* SubscriptionRef.changes(supervisor.state).pipe(
        Stream.runForEach((state) =>
          Effect.sync(() => {
            view.connection = presentConnectionState(state);
            appAtomRegistry.set(
              environmentPresentations.presentationsAtom as unknown as Atom.Writable<
                ReadonlyMap<EnvironmentId, { readonly connection: unknown }>
              >,
              new Map([[STUDIO, { connection: view.connection }]]),
            );
            samples.push({ phase: state.phase, readable: readGoatBotComputerReadable(STUDIO) });
          }),
        ),
        Effect.forkScoped,
      );

      yield* supervisor.connect;
      yield* settled(supervisor.state, (state) => state.phase === "blocked");
      expect(server.attempts).toBe(1);

      yield* supervisor.retryNow;
      yield* settled(
        supervisor.state,
        (state) => state.phase === "blocked" && server.attempts === 2,
      );
      // Blocked waits for a signal: no timed retry follows.
      yield* TestClock.adjust("10 minutes");
      expect(server.attempts).toBe(2);

      server.signedIn = true;
      yield* supervisor.retryNow;
      yield* settled(supervisor.state, (state) => state.phase === "connected");

      const refusedAt = samples.findIndex((sample) => sample.phase === "blocked");
      expect(refusedAt).toBeGreaterThan(-1);
      const between = samples.slice(refusedAt, -1);
      // Retry's attempt shows a connection with no failure; the follower must hold through it.
      expect(between.some((sample) => sample.phase === "connecting")).toBe(true);
      expect(between.filter((sample) => sample.readable)).toEqual([]);
      expect(samples.at(-1)).toEqual({ phase: "connected", readable: true });
      expect(primarySessionCheck.revoked()).toBe(false);
    }).pipe(Effect.scoped),
);
