import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2SubscribeShellInput,
} from "@goat/contracts";
import { it, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";
import { makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("cached-shell"),
  label: "Cached shell",
  httpBaseUrl: "https://cached-shell.example.test",
  wsBaseUrl: "wss://cached-shell.example.test",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl,
  httpAuthorization: null,
  target,
};
const cachedSnapshot = { ...v2ShellSnapshot, snapshotSequence: 19 };
const nextSnapshot = { ...v2ShellSnapshot, snapshotSequence: 23 };
const origin = {
  instanceId: "running-process",
  serverVersion: "1.0.0",
  databaseMigration: 89,
  omitIdleSubagents: true,
  omitOlderSettled: true,
  snapshotAt: 0,
};
type ShellInput = OrchestrationV2SubscribeShellInput & { readonly httpSnapshotFallback?: true };

const makeCachedShell = Effect.fn("test.makeCachedShell")(function* (
  savedOrigin: typeof origin,
  startPrepared?: PreparedConnection,
  httpReply: Effect.Effect<Option.Option<ShellSnapshotLoader.ShellHttpAnswer>> = Effect.succeedSome(
    {
      ...nextSnapshot,
      instanceId: origin.instanceId,
    },
  ),
) {
  const subscriptions = yield* Queue.unbounded<ShellInput>();
  const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  const httpRequests = yield* Ref.make(0);
  const saved = yield* Queue.unbounded<{
    readonly cursor: number;
    readonly instanceId: string | undefined;
  }>();
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: ShellInput) =>
      Stream.unwrap(Queue.offer(subscriptions, input).pipe(Effect.as(Stream.fromQueue(events)))),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed({
      environment: {
        environmentId: target.environmentId,
        instanceId: origin.instanceId,
        serverVersion: origin.serverVersion,
        databaseMigration: origin.databaseMigration,
      },
      shellThreadFamilies: true,
      shellOlderSettled: true,
      shellResumeCompletionMarker: true,
    } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const sessions = yield* SubscriptionRef.make(
    startPrepared ? Option.none<RpcSession>() : Option.some(session),
  );
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: sessions,
    prepared: yield* SubscriptionRef.make(Option.some(startPrepared ?? prepared)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedSome({ ...cachedSnapshot, origin: savedOrigin }),
    saveShell: (_environmentId, snapshot, origin) =>
      Queue.offer(saved, { cursor: snapshot.snapshotSequence, instanceId: origin?.instanceId }),
    loadShellMeta: () =>
      Effect.succeedSome({ capturedAt: "1970-01-01T00:00:00.000Z", snapshotSequence: 99 }),
    saveShellMeta: () => Effect.void,
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
  const state = yield* makeEnvironmentShellState().pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
      load: () => Ref.update(httpRequests, (count) => count + 1).pipe(Effect.andThen(httpReply)),
    }),
  );
  return {
    state,
    subscriptions,
    events,
    httpRequests,
    saved,
    connect: SubscriptionRef.set(sessions, Option.some(session)),
  };
});

const authenticatedPrepared = {
  ...prepared,
  httpAuthorization: { _tag: "Bearer" as const, token: "test-token" },
  descriptor: {
    environmentId: target.environmentId,
    instanceId: origin.instanceId,
    serverVersion: origin.serverVersion,
    databaseMigration: origin.databaseMigration,
    platform: { os: "linux" as const, arch: "x64" as const },
    label: target.label,
    capabilities: { repositoryIdentity: false, shellThreadFamilies: true, shellOlderSettled: true },
  },
};

it.effect("resumes from the saved rows' cursor and loads HTTP once on server refusal", () =>
  Effect.gen(function* () {
    const h = yield* makeCachedShell(origin);
    expect(yield* Queue.take(h.subscriptions)).toMatchObject({
      afterSequence: 19,
      httpSnapshotFallback: true,
    });
    expect(yield* Ref.get(h.httpRequests)).toBe(0);
    yield* Queue.offer(h.events, { kind: "snapshot-required" });
    const retry = yield* Queue.take(h.subscriptions);
    expect(retry.afterSequence).toBe(23);
    expect(retry.httpSnapshotFallback).toBeUndefined();
    expect(yield* Ref.get(h.httpRequests)).toBe(1);
    yield* Queue.offer(h.events, { kind: "synchronized" });
    const live = yield* SubscriptionRef.changes(h.state).pipe(
      Stream.filter((state) => state.status === "live"),
      Stream.runHead,
      Effect.map(Option.getOrThrow),
    );
    expect(Option.getOrThrow(live.snapshot).snapshotSequence).toBe(23);
  }),
);

it.effect(
  "reloads saved shells from a different instance, build, migration, omissions, or age",
  () =>
    Effect.gen(function* () {
      for (const changes of [
        { instanceId: "restarted-process" },
        { serverVersion: "0.9.0" },
        { databaseMigration: 88 },
        { omitOlderSettled: false },
        { snapshotAt: -12 * 60 * 60 * 1_000 },
      ]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeCachedShell({ ...origin, ...changes });
            const request = yield* Queue.take(h.subscriptions);
            expect(request.afterSequence).toBe(23);
            expect(request.httpSnapshotFallback).toBeUndefined();
            expect(yield* Ref.get(h.httpRequests)).toBe(1);
          }),
        );
      }
    }),
);

