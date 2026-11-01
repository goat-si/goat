// @effect-diagnostics nodeBuiltinImport:off -- The regression holds the native fd callback without opening a descriptor.
import * as NodeFS from "node:fs";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";
import {
  DesktopTelemetryControlFailed,
  writeAllToFileDescriptor,
} from "./DesktopTelemetryReceiver.ts";
import { makeDesktopControlWriter } from "./DesktopControlWriter.ts";
vi.mock("node:fs", { spy: true });

it.effect("scope shutdown settles requests without waiting for a held native frame", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const writing = yield* Deferred.make<void>();
      let complete: (() => void) | undefined;
      const heldWrite = <T extends NodeJS.ArrayBufferView>(
        _fd: number,
        buffer: T,
        _offset: number,
        length: number,
        _position: number | null,
        callback: (error: NodeJS.ErrnoException | null, count: number, buffer: T) => void,
      ) => {
        if (complete === undefined) {
          complete = () => callback(null, 3, buffer);
          Deferred.doneUnsafe(writing, Effect.void);
        } else callback(null, length, buffer);
      };
      using write = vi.spyOn(NodeFS, "write").mockImplementation(heldWrite as typeof NodeFS.write);
      const writer = yield* makeDesktopControlWriter({
        write: (payload) => writeAllToFileDescriptor(5, payload),
        overflow: () =>
          new DesktopTelemetryControlFailed({
            fd: 5,
            operation: "write",
            cause: new Error("admission closed"),
          }),
      }).pipe(Scope.provide(scope));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => complete?.()).pipe(Effect.andThen(Scope.close(scope, Exit.void))),
      );
      const first = yield* writer.send(Buffer.from("partial-frame\n")).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const pending = yield* writer
        .send(Buffer.from("next-frame\n"))
        .pipe(Effect.forkChild({ startImmediately: true }));
      const closing = yield* Scope.close(scope, Exit.void).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("0 millis");
      assert.isTrue((yield* writer.state).closed);
      assert.isDefined(closing.pollUnsafe());
      assert.isTrue(Exit.isFailure(yield* Fiber.await(first)));
      assert.isTrue(Exit.isFailure(yield* Fiber.await(pending)));
      assert.isTrue(
        Exit.isFailure(yield* writer.send(Buffer.from("late-frame\n")).pipe(Effect.exit)),
      );
      assert.equal(write.mock.calls.length, 1);
      complete?.();
      yield* TestClock.adjust("0 millis");
      assert.equal(write.mock.calls.length, 1);
    }),
  ),
);
it.effect("overflow fails pending requests while a held native frame stays charged", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const writer = yield* makeDesktopControlWriter({
        write: () =>
          Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release))),
        overflow: () => new Error("admission closed"),
      });
      yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined));
      const requests: Array<Fiber.Fiber<void, Error>> = [];
      const first = yield* writer.send(Buffer.from("first\n")).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      for (let index = 1; index < 32; index++) {
        requests.push(
          yield* writer
            .send(Buffer.from(`frame-${index}\n`))
            .pipe(Effect.forkChild({ startImmediately: true })),
        );
      }
      assert.equal((yield* writer.state).frames, 32);
      const refused = yield* writer.send(Buffer.from("overflow\n")).pipe(Effect.result);
      assert.equal(refused._tag, "Failure");
      assert.isAtMost((yield* writer.state).bytes, 65536);
      assert.equal((yield* writer.state).frames, 1);
      assert.isTrue((yield* writer.state).closed);
      assert.equal((yield* Fiber.await(first))._tag, "Failure");
      for (const request of requests) assert.equal((yield* Fiber.await(request))._tag, "Failure");
      yield* Deferred.succeed(release, undefined);
    }),
  ),
);
