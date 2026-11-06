import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
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
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { type EnvironmentShellState, makeEnvironmentShellState } from "./shell.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};

const LIVE_SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  ...v2ShellSnapshot,
  snapshotSequence: 1,
};

function session(client: WsRpcProtocolClient): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed({ shellResumeCompletionMarker: true } as never),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input ?? {}),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

it.effect("opts in to shell omissions and counts authoritative snapshots and removals", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
    const subscribeInputs = yield* Queue.unbounded<unknown>();
    const loadOptions = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const client = {
      [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: unknown) =>
        Stream.unwrap(
          Queue.offer(subscribeInputs, input).pipe(Effect.as(Stream.fromQueue(events))),
        ),
    } as unknown as WsRpcProtocolClient;
    const familySession: RpcSession.RpcSession = {
      ...session(client),
      initialConfig: Effect.succeed({
        shellResumeCompletionMarker: true,
        shellThreadFamilies: true,
        shellOlderSettled: true,
        environment: { serverVersion: "1.0.0", instanceId: "server-1" },
      } as never),
    };
    const activeSession = yield* SubscriptionRef.make(Option.some(familySession));
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
      session: activeSession,
      prepared: yield* SubscriptionRef.make(Option.some(PREPARED)),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const cache = Persistence.EnvironmentCacheStore.of({
      loadShell: () => Effect.succeedNone,
      saveShell: () => Effect.void,
      loadShellMeta: () => Effect.succeedNone,
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
    const snapshotLoader = ShellSnapshotLoader.ShellSnapshotLoader.of({
      load: (_prepared, options) =>
        Ref.update(loadOptions, (all) => [...all, options]).pipe(
          Effect.as(Option.some(LIVE_SHELL_SNAPSHOT)),
        ),
    });
    const shellState = yield* makeEnvironmentShellState().pipe(
      Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(Persistence.EnvironmentCacheStore, cache),
      Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, snapshotLoader),
    );
    const stateWhere = (predicate: (state: EnvironmentShellState) => boolean) =>
      SubscriptionRef.changes(shellState).pipe(Stream.filter(predicate), Stream.runHead);

    // Both transports must omit, or omitted children would come back through the socket.
    expect(yield* Queue.take(subscribeInputs)).toMatchObject({
      afterSequence: 1,
      omitIdleSubagents: true,
      omitOlderSettled: true,
    });
    expect(yield* Ref.get(loadOptions)).toEqual([
      { omitIdleSubagents: true, omitOlderSettled: true },
    ]);
    const loaded = Option.getOrThrow(yield* stateWhere((state) => state.generation > 0));
    expect(loaded.removedAt.size).toBe(0);

    const gone = ThreadId.make("thread-gone");
    yield* Queue.offer(events, {
      kind: "snapshot",
      snapshot: { ...LIVE_SHELL_SNAPSHOT, threads: [] },
      resolvedRepositoryIdentityRoots: [],
    });
    yield* Queue.offer(events, {
      kind: "thread.removed",
      sequence: 2,
      location: "active",
      threadId: gone,
    });
    const removed = Option.getOrThrow(yield* stateWhere((state) => state.removedAt.size > 0));
    // An enrichment refresh is not authoritative.
    expect(removed.generation).toBe(loaded.generation);
    expect(removed.removedAt.get(gone)).toBe(2);

    yield* Queue.offer(events, {
      kind: "snapshot",
      snapshot: { ...LIVE_SHELL_SNAPSHOT, snapshotSequence: 5 },
    });
    const reset = Option.getOrThrow(
      yield* stateWhere((state) => state.generation > loaded.generation),
    );
    expect(reset.removedAt.size).toBe(0);
    yield* SubscriptionRef.set(activeSession, Option.some({ ...familySession }));
    expect(yield* Queue.take(subscribeInputs)).toMatchObject({ afterSequence: 5 });
    expect(yield* Ref.get(loadOptions)).toHaveLength(1);
    yield* SubscriptionRef.set(
      activeSession,
      Option.some({
        ...familySession,
        initialConfig: familySession.initialConfig.pipe(
          Effect.map((config) => ({
            ...config,
            environment: { ...config.environment, instanceId: "server-2" },
          })),
        ),
      }),
    );
    yield* Queue.take(subscribeInputs);
    expect(yield* Ref.get(loadOptions)).toHaveLength(2);
  }),
);
