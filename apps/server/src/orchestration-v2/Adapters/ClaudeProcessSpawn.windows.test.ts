// @effect-diagnostics nodeBuiltinImport:off -- Exercises the SDK's real process boundary.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { spawnClaudeWindowsProcess, watchClaudeProcess } from "./ClaudeProcessSpawn.ts";

it.live(
  "the Windows Claude CLI launch does not own a native process handle on the server thread",
  () =>
    Effect.gen(function* () {
      const ready = Promise.withResolvers<string>();
      const signal = yield* Effect.abortSignal;
      const child = spawnClaudeWindowsProcess(
        {
          command: process.execPath,
          args: ["-e", "process.stdout.write('ready'); process.stdin.resume()"],
          env: {},
          signal,
        },
        () => {},
      );
      child.stdout.once("data", (data: Buffer) => ready.resolve(data.toString()));
      child.stdout.once("error", ready.reject);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          child.kill("SIGKILL");
        }),
      );
      expect(yield* Effect.promise(() => ready.promise)).toBe("ready");
      expect(process.getActiveResourcesInfo()).not.toContain("ProcessWrap");
    }).pipe(Effect.scoped),
);

it.live("registers the worker child after its PID arrives", () =>
  Effect.gen(function* () {
    const watched = Promise.withResolvers<number>();
    const signal = yield* Effect.abortSignal;
    const child = spawnClaudeWindowsProcess(
      {
        command: process.execPath,
        args: ["-e", "process.stdin.resume()"],
        env: {},
        signal,
      },
      () => {},
    );
    watchClaudeProcess(child, (process) => watched.resolve(process.pid));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        child.kill("SIGKILL");
      }),
    );
    expect(yield* Effect.promise(() => watched.promise)).toBeGreaterThan(0);
  }).pipe(Effect.scoped),
);
