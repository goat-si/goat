import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Socket from "effect/socket/Socket";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { RpcClientError } from "effect/rpc";
import { Atom, AtomRegistry } from "effect/reactivity";

import { AVAILABLE_CONNECTION_STATE, type SupervisorConnectionState } from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  makeThreadTriageOutboxStore,
  ThreadTriageOutboxStorageError,
  ThreadTriageOutboxStore,
} from "../platform/threadTriageOutboxStore.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { EnvironmentShellStatus } from "./shell.ts";
import { createThreadEnvironmentAtoms } from "./threadCommands.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";

const ENVIRONMENT_ID = EnvironmentId.make("remote");
const THREAD_ID = ThreadId.make("thread");
const CREATED_AT = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const FUTURE = DateTime.makeUnsafe("2099-01-01T00:00:00.000Z");

const SNAPSHOT: OrchestrationV2ShellSnapshot = {
  snapshotSequence: 1,
  schemaVersion: 2,
  archivedThreads: [],
  projects: [],
  threads: [
    {
      id: THREAD_ID,
      projectId: ProjectId.make("project"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: ProviderInstanceId.make("codex"),
      lineage: { rootThreadId: THREAD_ID, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      activeProviderThreadId: null,
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      itemCount: 0,
      visibleItemCount: 0,
      deletedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      pullRequests: [],
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
    },
  ],
};

let randomCalls = 0;

const waitFor = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  done: (value: A) => boolean,
) =>
  Effect.callback<void>((resume) => {
    if (done(registry.get(atom))) return resume(Effect.void);
    const unsubscribe = registry.subscribe(atom, (value) => {
      if (!done(value)) return;
      unsubscribe();
      resume(Effect.void);
    });
    return Effect.sync(unsubscribe);
  });

const makeHarness = Effect.fn("TestThreadTriageOutbox.makeHarness")(function* (options?: {
  readonly connected?: boolean;
  readonly storage?: { value: string | null };
  readonly failNextWrite?: { value: boolean };
}) {
  const requests = yield* Queue.unbounded<{
    command: OrchestrationV2Command;
    reply: Deferred.Deferred<{ sequence: number }, Error>;
  }>();
  const liveSession = Option.some({
    client: {
      [ORCHESTRATION_V2_WS_METHODS.dispatchCommand]: (command: OrchestrationV2Command) =>
        Effect.gen(function* () {
          const reply = yield* Deferred.make<{ sequence: number }, Error>();
          yield* Queue.offer(requests, { command, reply });
          return yield* Deferred.await(reply);
        }),
    },
  } as unknown as RpcSession);
  const session = yield* SubscriptionRef.make(
    options?.connected === false ? Option.none<RpcSession>() : liveSession,
  );
  const connection = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    desired: true,
    phase: "connected",
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: { environmentId: ENVIRONMENT_ID, label: "Test" },
    state: connection,
    session,
  } as EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const storage = options?.storage ?? { value: null };
  const store = makeThreadTriageOutboxStore((next) =>
    Effect.suspend(() => {
      const updated = next(storage.value);
      if (updated !== null && options?.failNextWrite?.value) {
        options.failNextWrite.value = false;
        return Effect.fail(new ThreadTriageOutboxStorageError({ cause: new Error("disk full") }));
      }
      if (updated !== null) storage.value = updated;
      return Effect.void;
    }),
  );
  const clock = yield* Clock.Clock;
  const runtime = Atom.runtime(
    Layer.mergeAll(
      Layer.succeed(Clock.Clock, clock),
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
        run: (_environmentId, effect) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        followStream: (_environmentId, stream) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]),
      Layer.succeed(
        SecureRandom.SecureRandom,
        SecureRandom.make((size) => new Uint8Array(size).fill(++randomCalls % 256)),
      ),
      Layer.succeed(ThreadTriageOutboxStore, store),
      Layer.succeed(
        ThreadHistoryController.ThreadHistoryController,
        ThreadHistoryController.ThreadHistoryController.of({
          register: () => Effect.die("unused"),
          unregister: () => Effect.void,
          loadEarlier: () => Effect.die("unused"),
          reconcilePendingWork: () => Effect.void,
        }),
      ),
    ),
  );
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(SNAPSHOT),
  );
  const statusAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<EnvironmentShellStatus>(options?.connected === false ? "cached" : "live"),
  );
  const commands = createThreadEnvironmentAtoms(runtime, snapshotAtom, statusAtom);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const visibleAtom = commands.snapshotAtom(ENVIRONMENT_ID);
  registry.mount(visibleAtom);
  const pendingSyncAtom = commands.pendingSyncAtom(ENVIRONMENT_ID);
  registry.mount(pendingSyncAtom);
  const reconnect = (status: EnvironmentShellStatus = "live") =>
    SubscriptionRef.set(session, liveSession).pipe(
      Effect.andThen(Effect.sync(() => registry.set(statusAtom(ENVIRONMENT_ID), status))),
    );
  const disconnect = () =>
    SubscriptionRef.set(session, Option.none()).pipe(
      Effect.andThen(Effect.sync(() => registry.set(statusAtom(ENVIRONMENT_ID), "cached"))),
    );
  return {
    registry,
    commands,
    snapshotAtom,
    statusAtom,
    visibleAtom,
    pendingSyncAtom,
    requests,
    store,
    reconnect,
    disconnect,
  };
});

