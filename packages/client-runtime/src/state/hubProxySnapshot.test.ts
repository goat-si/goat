import {
  EnvironmentId,
  HubProxySnapshot,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  HubProxyConnectionTarget,
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import { HubProxyConnectionProfile } from "../connection/catalog.ts";
import { HubProxyAuthSource } from "../connection/hubProxyAuthSource.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { makeEnvironmentShellState, offlineSnapshotCapturedAt } from "./shell.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";
import { hydrateHubProxySnapshot } from "./hubProxySnapshot.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

const target = new HubProxyConnectionTarget({
  environmentId: EnvironmentId.make("node"),
  label: "Node",
  connectionId: "hub:hub:node",
});
const profile = new HubProxyConnectionProfile({
  connectionId: target.connectionId,
  environmentId: target.environmentId,
  label: target.label,
  hubEnvironmentId: EnvironmentId.make("hub"),
  hubConnectionId: "primary",
  nodeId: "node",
});
const encodeHubSnapshot = Schema.encodeEffect(Schema.toCodecJson(HubProxySnapshot));
const capturedAt = "2026-10-19T12:00:00.000Z";
const snapshot = (snapshotSequence: number): OrchestrationV2ShellSnapshot => ({
  ...v2ShellSnapshot,
  snapshotSequence,
});

const makeHarness = Effect.fn("TestHubProxyShell.makeHarness")(function* (cachedSequence?: number) {
  const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  const active = yield* SubscriptionRef.make<Option.Option<RpcSession>>(Option.none());
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connecting",
    stage: "preparing",
  });
  const supervisor = EnvironmentSupervisor.of({
    target,
    state,
    session: active,
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const saved = yield* Ref.make<readonly OrchestrationV2ShellSnapshot[]>([]);
  const meta = yield* Ref.make<readonly Persistence.ShellSnapshotMeta[]>([]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () =>
      Effect.succeed(
        cachedSequence === undefined ? Option.none() : Option.some(snapshot(cachedSequence)),
      ),
    loadShellMeta: () => Effect.succeedNone,
    saveShell: (_id, shell) => Ref.update(saved, (all) => [...all, shell]),
    saveShellMeta: (_id, value) => Ref.update(meta, (all) => [...all, value]),
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const shell = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ShellSnapshotLoader, { load: () => Effect.succeedNone }),
  );
  const beginLive = Effect.gen(function* () {
    const subscribed = yield* Deferred.make<void>();
    const client = {
      [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: () =>
        Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
          Stream.flatMap(() => Stream.fromQueue(events)),
        ),
    } as unknown as WsRpcProtocolClient;
    const session: RpcSession = {
      client,
      initialConfig: Effect.succeed({ shellResumeCompletionMarker: false } as never),
      subscribeServerConfig: (input) => client.subscribeServerConfig(input),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    };
    yield* SubscriptionRef.set(
      supervisor.prepared,
      Option.some({
        target,
        environmentId: target.environmentId,
        label: target.label,
        httpBaseUrl: "https://hub.test/hub/nodes/node/",
        socketUrl: "wss://hub.test/hub/nodes/node/ws",
        httpAuthorization: null,
      }),
    );
    yield* SubscriptionRef.set(active, Option.some(session));
    yield* Deferred.await(subscribed);
    yield* Queue.offer(events, { kind: "snapshot", snapshot: snapshot(2) });
    yield* SubscriptionRef.changes(shell).pipe(
      Stream.filter((value) => value.status === "live"),
      Stream.runHead,
    );
  });
  return { shell, saved, meta, beginLive };
});

const delayedFetch = Effect.fn("TestHubProxyShell.delayedFetch")(function* () {
  const started = yield* Deferred.make<void>();
  const response = yield* Deferred.make<HubProxySnapshot>();
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Deferred.succeed(started, undefined);
      const body = yield* Deferred.await(response);
      const json = yield* encodeHubSnapshot(body).pipe(Effect.orDie);
      return HttpClientResponse.fromWeb(request, Response.json(json));
    }),
  );
  const run = (hydrate: Parameters<typeof hydrateHubProxySnapshot>[1]) =>
    hydrateHubProxySnapshot(profile, hydrate).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.provideService(HubProxyAuthSource, {
        resolve: () => Effect.succeed({ httpBaseUrl: "https://hub.test", authorization: null }),
      }),
    );
  return { started, response, run };
});

describe("hub shell hydration", () => {
  it.effect("persists live snapshots with the current capture time", () =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      const metadata = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness();
          yield* h.beginLive;
          return h.meta;
        }),
      );
      expect(yield* Ref.get(metadata)).toEqual([{ snapshotSequence: 2, capturedAt: now }]);
    }),
  );

  it.effect(
    "accepts a delayed hub snapshot while preparing and keeps the status and hub capture time",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const fetch = yield* delayedFetch();
        const work = yield* fetch.run(h.shell.hydrateFromHub).pipe(Effect.forkScoped);
        yield* Deferred.await(fetch.started);
        yield* Deferred.succeed(fetch.response, { nodeId: "node", capturedAt, shell: snapshot(1) });
        expect(yield* Fiber.join(work)).toBe(true);
        const state = yield* SubscriptionRef.get(h.shell);
        expect(state.status).toBe("synchronizing");
        expect(offlineSnapshotCapturedAt(state)).toBe(capturedAt);
        expect(yield* Ref.get(h.meta)).toEqual([{ snapshotSequence: 1, capturedAt }]);
        yield* h.beginLive;
        expect(
          Option.getOrThrow((yield* SubscriptionRef.get(h.shell)).snapshot).snapshotSequence,
        ).toBe(2);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects hydration completing after a live snapshot, even with a higher hub sequence",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const fetch = yield* delayedFetch();
        const work = yield* fetch.run(h.shell.hydrateFromHub).pipe(Effect.forkScoped);
        yield* Deferred.await(fetch.started);
        yield* h.beginLive;
        yield* Deferred.succeed(fetch.response, {
          nodeId: "node",
          capturedAt,
          shell: snapshot(99),
        });
        expect(yield* Fiber.join(work)).toBe(false);
        expect(
          Option.getOrThrow((yield* SubscriptionRef.get(h.shell)).snapshot).snapshotSequence,
        ).toBe(2);
        expect(yield* Ref.get(h.meta)).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect("rejects an older hub sequence without changing a newer local cache or metadata", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(10);
      expect(yield* h.shell.hydrateFromHub(snapshot(9), capturedAt)).toBe(false);
      expect(
        Option.getOrThrow((yield* SubscriptionRef.get(h.shell)).snapshot).snapshotSequence,
      ).toBe(10);
      expect(yield* Ref.get(h.saved)).toEqual([]);
      expect(yield* Ref.get(h.meta)).toEqual([]);
      expect(yield* h.shell.hydrateFromHub(snapshot(10), capturedAt)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it("exposes age only for metadata belonging to the displayed sequence", () => {
    expect(
      offlineSnapshotCapturedAt({
        snapshot: Option.some(snapshot(2)),
        status: "cached",
        error: Option.none(),
        meta: { snapshotSequence: 1, capturedAt },
      }),
    ).toBeNull();
    expect(
      offlineSnapshotCapturedAt({
        snapshot: Option.some(snapshot(2)),
        status: "cached",
        error: Option.none(),
        meta: { snapshotSequence: 2, capturedAt },
      }),
    ).toBe(capturedAt);
  });
});
