// @effect-diagnostics nodeBuiltinImport:off -- Tests use in-memory child streams.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import { makePenRevoke } from "./PenRevoke.ts";

const pin = { meshId: "m".repeat(26), nodeId: "a".repeat(26), noisePub: "a".repeat(43) };
const child = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    stdin: null,
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
    stdio: [null, new NodeStream.PassThrough(), new NodeStream.PassThrough()],
    kill: () => true,
  });

it.effect("cancel and a departed member never spawn a revoke", () =>
  Effect.gen(function* () {
    let calls = 0;
    let present = true;
    const service = makePenRevoke({
      member: () => Effect.sync(() => (present ? "Trusted name" : undefined)),
      confirm: () =>
        Effect.sync(() => {
          present = false;
          return "remove" as const;
        }),
      resolveBinary: () => Effect.succeed("/pen"),
      spawn: () => {
        calls++;
        return child() as never;
      },
      deadline: "60 seconds",
    });
    assert.equal((yield* service.revoke(pin)).status, "failed");
    assert.equal(calls, 0);
    const cancelled = makePenRevoke({
      member: () => Effect.succeed("Trusted name"),
      confirm: () => Effect.succeed("cancel"),
      resolveBinary: () => Effect.succeed("/pen"),
      spawn: () => {
        calls++;
        return child() as never;
      },
      deadline: "60 seconds",
    });
    assert.equal((yield* cancelled.revoke(pin)).status, "cancelled");
    assert.equal(calls, 0);
  }),
);

it.effect("uses the main-owned name and exact argv including the compromised flag", () =>
  Effect.gen(function* () {
    const proc = child();
    const started = yield* Deferred.make<void>();
    let args: readonly string[] = [];
    let name = "";
    let shell: unknown;
    const service = makePenRevoke({
      member: () => Effect.succeed("Trusted name"),
      confirm: (value) =>
        Effect.sync(() => {
          name = value;
          return "remove-compromised" as const;
        }),
      resolveBinary: () => Effect.succeed("/pen"),
      spawn: (_binary, value, options) => {
        args = value;
        shell = options.shell;
        return proc as never;
      },
      deadline: "60 seconds",
      onSpawn: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
    });
    const fiber = yield* Effect.forkChild(service.revoke(pin));
    yield* Deferred.await(started);
    proc.stdout.write("removed\n");
    proc.emit("close", 0, null);
    assert.deepEqual(yield* Fiber.join(fiber), { status: "revoked", output: "removed" });
    assert.equal(name, "Trusted name");
    assert.equal(shell, false);
    assert.deepEqual(args, [
      "revoke",
      "--node",
      pin.nodeId,
      "--noise",
      pin.noisePub,
      "--compromised",
    ]);
  }),
);

it.effect("deadline kills the child and a concurrent request is refused", () =>
  Effect.gen(function* () {
    const proc = child();
    let killed = false;
    proc.kill = () => {
      killed = true;
      return true;
    };
    const started = yield* Deferred.make<void>();
    const service = makePenRevoke({
      member: () => Effect.succeed("name"),
      confirm: () => Effect.succeed("remove"),
      resolveBinary: () => Effect.succeed("/pen"),
      spawn: () => proc as never,
      deadline: "60 seconds",
      onSpawn: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
    });
    const fiber = yield* Effect.forkChild(service.revoke(pin));
    yield* Deferred.await(started);
    assert.equal((yield* service.revoke(pin)).status, "failed");
    yield* TestClock.adjust("60 seconds");
    const result = yield* Fiber.join(fiber);
    assert.equal(result.status, "failed");
    assert.isTrue(killed);
    assert.equal((yield* service.revoke(pin)).status, "failed");
    proc.emit("close", null, "SIGKILL");
    if (result.status === "failed") assert.include(result.message, "check pen ls");
  }),
);

it.effect("reports missing binary, spawn errors and Pen exit failures", () =>
  Effect.gen(function* () {
    const base = {
      member: () => Effect.succeed("name"),
      confirm: () => Effect.succeed("remove" as const),
      deadline: "60 seconds" as const,
    };
    const missing = makePenRevoke({
      ...base,
      resolveBinary: () => Effect.sync((): string | undefined => undefined),
      spawn: () => {
        throw new Error("unexpected");
      },
    });
    assert.equal((yield* missing.revoke(pin)).status, "failed");
    const thrown = makePenRevoke({
      ...base,
      resolveBinary: () => Effect.succeed("/pen"),
      spawn: () => {
        throw new Error("spawn error");
      },
    });
    const error = yield* thrown.revoke(pin);
    assert.equal(error.status, "failed");
    for (const code of [1, 2]) {
      const proc = child();
      const started = yield* Deferred.make<void>();
      let args: readonly string[] = [];
      const service = makePenRevoke({
        ...base,
        resolveBinary: () => Effect.succeed("/pen"),
        spawn: (_path, value) => {
          args = value;
          return proc as never;
        },
        onSpawn: Deferred.succeed(started, undefined).pipe(Effect.asVoid),
      });
      const fiber = yield* Effect.forkChild(service.revoke(pin));
      yield* Deferred.await(started);
      proc.emit("close", code, null);
      const result = yield* Fiber.join(fiber);
      assert.equal(result.status, "failed");
      if (result.status === "failed" && code === 2) assert.include(result.message, "Update Pen");
      assert.deepEqual(args, ["revoke", "--node", pin.nodeId, "--noise", pin.noisePub]);
    }
  }),
);

it.effect(
  "keeps what it reads and what it shows of Pen's output bounded, and reports asynchronous spawn errors",
  () =>
    Effect.gen(function* () {
      const base = {
        member: () => Effect.succeed("name"),
        confirm: () => Effect.succeed("remove" as const),
        resolveBinary: () => Effect.succeed("/pen"),
        deadline: "60 seconds" as const,
      };
      const first = child();
      const ready = yield* Deferred.make<void>();
      const service = makePenRevoke({
        ...base,
        spawn: () => first as never,
        onSpawn: Deferred.succeed(ready, undefined).pipe(Effect.asVoid),
      });
      const fiber = yield* Effect.forkChild(service.revoke(pin));
      yield* Deferred.await(ready);
      first.stdout.write("x".repeat(70000));
      first.emit("close", 0, null);
      const result = yield* Fiber.join(fiber);
      assert.equal(result.status, "revoked");
      if (result.status === "revoked") assert.equal(result.output.length, 600);
      const second = child();
      const next = yield* Deferred.make<void>();
      const errorService = makePenRevoke({
        ...base,
        spawn: () => second as never,
        onSpawn: Deferred.succeed(next, undefined).pipe(Effect.asVoid),
      });
      const failedFiber = yield* Effect.forkChild(errorService.revoke(pin));
      yield* Deferred.await(next);
      second.emit("error", new Error("spawn failed"));
      const failedResult = yield* Fiber.join(failedFiber);
      assert.equal(failedResult.status, "failed");
      second.emit("close", null, null);
    }),
);
