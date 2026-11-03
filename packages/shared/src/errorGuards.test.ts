// @effect-diagnostics nodeBuiltinImport:off - Drives real child processes and their pipes.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { guardChild, guardErrors } from "./errorGuards.ts";

// A live child that holds its stdin closed, so the parent's next write fails with EPIPE.
const CLOSED_STDIN_CHILD =
  "require('node:fs').closeSync(0); process.stdout.write('ready\\n'); setInterval(() => {}, 1000);";

const spawnScoped = (script: string) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      NodeChildProcess.spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }),
    ),
    (child) => Effect.sync(() => child.kill("SIGKILL")),
  );

it.live("a guarded child's stdin EPIPE reaches stdinRoute instead of ending the process", () =>
  Effect.gen(function* () {
    const stdinErrors = Promise.withResolvers<Error>();
    const childErrors: Error[] = [];
    const child = yield* spawnScoped(CLOSED_STDIN_CHILD);
    guardChild(child, (error) => childErrors.push(error), stdinErrors.resolve);
    yield* Effect.promise(
      () => new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
    );
    child.stdin.write("x".repeat(70_000));
    const error = yield* Effect.promise(() => stdinErrors.promise);
    expect(Reflect.get(error, "code")).toBe("EPIPE");
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
