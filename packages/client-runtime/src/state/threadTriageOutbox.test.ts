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
      status: "idle",
      latestRunId: null,
      latestRun: null,
      pendingRuntimeRequest: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      itemCount: 0,
      hasUnreadActivity: false,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      deletedAt: null,
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
});
