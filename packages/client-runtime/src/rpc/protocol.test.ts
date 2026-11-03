import { expect, it } from "@effect/vitest";
import { WS_METHODS } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import * as TestClock from "effect/testing/TestClock";
import { makeWsRpcSocketProtocol, WsRpcGroup } from "./protocol.ts";

it("activates the 15 core, four administration and one import route", () => {
  const methods = [...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("memory."));
  expect(methods).toHaveLength(20);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyGet);
  expect(methods).toContain(WS_METHODS.memoryOwnerSourceReadPolicyUpdate);
  expect(methods).toContain(WS_METHODS.memoryResetReportAttempts);
  expect(methods).toContain(WS_METHODS.memoryHubReconcile);
  expect(methods).toContain(WS_METHODS.memoryChanges);
  expect(methods).toContain(WS_METHODS.memoryImportProvider);
});

it("installs every hub node RPC for web, desktop and mobile clients", () => {
  expect([...WsRpcGroup.requests.keys()].filter((tag) => tag.startsWith("hub.nodes."))).toEqual([
    "hub.nodes.list",
    "hub.nodes.subscribe",
    "hub.nodes.add",
    "hub.nodes.remove",
    "hub.nodes.check",
    "hub.nodes.import",
    "hub.nodes.dismissNotice",
  ]);
});

it.effect(
  "saturated server, no network event: socket kept through 299 s of silence, torn down at 300 s",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const expired = yield* Deferred.make<void>();
        const frames = yield* Queue.unbounded<readonly [string]>();
        const socket = Socket.make({
          reader: Deferred.succeed(entered, undefined).pipe(
            Effect.as({
              pull: Queue.take(frames),
              upgrade: () => Effect.void,
            }),
          ),
          writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
        });
        const protocol = yield* makeWsRpcSocketProtocol(
          Deferred.succeed(expired, undefined).pipe(Effect.asVoid),
          undefined,
          Effect.void,
        ).pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provide(RpcSerialization.layerJson),
        );
        yield* protocol.run(1, () => Effect.void).pipe(Effect.forkScoped);
        yield* Deferred.await(entered);
        yield* TestClock.adjust("299 seconds");
        expect(yield* Deferred.isDone(expired)).toBe(false);
        yield* TestClock.adjust("1 second");
        expect(yield* Deferred.isDone(expired)).toBe(true);
      }),
    ),
);

it.effect.each([15, 60] as const)("logs slow after %s seconds of credited silence", (seconds) =>
  Effect.scoped(
    Effect.gen(function* () {
      const logs: unknown[] = [];
      const started = yield* Deferred.make<void>();
      const frames = yield* Queue.unbounded<readonly [string]>();
      const socket = Socket.make({
        reader: Deferred.succeed(started, undefined).pipe(
          Effect.as({ pull: Queue.take(frames), upgrade: () => Effect.void }),
        ),
        writer: Effect.succeed({ write: () => Effect.void, writeAll: () => Effect.void }),
      });
      yield* Effect.gen(function* () {
        const protocol = yield* makeWsRpcSocketProtocol(
          Effect.void,
          Duration.seconds(seconds),
          Effect.void,
        ).pipe(
          Effect.provideService(Socket.Socket, socket),
          Effect.provide(RpcSerialization.layerJson),
        );
        yield* protocol.run(1, () => Effect.void).pipe(Effect.forkScoped);
        yield* Deferred.await(started);
        yield* TestClock.adjust(`${seconds - 1} seconds`);
        expect(logs).toHaveLength(0);
        yield* TestClock.adjust("1 second");
        expect(logs).toHaveLength(1);
        yield* TestClock.adjust("10 seconds");
        expect(logs).toHaveLength(1);
      }).pipe(
        Effect.provide(
          Logger.layer([Logger.make(({ message }) => logs.push(message))], {
            mergeWithExisting: false,
          }),
        ),
      );
    }),
  ),
);