describe("thread triage outbox compensating undo after uncertain replay", () => {
  const target = { environmentId: ENVIRONMENT_ID, input: { threadId: THREAD_ID } };
  const snooze = {
    environmentId: ENVIRONMENT_ID,
    input: { threadId: THREAD_ID, snoozedUntil: "2099-01-01T00:00:00.000Z" },
  };
  const undo = {
    environmentId: ENVIRONMENT_ID,
    input: { threadId: THREAD_ID, reason: "user" as const },
  };

  it.effect.each([
    [
      "settle",
      "unsettle",
      { settledOverride: "settled" as const, settledAt: CREATED_AT },
      "thread.unsettle",
    ],
    ["snooze", "unsnooze", { snoozedUntil: FUTURE, snoozedAt: CREATED_AT }, "thread.unsnooze"],
  ] as const)(
    "queues a compensating %s when offline undo follows a lost replay reply for %s",
    ([action, reverseAction, committedFields, expectedCommandType]) =>
      Effect.gen(function* () {
        const storage = { value: null as string | null };
        const h = yield* makeHarness({ connected: false, storage });
        yield* Effect.promise(() =>
          action === "settle"
            ? h.commands.settle.run(h.registry, target)
            : h.commands.snooze.run(h.registry, snooze),
        );

        // Reconnect, replay sends the action, server commits it, then the socket drops before reply.
        yield* h.reconnect();
        const sent = yield* Queue.take(h.requests);
        expect(sent.command.type).toBe(`thread.${action}`);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* h.disconnect();

        // Undo while offline must persist a compensating reverse action rather than dropping silently.
        const undoResult = yield* Effect.promise(() =>
          reverseAction === "unsettle"
            ? h.commands.unsettle.run(h.registry, undo)
            : h.commands.unsnooze.run(h.registry, undo),
        );
        expect(undoResult._tag).toBe("Success");
        expect(undoResult._tag === "Success" && undoResult.value.cancelledOnDevice).toBeUndefined();
        const storedAfterUndo = yield* h.store.update((entries) => entries);
        expect(storedAfterUndo).toHaveLength(1);
        expect(storedAfterUndo[0]?.action.type).toBe(reverseAction);
        expect([...h.registry.get(h.pendingSyncAtom)]).toEqual([THREAD_ID]);

        // Reconnect with the server snapshot reflecting the committed original action.
        const serverCommitted: OrchestrationV2ShellSnapshot = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, ...committedFields }],
        };
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), serverCommitted);
        yield* h.reconnect();

        const compensating = yield* Queue.take(h.requests);
        expect(compensating.command.type).toBe(expectedCommandType);
        yield* Deferred.succeed(compensating.reply, { sequence: 3 });
        yield* waitFor(h.registry, h.pendingSyncAtom, (threads) => threads.size === 0);
        expect(yield* h.store.update((entries) => entries)).toEqual([]);
      }),
  );

  it.effect(
    "drops a compensating unsettle on reconnect when the server never committed the settle",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ connected: false });
        yield* Effect.promise(() => h.commands.settle.run(h.registry, target));
        yield* h.reconnect();
        const sent = yield* Queue.take(h.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* h.disconnect();

        yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
        // Server snapshot still shows the thread active (settle never committed).
        yield* h.reconnect();
        yield* waitFor(h.registry, h.pendingSyncAtom, (threads) => threads.size === 0);
        expect(yield* h.store.update((entries) => entries)).toEqual([]);
        const pin = h.commands.pin.run(h.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, orderKey: "a" },
        });
        const next = yield* Queue.take(h.requests);
        expect(next.command.type).toBe("thread.pin");
        yield* Deferred.succeed(next.reply, { sequence: 4 });
        yield* Effect.promise(() => pin);
      }),
  );

  it.effect(
    "preserves a compensating unsettle ahead of a later offline snooze and replays both in order",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ connected: false });
        yield* Effect.promise(() => h.commands.settle.run(h.registry, target));
        yield* h.reconnect();
        const sent = yield* Queue.take(h.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* h.disconnect();

        // Offline undo queues compensating unsettle, then offline snooze queues behind it.
        yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
        const snoozeResult = yield* Effect.promise(() => h.commands.snooze.run(h.registry, snooze));
        expect(snoozeResult._tag).toBe("Success");
        const stored = yield* h.store.update((entries) => entries);
        expect(stored.map((entry) => entry.action.type)).toEqual(["unsettle", "snooze"]);
        expect(h.registry.get(h.visibleAtom)?.threads[0]).toMatchObject({ snoozedUntil: FUTURE });

        // Server had committed the earlier settle; reconnect replays unsettle first, then snooze.
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled", settledAt: CREATED_AT }],
        });
        yield* h.reconnect();
        const first = yield* Queue.take(h.requests);
        expect(first.command.type).toBe("thread.unsettle");
        yield* Deferred.succeed(first.reply, { sequence: 3 });
        const second = yield* Queue.take(h.requests);
        expect(second.command.type).toBe("thread.snooze");
        yield* Deferred.succeed(second.reply, { sequence: 4 });
        yield* waitFor(h.registry, h.pendingSyncAtom, (threads) => threads.size === 0);
        expect(yield* h.store.update((entries) => entries)).toEqual([]);
      }),
  );

  it.effect(
    "keeps the attempted entry intact in storage when atomic compensation write fails",
    () =>
      Effect.gen(function* () {
        const failNextWrite = { value: false };
        const h = yield* makeHarness({ connected: false, failNextWrite });
        yield* Effect.promise(() => h.commands.settle.run(h.registry, target));
        yield* h.reconnect();
        const sent = yield* Queue.take(h.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* h.disconnect();

        failNextWrite.value = true;
        const undoResult = yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
        expect(undoResult._tag).toBe("Failure");
        const stored = yield* h.store.update((entries) => entries);
        expect(stored).toHaveLength(1);
        expect(stored[0]?.action.type).toBe("settle");
        expect(stored[0]?.attempted).toBe(true);
      }),
  );

  it.effect(
    "preserves a pending compensating unsettle when a live snooze or unsnooze succeeds",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ connected: false });
        yield* Effect.promise(() => h.commands.settle.run(h.registry, target));
        yield* h.reconnect();
        const sent = yield* Queue.take(h.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* h.disconnect();

        // Queue compensating unsettle offline, then reconnect with committed settle and transient failure.
        yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled", settledAt: CREATED_AT }],
        });
        yield* h.reconnect();
        const failedUndo = yield* Queue.take(h.requests);
        expect(failedUndo.command.type).toBe("thread.unsettle");
        yield* Deferred.fail(
          failedUndo.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );

        // A live snooze and live unsnooze must NOT discard the unrelated pending unsettle.
        const liveSnooze = h.commands.snooze.run(h.registry, snooze);
        const snoozeReq = yield* Queue.take(h.requests);
        expect(snoozeReq.command.type).toBe("thread.snooze");
        yield* Deferred.succeed(snoozeReq.reply, { sequence: 3 });
        expect((yield* Effect.promise(() => liveSnooze))._tag).toBe("Success");
        expect((yield* h.store.update((entries) => entries)).map((e) => e.action.type)).toEqual([
          "unsettle",
        ]);

        const liveUnsnooze = h.commands.unsnooze.run(h.registry, undo);
        const unsnoozeReq = yield* Queue.take(h.requests);
        expect(unsnoozeReq.command.type).toBe("thread.unsnooze");
        yield* Deferred.succeed(unsnoozeReq.reply, { sequence: 4 });
        expect((yield* Effect.promise(() => liveUnsnooze))._tag).toBe("Success");
        expect((yield* h.store.update((entries) => entries)).map((e) => e.action.type)).toEqual([
          "unsettle",
        ]);

        // Next retry still replays the preserved compensating unsettle.
        yield* TestClock.adjust("2 seconds");
        const retriedUndo = yield* Queue.take(h.requests);
        expect(retriedUndo.command.type).toBe("thread.unsettle");
        yield* Deferred.succeed(retriedUndo.reply, { sequence: 5 });
        yield* waitFor(h.registry, h.pendingSyncAtom, (threads) => threads.size === 0);
      }),
  );

  it.effect(
    "clears a superseded compensating unsettle before sending live settle so a restart cannot replay it",
    () =>
      Effect.gen(function* () {
        const storage = { value: null as string | null };
        const failNextWrite = { value: false };
        const before = yield* makeHarness({ connected: false, storage, failNextWrite });
        yield* Effect.promise(() => before.commands.settle.run(before.registry, target));
        yield* before.reconnect();
        const sent = yield* Queue.take(before.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* before.disconnect();

        // Queue compensating unsettle offline, then let its first live replay fail transiently.
        yield* Effect.promise(() => before.commands.unsettle.run(before.registry, undo));
        before.registry.set(before.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled", settledAt: CREATED_AT }],
        });
        yield* before.reconnect();
        const failedUndo = yield* Queue.take(before.requests);
        expect(failedUndo.command.type).toBe("thread.unsettle");
        yield* Deferred.fail(
          failedUndo.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );

        // If pre-send storage removal fails, live settle refuses to send so disk stays consistent.
        failNextWrite.value = true;
        const failedSettle = yield* Effect.promise(() =>
          before.commands.settle.run(before.registry, target),
        );
        expect(failedSettle._tag).toBe("Failure");
        expect((yield* before.store.update((e) => e)).map((e) => e.action.type)).toEqual([
          "unsettle",
        ]);

        // Once storage accepts the pre-send removal, live settle succeeds and disk is already empty.
        const liveSettle = before.commands.settle.run(before.registry, target);
        const settleReq = yield* Queue.take(before.requests);
        expect(settleReq.command.type).toBe("thread.settle");
        yield* Deferred.succeed(settleReq.reply, { sequence: 3 });
        expect((yield* Effect.promise(() => liveSettle))._tag).toBe("Success");

        // Recreate a fresh runtime with the same stored outbox (simulating an app restart).
        const afterRestart = yield* makeHarness({ connected: false, storage });
        afterRestart.registry.set(afterRestart.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          snapshotSequence: 3,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled", settledAt: CREATED_AT }],
        });
        yield* afterRestart.reconnect();
        const pin = afterRestart.commands.pin.run(afterRestart.registry, {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, orderKey: "a" },
        });
        const nextReq = yield* Queue.take(afterRestart.requests);
        expect(nextReq.command.type).toBe("thread.pin");
        yield* Deferred.succeed(nextReq.reply, { sequence: 4 });
        yield* Effect.promise(() => pin);
        expect(yield* afterRestart.store.update((entries) => entries)).toEqual([]);
      }),
  );

  it.effect("restores all displaced entries in order on live rejection and replays them", () =>
    Effect.gen(function* () {
      const storage = { value: null as string | null };
      const h = yield* makeHarness({ connected: false, storage });
      yield* Effect.promise(() => h.commands.settle.run(h.registry, target));
      yield* h.reconnect();
      const sent = yield* Queue.take(h.requests);
      yield* Deferred.fail(
        sent.reply,
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006 }),
        }),
      );
      yield* h.disconnect();

      // Offline undo + offline snooze leaves ["unsettle", "snooze"] queued.
      yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
      yield* Effect.promise(() => h.commands.snooze.run(h.registry, snooze));
      h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
        ...SNAPSHOT,
        snapshotSequence: 2,
        threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled", settledAt: CREATED_AT }],
      });
      yield* h.reconnect();
      const failedUndo = yield* Queue.take(h.requests);
      yield* Deferred.fail(
        failedUndo.reply,
        new RpcClientError.RpcClientError({
          reason: new Socket.SocketCloseError({ code: 1006 }),
        }),
      );

      // Definitive server rejection of live settle restores BOTH unsettle and snooze in order.
      const rejectedSettle = h.commands.settle.run(h.registry, target);
      const settleReq = yield* Queue.take(h.requests);
      expect(settleReq.command.type).toBe("thread.settle");
      yield* Deferred.fail(settleReq.reply, new Error("Thread cannot be settled"));
      expect((yield* Effect.promise(() => rejectedSettle))._tag).toBe("Failure");
      expect((yield* h.store.update((e) => e)).map((e) => e.action.type)).toEqual([
        "unsettle",
        "snooze",
      ]);

      // Triggered replay immediately replays unsettle followed by snooze.
      const replayedUndo = yield* Queue.take(h.requests);
      expect(replayedUndo.command.type).toBe("thread.unsettle");
      yield* Deferred.succeed(replayedUndo.reply, { sequence: 3 });
      const replayedSnooze = yield* Queue.take(h.requests);
      expect(replayedSnooze.command.type).toBe("thread.snooze");
      yield* Deferred.succeed(replayedSnooze.reply, { sequence: 4 });
      yield* waitFor(h.registry, h.pendingSyncAtom, (s) => s.size === 0);
      expect(yield* h.store.update((e) => e)).toEqual([]);
    }),
  );

  it.effect(
    "restores persisted displaced entries in order when a replacement is rejected during replay after restart",
    () =>
      Effect.gen(function* () {
        const storage = { value: null as string | null };
        const before = yield* makeHarness({ connected: false, storage });
        yield* Effect.promise(() => before.commands.settle.run(before.registry, target));
        yield* before.reconnect();
        const sent = yield* Queue.take(before.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* before.disconnect();

        // Queue ["unsettle", "snooze"] offline, then let live settle fail transiently.
        yield* Effect.promise(() => before.commands.unsettle.run(before.registry, undo));
        yield* Effect.promise(() => before.commands.snooze.run(before.registry, snooze));
        const serverCommitted: OrchestrationV2ShellSnapshot = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled", settledAt: CREATED_AT }],
        };
        before.registry.set(before.snapshotAtom(ENVIRONMENT_ID), serverCommitted);
        yield* before.reconnect();
        const failedUndo = yield* Queue.take(before.requests);
        yield* Deferred.fail(
          failedUndo.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );

        const transientSettle = before.commands.settle.run(before.registry, target);
        const settleReq = yield* Queue.take(before.requests);
        yield* Deferred.fail(
          settleReq.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        expect((yield* Effect.promise(() => transientSettle))._tag).toBe("Success");
        yield* before.disconnect();

        // Restart into a fresh runtime with the same storage: replay sends settle, gets definitive
        // rejection, restores ["unsettle", "snooze"] from disk, and replays both in order.
        const afterRestart = yield* makeHarness({ connected: false, storage });
        afterRestart.registry.set(afterRestart.snapshotAtom(ENVIRONMENT_ID), serverCommitted);
        yield* afterRestart.reconnect();
        const replayedSettle = yield* Queue.take(afterRestart.requests);
        expect(replayedSettle.command.type).toBe("thread.settle");
        yield* Deferred.fail(replayedSettle.reply, new Error("Thread cannot be settled"));

        const replayedUndo = yield* Queue.take(afterRestart.requests);
        expect(replayedUndo.command.type).toBe("thread.unsettle");
        yield* Deferred.succeed(replayedUndo.reply, { sequence: 3 });
        const replayedSnooze = yield* Queue.take(afterRestart.requests);
        expect(replayedSnooze.command.type).toBe("thread.snooze");
        yield* Deferred.succeed(replayedSnooze.reply, { sequence: 4 });
        yield* waitFor(afterRestart.registry, afterRestart.pendingSyncAtom, (s) => s.size === 0);
        expect(yield* afterRestart.store.update((e) => e)).toEqual([]);
      }),
  );

  it.effect(
    "retries restoring displaced entries without re-sending when live rejection restore write fails",
    () =>
      Effect.gen(function* () {
        const storage = { value: null as string | null };
        const failNextWrite = { value: false };
        const h = yield* makeHarness({ connected: false, storage, failNextWrite });
        yield* Effect.promise(() => h.commands.settle.run(h.registry, target));
        yield* h.reconnect();
        const sent = yield* Queue.take(h.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* h.disconnect();

        yield* Effect.promise(() => h.commands.unsettle.run(h.registry, undo));
        h.registry.set(h.snapshotAtom(ENVIRONMENT_ID), {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, settledOverride: "settled", settledAt: CREATED_AT }],
        });
        yield* h.reconnect();
        const failedUndo = yield* Queue.take(h.requests);
        yield* Deferred.fail(
          failedUndo.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );

        // Live settle swaps cleanly, then server rejects it while the restore write fails transiently.
        const rejectedSettle = h.commands.settle.run(h.registry, target);
        const settleReq = yield* Queue.take(h.requests);
        failNextWrite.value = true;
        yield* Deferred.fail(settleReq.reply, new Error("Thread cannot be settled"));
        expect((yield* Effect.promise(() => rejectedSettle))._tag).toBe("Failure");

        // Replay must NOT re-send the already-rejected settle; it restores unsettle and replays it.
        const replayedUndo = yield* Queue.take(h.requests);
        expect(replayedUndo.command.type).toBe("thread.unsettle");
        yield* Deferred.succeed(replayedUndo.reply, { sequence: 3 });
        yield* waitFor(h.registry, h.pendingSyncAtom, (s) => s.size === 0);
        expect(yield* h.store.update((e) => e)).toEqual([]);
      }),
  );

  it.effect(
    "preserves consecutive write-ahead replacements and unwinds each layer on rejection across restart",
    () =>
      Effect.gen(function* () {
        const storage = { value: null as string | null };
        const snoozeA = {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-02-01T00:00:00.000Z" },
        };
        const snoozeB = {
          environmentId: ENVIRONMENT_ID,
          input: { threadId: THREAD_ID, snoozedUntil: "2099-03-01T00:00:00.000Z" },
        };
        const before = yield* makeHarness({ connected: false, storage });
        yield* Effect.promise(() => before.commands.snooze.run(before.registry, snooze));
        yield* before.reconnect();
        const sent = yield* Queue.take(before.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* before.disconnect();

        // Offline undo queues compensating unsnooze; first live replay fails transiently.
        yield* Effect.promise(() => before.commands.unsnooze.run(before.registry, undo));
        const serverSnoozed: OrchestrationV2ShellSnapshot = {
          ...SNAPSHOT,
          snapshotSequence: 2,
          threads: [{ ...SNAPSHOT.threads[0]!, snoozedUntil: FUTURE, snoozedAt: CREATED_AT }],
        };
        before.registry.set(before.snapshotAtom(ENVIRONMENT_ID), serverSnoozed);
        yield* before.reconnect();
        const failedUndo = yield* Queue.take(before.requests);
        expect(failedUndo.command.type).toBe("thread.unsnooze");
        yield* Deferred.fail(
          failedUndo.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );

        // Replacement A displaces unsnooze and fails transiently.
        const firstReplace = before.commands.snooze.run(before.registry, snoozeA);
        const reqA = yield* Queue.take(before.requests);
        expect(reqA.command).toMatchObject({
          type: "thread.snooze",
          snoozedUntil: "2099-02-01T00:00:00.000Z",
        });
        yield* Deferred.fail(
          reqA.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        expect((yield* Effect.promise(() => firstReplace))._tag).toBe("Success");
        // Fail the immediate live replay retry of A transiently so replay backs off before B runs.
        const retryA = yield* Queue.take(before.requests);
        expect(retryA.command).toMatchObject({
          type: "thread.snooze",
          commandId: reqA.command.commandId,
        });
        yield* Deferred.fail(
          retryA.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );

        // Replacement B displaces A (preserving A and its nested unsnooze) and fails transiently.
        const secondReplace = before.commands.snooze.run(before.registry, snoozeB);
        const reqB = yield* Queue.take(before.requests);
        expect(reqB.command).toMatchObject({
          type: "thread.snooze",
          snoozedUntil: "2099-03-01T00:00:00.000Z",
        });
        yield* Deferred.fail(
          reqB.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        expect((yield* Effect.promise(() => secondReplace))._tag).toBe("Success");
        yield* before.disconnect();

        // After restart: B is rejected -> restores & replays A; A is rejected -> restores & replays unsnooze.
        const afterRestart = yield* makeHarness({ connected: false, storage });
        afterRestart.registry.set(afterRestart.snapshotAtom(ENVIRONMENT_ID), serverSnoozed);
        yield* afterRestart.reconnect();
        const replayedB = yield* Queue.take(afterRestart.requests);
        expect(replayedB.command).toMatchObject({
          type: "thread.snooze",
          snoozedUntil: "2099-03-01T00:00:00.000Z",
        });
        yield* Deferred.fail(replayedB.reply, new Error("Snooze B rejected"));

        const replayedA = yield* Queue.take(afterRestart.requests);
        expect(replayedA.command).toMatchObject({
          type: "thread.snooze",
          commandId: reqA.command.commandId,
          snoozedUntil: "2099-02-01T00:00:00.000Z",
        });
        yield* Deferred.fail(replayedA.reply, new Error("Snooze A rejected"));

        const replayedUndo = yield* Queue.take(afterRestart.requests);
        expect(replayedUndo.command.type).toBe("thread.unsnooze");
        yield* Deferred.succeed(replayedUndo.reply, { sequence: 3 });
        yield* waitFor(afterRestart.registry, afterRestart.pendingSyncAtom, (s) => s.size === 0);
        expect(yield* afterRestart.store.update((e) => e)).toEqual([]);
      }),
  );

  it.effect(
    "recovers the durably persisted replacement settle across offline fallback and restart",
    () =>
      Effect.gen(function* () {
        const storage = { value: null as string | null };
        const failNextWrite = { value: false };
        const before = yield* makeHarness({ connected: false, storage, failNextWrite });
        yield* Effect.promise(() => before.commands.settle.run(before.registry, target));
        yield* before.reconnect();
        const sent = yield* Queue.take(before.requests);
        yield* Deferred.fail(
          sent.reply,
          new RpcClientError.RpcClientError({
            reason: new Socket.SocketCloseError({ code: 1006 }),
          }),
        );
        yield* before.disconnect();

        // Queue compensating unsettle offline, then replace with settle while still offline.
        yield* Effect.promise(() => before.commands.unsettle.run(before.registry, undo));
        const offlineReplace = yield* Effect.promise(() =>
          before.commands.settle.run(before.registry, target),
        );
        expect(offlineReplace._tag).toBe("Success");
        const storedAfterReplace = yield* before.store.update((e) => e);
        expect(storedAfterReplace.map((e) => e.action.type)).toEqual(["settle"]);

        // Restart into a fresh runtime with the same storage: replays the replacement settle.
        const afterRestart = yield* makeHarness({ connected: false, storage });
        yield* afterRestart.reconnect();
        const replayed = yield* Queue.take(afterRestart.requests);
        expect(replayed.command).toMatchObject({
          type: "thread.settle",
          commandId: storedAfterReplace[0]!.commandId,
        });
        yield* Deferred.succeed(replayed.reply, { sequence: 2 });
        yield* waitFor(afterRestart.registry, afterRestart.pendingSyncAtom, (s) => s.size === 0);
      }),
  );
});
