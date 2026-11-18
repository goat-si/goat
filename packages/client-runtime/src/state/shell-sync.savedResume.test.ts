import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2SubscribeShellInput,
} from "@goat/contracts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
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

const makeCachedShell = Effect.fn("test.makeCachedShell")(function* (savedOrigin: typeof origin) {
  const subscriptions = yield* Queue.unbounded<ShellInput>();
  const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
  const httpRequests = yield* Ref.make(0);
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
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.some(prepared)),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedSome({ ...cachedSnapshot, origin: savedOrigin }),
    saveShell: () => Effect.void,
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
      load: () =>
        Ref.update(httpRequests, (count) => count + 1).pipe(Effect.as(Option.some(nextSnapshot))),
    }),
  );
  return { state, subscriptions, events, httpRequests };
});

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
