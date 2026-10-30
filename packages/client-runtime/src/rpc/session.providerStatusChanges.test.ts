import {
  ProviderDriverKind,
  ProviderInstanceId,
  WS_METHODS,
  type ServerConfigStreamEvent,
  type ServerProvider,
} from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { applyServerConfigProjection } from "../state/serverConfigProjection.ts";
import {
  awaitRequest,
  awaitSocket,
  completeInitialConfig,
  decodeJson,
  encodeJson,
  encodeServerConfig,
  isRpcRequest,
  makeFactory,
  type TestWebSocket,
} from "./sessionTestHarness.ts";
import { PREPARED, SERVER_CONFIG } from "./sessionTestFixtures.ts";

const provider = (instanceId: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-30T00:00:00.000Z",
  models: [{ slug: instanceId + "-model", name: "Model", isCustom: false, capabilities: null }],
  slashCommands: [{ name: "review" }],
  skills: [{ name: "skill", path: "/skills/" + instanceId, enabled: true }],
});
const codex = provider("codex");
const claude = provider("claude");
const unreadableCodex = { ...codex, status: "a-status-from-a-newer-server" };
const snapshot = (providers: ReadonlyArray<unknown>) => ({
  version: 1,
  type: "snapshot",
  config: { ...encodeServerConfig(SERVER_CONFIG), providers },
});
const unreadableChange = {
  version: 1,
  type: "providerStatusChanges",
  payload: {
    instanceIds: ["codex", "claude"],
    changedInstanceIds: ["codex"],
    providers: [unreadableCodex],
  },
};
const fullList = (providers: ReadonlyArray<unknown>) => ({
  version: 1,
  type: "providerStatuses",
  payload: { providers },
});
const send = (socket: TestWebSocket, requestId: string | number, values: ReadonlyArray<unknown>) =>
  socket.serverMessage(encodeJson({ _tag: "Chunk", requestId, values }));
const sentMessages = (socket: TestWebSocket) => socket.sent.map((message) => decodeJson(message));
const configRequests = (socket: TestWebSocket) =>
  sentMessages(socket)
    .filter(isRpcRequest)
    .filter((request) => request.tag === WS_METHODS.subscribeServerConfig);
const interrupted = (socket: TestWebSocket, requestId: string | number) =>
  sentMessages(socket).some(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      (message as { _tag?: unknown })._tag === "Interrupt" &&
      String((message as { requestId?: unknown }).requestId) === String(requestId),
  );
const providerIdsAfter = (events: ReadonlyArray<ServerConfigStreamEvent>) =>
  Option.getOrThrow(
    events.reduce(
      applyServerConfigProjection,
      Option.none() as Parameters<typeof applyServerConfigProjection>[0],
    ),
  ).config.providers;

const connected = Effect.gen(function* () {
  const { factory, sockets } = yield* makeFactory();
  const session = yield* factory.connect(PREPARED);
  const ready = yield* Effect.forkChild(session.ready);
  const socket = yield* awaitSocket(sockets);
  socket.open();
  yield* completeInitialConfig(socket, snapshot([codex, claude]).config);
  yield* Fiber.join(ready);
  return { session, socket };
});

it.effect("a change the client cannot read switches the session to full provider lists, once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, socket } = yield* connected;
      const changes = yield* awaitRequest(socket, 0);
      expect(changes.payload).toMatchObject({ providerStatusChanges: true });

      const afterSwitch = yield* session
        .subscribeServerConfig({})
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      // Plays the server for a second config subscription, if the session opens one.
      const server = yield* Effect.gen(function* () {
        const full = yield* awaitRequest(socket, 1);
        send(socket, full.id, [snapshot([codex, claude])]);
        return full;
      }).pipe(Effect.forkChild({ startImmediately: true }));
      send(socket, changes.id, [unreadableChange]);

      const events = Array.from(yield* Fiber.join(afterSwitch));
      expect(events.map((event) => event.type)).toEqual(["snapshot", "snapshot"]);
      const full = yield* Fiber.join(server);
      expect(full.payload).toMatchObject({ workspaceSnapshotsOnDemand: true });
      expect(full.payload).not.toHaveProperty("providerStatusChanges");
      expect(interrupted(socket, changes.id)).toBe(true);
      expect(providerIdsAfter(events)).toEqual([codex, claude]);

      // Full lists from here on: an unreadable provider drops out and nothing resubscribes.
      const later = yield* session
        .subscribeServerConfig({})
        .pipe(Stream.take(3), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      send(socket, full.id, [fullList([unreadableCodex, claude]), fullList([codex, claude])]);
      const laterEvents = Array.from(yield* Fiber.join(later));
      expect(providerIdsAfter(laterEvents.slice(0, 2))).toEqual([claude]);
      expect(providerIdsAfter(laterEvents)).toEqual([codex, claude]);
      expect(configRequests(socket)).toHaveLength(2);
    }),
  ),
);

