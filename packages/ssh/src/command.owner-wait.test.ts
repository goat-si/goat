import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { lazyChildProcessSpawner } from "@goat/shared/testing/lazyChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import { runSshCommand } from "./command.ts";
import { makeRunningProcess } from "./tunnel.fixture.ts";

const target = { alias: "devbox", hostname: "devbox", username: null, port: null };
const marker = "GOAT_HOME_OWNER_WAITING\n";

it.effect("keeps the initial launch deadline when no owner wait is reported", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const spawner = lazyChildProcessSpawner(() =>
      Deferred.succeed(started, undefined).pipe(Effect.as(makeRunningProcess(() => {}))),
    );
    const fiber = yield* Effect.forkChild(
      Effect.result(runSshCommand(target, { timeoutMs: 90_000, ownerWaitTimeoutMs: 270_000 })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust(Duration.seconds(90));
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.include(result.failure.message, "90000ms");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, TestClock.layer()))),
);

it.effect("does not treat a marker embedded in a long stderr line as an owner wait", () =>
  Effect.gen(function* () {
    const seen = yield* Deferred.make<void>();
    const child = makeRunningProcess(() => {});
    const spawner = lazyChildProcessSpawner(() =>
      Effect.succeed({
        ...child,
        stderr: Stream.fromIterable([
          new TextEncoder().encode("a".repeat(600)),
          new TextEncoder().encode(marker),
        ]).pipe(Stream.ensuring(Deferred.succeed(seen, undefined))),
      }),
    );
    const fiber = yield* Effect.forkChild(
      Effect.result(runSshCommand(target, { timeoutMs: 90_000, ownerWaitTimeoutMs: 270_000 })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    );
    yield* Deferred.await(seen);
    yield* TestClock.adjust(Duration.seconds(270));
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) assert.include(result.failure.message, "90000ms");
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, TestClock.layer()))),
);

it.effect("extends only a launch that has reported an owner wait", () =>
  Effect.gen(function* () {
    const seen = yield* Deferred.make<void>();
    const child = makeRunningProcess(() => {});
    const spawner = lazyChildProcessSpawner(() =>
      Effect.succeed({
        ...child,
        stdout: Stream.make(new TextEncoder().encode('{"status":"ready"}\n')),
        stderr: Stream.make(new TextEncoder().encode(`diagnostic before wait\n${marker}`)).pipe(
          Stream.ensuring(Deferred.succeed(seen, undefined)),
        ),
        exitCode: Effect.sleep(Duration.seconds(200)).pipe(
          Effect.as(ChildProcessSpawner.ExitCode(0)),
        ),
      }),
    );
    const fiber = yield* Effect.forkChild(
      Effect.result(runSshCommand(target, { timeoutMs: 90_000, ownerWaitTimeoutMs: 270_000 })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    );
    yield* Deferred.await(seen);
    yield* TestClock.adjust(Duration.seconds(200));
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isSuccess(result));
    if (Result.isSuccess(result)) assert.include(result.success.stdout, '"status":"ready"');
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, TestClock.layer()))),
);

it.effect("reports an owner that does not become ready by the extended deadline", () =>
  Effect.gen(function* () {
    const seen = yield* Deferred.make<void>();
    const child = makeRunningProcess(() => {});
    const spawner = lazyChildProcessSpawner(() =>
      Effect.succeed({
        ...child,
        stderr: Stream.make(new TextEncoder().encode(`diagnostic before wait\n${marker}`)).pipe(
          Stream.ensuring(Deferred.succeed(seen, undefined)),
        ),
      }),
    );
    const fiber = yield* Effect.forkChild(
      Effect.result(runSshCommand(target, { timeoutMs: 90_000, ownerWaitTimeoutMs: 270_000 })).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
    );
    yield* Deferred.await(seen);
    yield* TestClock.adjust(Duration.seconds(270));
    const result = yield* Fiber.join(fiber);
    assert.isTrue(Result.isFailure(result));
    if (Result.isFailure(result)) {
      assert.include(result.failure.message, "did not become ready");
      assert.notInclude(result.failure.message, marker.trim());
      if (result.failure._tag === "SshCommandError") {
        assert.notInclude(result.failure.stderr, marker.trim());
        assert.include(result.failure.stderr, "diagnostic before wait");
      }
    }
  }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, TestClock.layer()))),
);