it.effect(
  "starts the authenticated shell read after prepare and before a socket session exists",
  () =>
    Effect.gen(function* () {
      const h = yield* makeCachedShell(origin, authenticatedPrepared);
      yield* TestClock.adjust("0 millis");
      expect(yield* Ref.get(h.httpRequests)).toBe(1);
      yield* h.connect;
      const request = yield* Queue.take(h.subscriptions);
      expect(request.afterSequence).toBe(23);
      expect(yield* Ref.get(h.httpRequests)).toBe(1);
    }),
);

it.effect("does not start an early shell read without authorization or advertised flags", () =>
  Effect.gen(function* () {
    for (const prepared of [
      { ...authenticatedPrepared, httpAuthorization: null },
      {
        ...authenticatedPrepared,
        descriptor: {
          ...authenticatedPrepared.descriptor,
          capabilities: { repositoryIdentity: false },
        },
      },
    ]) {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeCachedShell(origin, prepared);
          yield* TestClock.adjust("0 millis");
          expect(yield* Ref.get(h.httpRequests)).toBe(0);
          yield* h.connect;
          expect((yield* Queue.take(h.subscriptions)).afterSequence).toBe(19);
        }),
      );
    }
  }),
);

it.effect("resumes held rows after the early HTTP grace and interrupts the late read", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const read = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
    );
    const h = yield* makeCachedShell(origin, authenticatedPrepared, read);
    yield* Deferred.await(started);
    yield* h.connect;
    yield* TestClock.adjust("3 seconds");
    expect(yield* Queue.take(h.subscriptions)).toMatchObject({
      afterSequence: 19,
      httpSnapshotFallback: true,
    });
    yield* Deferred.await(interrupted);
    expect(yield* Ref.get(h.httpRequests)).toBe(1);
  }),
);

it.effect(
  "opens a full socket shell if hub hydration replaced the rows during the early read",
  () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<Option.Option<ShellSnapshotLoader.ShellHttpAnswer>>();
      const read = Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply)));
      const h = yield* makeCachedShell(origin, authenticatedPrepared, read);
      yield* Deferred.await(started);
      yield* h.connect;
      yield* TestClock.adjust("0 millis");
      expect(
        yield* h.state.hydrateFromHub(
          { ...cachedSnapshot, snapshotSequence: 20, threads: [] },
          "1970-01-01T00:00:01.000Z",
        ),
      ).toBe(true);
      const answer = { resumable: true as const, instanceId: origin.instanceId };
      yield* Deferred.succeed(reply, Option.some(answer));
      const request = yield* Queue.take(h.subscriptions);
      expect(request.afterSequence).toBeUndefined();
      yield* Queue.offer(h.events, { kind: "snapshot", snapshot: nextSnapshot });
      yield* Queue.offer(h.events, { kind: "synchronized" });
      const live = yield* SubscriptionRef.changes(h.state).pipe(
        Stream.filter((state) => state.status === "live"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(Option.getOrThrow(live.snapshot).threads).toEqual(nextSnapshot.threads);
    }),
);

it.effect.each([undefined, "different-process"])(
  "falls back to the full socket shell when the HTTP serving instance is %s",
  (instanceId) =>
    Effect.gen(function* () {
      for (const answer of [nextSnapshot, { resumable: true as const }]) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const loaded = instanceId === undefined ? answer : { ...answer, instanceId };
            const h = yield* makeCachedShell(
              origin,
              authenticatedPrepared,
              Effect.succeedSome(loaded),
            );
            yield* h.connect;
            const request = yield* Queue.take(h.subscriptions);
            expect(request.afterSequence).toBeUndefined();
            const beforeSocket = yield* SubscriptionRef.get(h.state);
            expect(Option.getOrThrow(beforeSocket.snapshot).snapshotSequence).toBe(19);
            expect(beforeSocket.authoritativeSession).toBeNull();
            yield* TestClock.adjust("1 second");
            expect(yield* Queue.size(h.saved)).toBe(0);
            yield* Queue.offer(h.events, { kind: "snapshot", snapshot: nextSnapshot });
            yield* Queue.offer(h.events, { kind: "synchronized" });
            const live = yield* SubscriptionRef.changes(h.state).pipe(
              Stream.filter((value) => value.status === "live"),
              Stream.runHead,
              Effect.map(Option.getOrThrow),
            );
            expect(Option.getOrThrow(live.snapshot).snapshotSequence).toBe(23);
            yield* TestClock.adjust("1 second");
            expect(yield* Queue.take(h.saved)).toEqual({
              cursor: 23,
              instanceId: origin.instanceId,
            });
          }),
        );
      }
    }),
);

it.effect("starts the cookie-authenticated primary read before the socket opens", () =>
  Effect.gen(function* () {
    const cookie = {
      ...authenticatedPrepared,
      socketUrl: `${target.wsBaseUrl}/ws`,
      httpAuthorization: null,
    };
    const h = yield* makeCachedShell(origin, cookie);
    yield* TestClock.adjust("0 millis");
    expect(yield* Ref.get(h.httpRequests)).toBe(1);
    yield* h.connect;
    expect((yield* Queue.take(h.subscriptions)).afterSequence).toBe(23);
    expect(yield* Ref.get(h.httpRequests)).toBe(1);
  }),
);

it.effect("does not start a cookie read when the primary socket points to another origin", () =>
  Effect.gen(function* () {
    const h = yield* makeCachedShell(origin, {
      ...authenticatedPrepared,
      socketUrl: "wss://different-host.example.test/ws",
      httpAuthorization: null,
    });
    yield* TestClock.adjust("0 millis");
    expect(yield* Ref.get(h.httpRequests)).toBe(0);
  }),
);