it.effect("a subscription with other options also switches to full provider lists once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, socket } = yield* connected;
      const other = yield* session
        .subscribeServerConfig({ environmentThemes: true })
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild({ startImmediately: true }));
      const changes = yield* awaitRequest(socket, 1);
      expect(changes.payload).toMatchObject({
        environmentThemes: true,
        providerStatusChanges: true,
      });
      const server = yield* Effect.gen(function* () {
        const full = yield* awaitRequest(socket, 2);
        send(socket, full.id, [snapshot([codex, claude])]);
        return full;
      }).pipe(Effect.forkChild({ startImmediately: true }));
      send(socket, changes.id, [snapshot([codex, claude]), unreadableChange]);

      const events = Array.from(yield* Fiber.join(other));
      expect(events.map((event) => event.type)).toEqual(["snapshot", "snapshot"]);
      const full = yield* Fiber.join(server);
      expect(full.payload).toMatchObject({ environmentThemes: true });
      expect(full.payload).not.toHaveProperty("providerStatusChanges");
      expect(configRequests(socket)).toHaveLength(3);
    }),
  ),
);

it.effect("an explicit providerStatusChanges flag never reaches the full-list subscription", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, socket } = yield* connected;
      yield* session
        .subscribeServerConfig({ providerStatusChanges: true })
        .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
      const changes = yield* awaitRequest(socket, 1);
      expect(changes.payload).toMatchObject({ providerStatusChanges: true });
      send(socket, changes.id, [snapshot([codex, claude]), unreadableChange]);
      const full = yield* awaitRequest(socket, 2);
      expect(full.payload).not.toHaveProperty("providerStatusChanges");
    }),
  ),
);

it.effect("an explicit false keeps the first subscription on full provider lists", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { session, socket } = yield* connected;
      yield* session
        .subscribeServerConfig({ providerStatusChanges: false })
        .pipe(Stream.runDrain, Effect.forkChild({ startImmediately: true }));
      const first = yield* awaitRequest(socket, 1);
      expect(first.payload).toMatchObject({ providerStatusChanges: false });
    }),
  ),
);

it.effect(
  "a full-list subscription that never answers ends the config stream after 75 seconds",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { session, socket } = yield* connected;
        const closed = yield* session.closed.pipe(
          Effect.flip,
          Effect.forkChild({ startImmediately: true }),
        );
        const changes = yield* awaitRequest(socket, 0);
        send(socket, changes.id, [unreadableChange]);
        yield* awaitRequest(socket, 1);
        // The socket stays alive (a Pong within every silence budget); only the new RPC is quiet.
        for (const _step of Array.from({ length: 8 })) {
          yield* TestClock.adjust("10 seconds");
          socket.serverMessage(encodeJson({ _tag: "Pong" }));
        }
        const outcome = yield* Fiber.join(closed).pipe(
          Effect.timeoutOption("1 second"),
          Effect.forkChild({ startImmediately: true }),
        );
        yield* TestClock.adjust("1 second");
        const error = Option.getOrThrowWith(
          yield* Fiber.join(outcome),
          () => new Error("the config stream kept waiting for the full-list subscription"),
        );
        expect(error).toMatchObject({ reason: "transport" });
        expect(error.message).toContain("full provider lists");
      }),
    ),
);
