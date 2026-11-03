// @effect-diagnostics nodeBuiltinImport:off - Drives real child processes and their pipes.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { guardChild, guardErrors } from "./errorGuards.ts";

// Never reads stdin, so a large write stays pending until the child is killed. On Windows a child
// that closes fd 0 leaves the parent's write queued forever, so killing is the portable trigger.
const UNREAD_STDIN_CHILD = "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";

const spawnScoped = (script: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }),
    ),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  );

it.live(
  "a guarded child's failed stdin write reaches stdinRoute instead of ending the process",
  () =>
    Effect.gen(function* () {
      const stdinErrors = Promise.withResolvers<Error>();
      const childErrors: Error[] = [];
      const child = yield* spawnScoped(UNREAD_STDIN_CHILD);
      guardChild(child, (error) => childErrors.push(error), stdinErrors.resolve);
      yield* Effect.promise(
        () => new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
      );
      child.stdin.write("x".repeat(1 << 20));
      expect(child.stdin.writableLength).toBeGreaterThan(0);
      child.kill("SIGKILL");
      const error = yield* Effect.promise(() => stdinErrors.promise);
      // POSIX reports the broken pipe as EPIPE, Windows as EOF.
      expect(["EPIPE", "EOF"]).toContain(Reflect.get(error, "code"));
      expect(Reflect.get(error, "syscall")).toBe("write");
      expect(childErrors).toEqual([]);
    }).pipe(Effect.scoped),
);

it.live("a guarded child's stdout and stderr errors reach the child's route", () =>
  Effect.gen(function* () {
    const routed: string[] = [];
    const bothRouted = Promise.withResolvers<void>();
    const child = yield* spawnScoped("setInterval(() => {}, 1000);");
    guardChild(
      child,
      (error) => {
        routed.push(error.message);
        if (routed.length === 2) bothRouted.resolve();
      },
      () => routed.push("stdin"),
    );
    child.stdout.destroy(new Error("stdout broke"));
    child.stderr.destroy(new Error("stderr broke"));
    yield* Effect.promise(() => bothRouted.promise);
    expect(routed.toSorted()).toEqual(["stderr broke", "stdout broke"]);
  }).pipe(Effect.scoped),
);

it("guardErrors hears an error emitted right after creation", () => {
  const routed: Error[] = [];
  const failure = new Error("early");
  const emitter = guardErrors(new NodeEvents.EventEmitter(), (error) => routed.push(error));
  emitter.emit("error", failure);
  expect(routed).toEqual([failure]);
});
