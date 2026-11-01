import { assert, it } from "@effect/vitest";
import * as NodeWorkerThreads from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import { makeWriter } from "./nodeSqliteWriter.ts";

it.effect.each(["interrupt", "scope close"] as const)(
  "cancels healthy writer initialization without a fatal notification (%s)",
  (cancellation) =>
    Effect.gen(function* () {
      const initializing = yield* Deferred.make<NodeWorkerThreads.Worker>();
      const failures: Array<unknown> = [];
      const workerErrors: Array<unknown> = [];
      const post = NodeWorkerThreads.Worker.prototype.postMessage;
      using _hold = vi
        .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
        .mockImplementation(function (this: NodeWorkerThreads.Worker, message, ...rest) {
          if (message?.type === "initialize") {
            this.on("error", (error) => workerErrors.push(error));
            Deferred.doneUnsafe(initializing, Effect.succeed(this));
            return;
          }
          return post.call(this, message, ...rest);
        });
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const starting = yield* makeWriter(
        {
          filename: ":memory:",
          onFatalPersistence: (cause) => failures.push(cause),
        },
        (effect) => effect,
        () => new Error("unsupported stream"),
        () => undefined,
      ).pipe(Effect.scoped, Effect.forkIn(scope));
      const worker = yield* Deferred.await(initializing);
      if (cancellation === "interrupt") yield* Fiber.interrupt(starting);
      else yield* Scope.close(scope, Exit.void);
      const result = yield* Fiber.await(starting);
      assert.isTrue(Exit.isFailure(result) && Cause.hasInterruptsOnly(result.cause));
      assert.equal(worker.threadId, -1, "cancellation must await native retirement");
      assert.deepEqual(workerErrors, []);
      assert.deepEqual(failures, [], "intentional cancellation must not retire the server");
    }).pipe(Effect.scoped),
);

it.effect.each(["timeout", "worker failure"] as const)(
  "still reports a permanent initialization failure once (%s)",
  (failure) =>
    Effect.gen(function* () {
      const initializing = yield* Deferred.make<NodeWorkerThreads.Worker>();
      const failures: Array<unknown> = [];
      const post = NodeWorkerThreads.Worker.prototype.postMessage;
      using _hold = vi
        .spyOn(NodeWorkerThreads.Worker.prototype, "postMessage")
        .mockImplementation(function (this: NodeWorkerThreads.Worker, message, ...rest) {
          if (message?.type === "initialize") {
            Deferred.doneUnsafe(initializing, Effect.succeed(this));
            return;
          }
          return post.call(this, message, ...rest);
        });
      const starting = yield* makeWriter(
        { filename: ":memory:", onFatalPersistence: (cause) => failures.push(cause) },
        (effect) => effect,
        () => new Error("unsupported stream"),
        () => undefined,
      ).pipe(Effect.scoped, Effect.exit, Effect.forkChild);
      const worker = yield* Deferred.await(initializing);
      if (failure === "timeout") yield* TestClock.adjust("10 seconds");
      else worker.emit("error", new Error("worker initialization failed"));
      assert.isTrue(Exit.isFailure(yield* Fiber.join(starting)));
      assert.equal(worker.threadId, -1);
      assert.equal(failures.length, 1);
    }).pipe(Effect.scoped),
);
