import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectionCatalogBroker from "./ConnectionCatalogBroker.ts";

it.effect("fails immediately without a host", () =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    const error = yield* Effect.flip(broker.invoke({ type: "list" }, 30_000));
    expect(error._tag).toBe("ConnectionCatalogHostUnavailable");
  }).pipe(Effect.provide(ConnectionCatalogBroker.layer)),
);

it.effect("relays requests and ignores unknown ids and responses from another connection", () =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    const pull = yield* Stream.toPull(broker.attach("desktop"));
    const invoke = yield* broker.invoke({ type: "list" }, 30_000).pipe(Effect.forkChild);
    const [request] = yield* pull;
    expect(request.operation).toEqual({ type: "list" });
    expect(request.expiresAt).toBe("1970-01-01T00:00:30.000Z");
    yield* broker.respond("desktop", {
      requestId: "unknown",
      result: { type: "list", connections: [] },
    });
    yield* broker.respond("other", {
      requestId: request.requestId,
      result: { type: "failure", reason: "refused", message: "wrong host" },
    });
    yield* broker.respond("desktop", {
      requestId: request.requestId,
      result: { type: "list", connections: [] },
    });
    expect(yield* Fiber.join(invoke)).toEqual({ type: "list", connections: [] });
  }).pipe(Effect.provide(ConnectionCatalogBroker.layer)),
);

it.effect(
  "prefers the newest host and falls back after detach while failing its pending requests",
  () =>
    Effect.gen(function* () {
      const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
      const older = yield* Stream.toPull(broker.attach("older"));
      const hostScope = yield* Scope.make();
      const newer = yield* Stream.toPull(broker.attach("newer")).pipe(
        Effect.provideService(Scope.Scope, hostScope),
      );
      const invoke = yield* Effect.flip(broker.invoke({ type: "list" }, 30_000)).pipe(
        Effect.forkChild,
      );
      const [request] = yield* newer;
      yield* Scope.close(hostScope, Exit.void);
      expect((yield* Fiber.join(invoke))._tag).toBe("ConnectionCatalogHostDetached");
      yield* broker.respond("newer", {
        requestId: request.requestId,
        result: { type: "list", connections: [] },
      });
      const fallback = yield* broker.invoke({ type: "list" }, 30_000).pipe(Effect.forkChild);
      const [fallbackRequest] = yield* older;
      yield* broker.respond("older", {
        requestId: fallbackRequest.requestId,
        result: { type: "list", connections: [] },
      });
      expect(yield* Fiber.join(fallback)).toEqual({ type: "list", connections: [] });
    }).pipe(Effect.provide(ConnectionCatalogBroker.layer)),
);

it.effect("a duplicate attachment's old finalizer does not detach the new attachment", () =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    const oldScope = yield* Scope.make();
    const oldPull = yield* Stream.toPull(broker.attach("desktop")).pipe(
      Effect.provideService(Scope.Scope, oldScope),
    );
    expect(oldPull).toBeDefined();
    const current = yield* Stream.toPull(broker.attach("desktop"));
    yield* Scope.close(oldScope, Exit.void);
    const invoke = yield* broker.invoke({ type: "list" }, 30_000).pipe(Effect.forkChild);
    const [request] = yield* current;
    yield* broker.respond("desktop", {
      requestId: request.requestId,
      result: { type: "list", connections: [] },
    });
    expect(yield* Fiber.join(invoke)).toEqual({ type: "list", connections: [] });
  }).pipe(Effect.provide(ConnectionCatalogBroker.layer)),
);

it.effect("times out with a tagged error and ignores the late response", () =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    const pull = yield* Stream.toPull(broker.attach("desktop"));
    const invoke = yield* Effect.flip(broker.invoke({ type: "list" }, 30_000)).pipe(
      Effect.forkChild,
    );
    const [request] = yield* pull;
    yield* TestClock.adjust(30_000);
    const error = yield* Fiber.join(invoke);
    expect(error._tag).toBe("ConnectionCatalogTimeout");
    yield* broker.respond("desktop", {
      requestId: request.requestId,
      result: { type: "list", connections: [] },
    });
  }).pipe(Effect.provide(ConnectionCatalogBroker.layer)),
);

it.effect("does not deliver a queued request after it times out", () =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    const pull = yield* Stream.toPull(broker.attach("desktop"));
    const warmup = yield* broker.invoke({ type: "list" }, 30_000).pipe(Effect.forkChild);
    const [warmupRequest] = yield* pull;
    yield* broker.respond("desktop", {
      requestId: warmupRequest.requestId,
      result: { type: "list", connections: [] },
    });
    yield* Fiber.join(warmup);
    const expired = yield* Effect.flip(broker.invoke({ type: "list" }, 30_000)).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust(30_000);
    expect((yield* Fiber.join(expired))._tag).toBe("ConnectionCatalogTimeout");
    const next = yield* broker.invoke({ type: "list" }, 30_000).pipe(Effect.forkChild);
    const [request] = yield* pull;
    expect(request.requestId).toBe("3");
    expect(request.expiresAt).toBe("1970-01-01T00:01:00.000Z");
    yield* broker.respond("desktop", {
      requestId: request.requestId,
      result: { type: "list", connections: [] },
    });
    expect(yield* Fiber.join(next)).toEqual({ type: "list", connections: [] });
  }).pipe(Effect.provide(ConnectionCatalogBroker.layer)),
);

it.effect("tracks active attachments through detach", () =>
  Effect.gen(function* () {
    const broker = yield* ConnectionCatalogBroker.ConnectionCatalogBroker;
    expect(yield* broker.hasHost).toBe(false);
    const hostScope = yield* Scope.make();
    const pull = yield* Stream.toPull(broker.attach("desktop")).pipe(
      Effect.provideService(Scope.Scope, hostScope),
    );
    const invoke = yield* broker.invoke({ type: "list" }, 30_000).pipe(Effect.forkChild);
    const [request] = yield* pull;
    yield* broker.respond("desktop", {
      requestId: request.requestId,
      result: { type: "list", connections: [] },
    });
    yield* Fiber.join(invoke);
    expect(yield* broker.hasHost).toBe(true);
    yield* Scope.close(hostScope, Exit.void);
    expect(yield* broker.hasHost).toBe(false);
  }).pipe(Effect.provide(ConnectionCatalogBroker.layer)),
);
