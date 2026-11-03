import { vi } from "vite-plus/test";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION, type ServerConfig } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as RpcSession from "../rpc/session.ts";
import { HubProxyConnectionProfile } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import { HubProxyConnectionTarget, hubProxyConnectionId } from "./model.ts";
import { makeDependencies } from "./resolver.testkit.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { awaitState } from "./supervisorTestSupport.ts";
import * as ConnectionWakeups from "./wakeups.ts";

const HUB = EnvironmentId.make("hub");
const NODE = EnvironmentId.make("node");
const id = hubProxyConnectionId(HUB, "node-1");
const target = new HubProxyConnectionTarget({
  connectionId: id,
  environmentId: NODE,
  label: "Node",
});
const profile = new HubProxyConnectionProfile({
  connectionId: id,
  environmentId: NODE,
  label: "Node",
  hubEnvironmentId: HUB,
  hubConnectionId: "hub-address",
  nodeId: "node-1",
  hubLabel: "Hub",
});
const descriptor = {
  label: "Node",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: {},
};

/** A real driver and resolver over a hub that, like the hub proxy, answers nothing unauthenticated. */
const hubConnection = Effect.fn("TestHubProxyProbe.connect")(function* () {
  let nodeEnvironment: string = NODE;
  let watch: Deferred.Deferred<void> | undefined;
  const requests: Array<{ readonly url: string; readonly authorized: boolean }> = [];
  const fetchFn: typeof fetch = (url, init) => {
    const authorized = new Headers(init?.headers).get("authorization") === "Bearer hub-token";
    requests.push({ url: String(url), authorized });
    if (watch !== undefined) Deferred.doneUnsafe(watch, Effect.void);
    if (!authorized)
      return Promise.resolve(Response.json({ message: "Unauthorized" }, { status: 401 }));
    return Promise.resolve(
      String(url).includes("websocket-ticket")
        ? Response.json({
            ticket: `ticket-${requests.length}`,
            expiresAt: "2026-10-20T00:00:00.000Z",
          })
        : Response.json({ ...descriptor, environmentId: nodeEnvironment }),
    );
  };
  const sessions = yield* Ref.make(0);
  const releases = yield* Ref.make(0);
  const probeUrls: string[] = [];
  const session: RpcSession.RpcSession = {
    client: {} as WsRpcProtocolClient,
    initialConfig: Effect.succeed({
      environment: { capabilities: { connectionProbe: true } },
    } as ServerConfig),
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const factory = RpcSession.RpcSessionFactory.of({
    connect: () =>
      Effect.acquireRelease(Ref.update(sessions, (n) => n + 1).pipe(Effect.as(session)), () =>
        Ref.update(releases, (n) => n + 1),
      ),
    openProbe: (fresh) =>
      Effect.sync(() => {
        probeUrls.push(fresh.socketUrl);
        return { probe: Effect.void, drainIo: Effect.void };
      }),
  });
  const resolver = yield* makeDependencies({
    hubAuth: {
      resolve: () =>
        Effect.succeed({
          httpBaseUrl: "https://hub.test/",
          authorization: { _tag: "Bearer" as const, token: "hub-token" },
        }),
    },
    fetch: fetchFn,
  });
  const wakeups = yield* SubscriptionRef.make({
    sequence: 0,
    reason: "application-active" as ConnectionWakeups.ConnectionWakeup,
  });
  const layer = Layer.mergeAll(
    ConnectionDriver.layer.pipe(
      Layer.provide(Layer.merge(resolver, Layer.succeed(RpcSession.RpcSessionFactory, factory))),
    ),
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(Connectivity.Connectivity, {
      status: Effect.succeed("online" as const),
      changes: Stream.never,
    }),
    Layer.succeed(ConnectionWakeups.ConnectionWakeups, {
      changes: SubscriptionRef.changes(wakeups).pipe(
        Stream.drop(1),
        Stream.map((event) => event.reason),
      ),
    }),
  );
  const supervisor = yield* EnvironmentSupervisor.make(
    { target, profile: Option.some(profile), enabled: true },
    { initiallyDesired: true },
  ).pipe(Effect.provide(layer));
  yield* awaitState(supervisor.state, (state) => state.phase === "connected");
  return {
    supervisor,
    sessions,
    releases,
    probeUrls,
    setNodeEnvironment: (environmentId: string) => {
      nodeEnvironment = environmentId;
    },
    /** Wakes the supervisor and returns once the replacement check makes its first hub request. */
    networkChanged: Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      watch = requested;
      const from = requests.length;
      yield* SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason: "network-changed" as const,
      }));
      yield* Deferred.await(requested);
      watch = undefined;
      return requests.slice(from);
    }),
  };
});

it.effect("hub proxy: silent old socket and an answering fresh probe -> one replacement", () =>
  Effect.gen(function* () {
    const hub = yield* hubConnection();
    const checked = yield* hub.networkChanged;
    expect(checked[0]).toMatchObject({
      url: expect.stringContaining(".well-known/goat/environment"),
      authorized: true,
    });
    yield* TestClock.adjust("5 seconds");
    yield* awaitState(
      hub.supervisor.state,
      (state) => state.phase === "connected" && state.generation === 2,
    );
    expect(hub.probeUrls).toHaveLength(1);
    expect(new URL(hub.probeUrls[0]!).pathname).toContain("/ws");
    expect(yield* Ref.get(hub.sessions)).toBe(2);
    expect(yield* Ref.get(hub.releases)).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("hub proxy: a fresh descriptor naming another environment keeps the old socket", () =>
  Effect.gen(function* () {
    const hub = yield* hubConnection();
    hub.setNodeEnvironment("another-node");
    const checked = yield* hub.networkChanged;
    expect(checked[0]).toMatchObject({ authorized: true });
    yield* TestClock.adjust("10 seconds");
    expect(hub.probeUrls).toEqual([]);
    expect(yield* Ref.get(hub.sessions)).toBe(1);
    expect((yield* SubscriptionRef.get(hub.supervisor.state)).generation).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);
