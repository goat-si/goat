// @effect-diagnostics nodeBuiltinImport:off -- Checks the real spawned probe's handle ownership.
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { buildClaudeCapabilitiesProbeQueryOptions } from "./ClaudeProvider.ts";

it.live("runs the Windows Claude capability probe off the server thread", () => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const options = buildClaudeCapabilitiesProbeQueryOptions({
      executablePath: "/fixture/claude",
      abortController: abort,
      environment: {},
      cwd: undefined,
      managedMcpConfig: true,
      spawnOnWorker: true,
    });
    if (!options.spawnClaudeCodeProcess)
      return yield* Effect.die("Windows probe has no process launcher");
    const child = options.spawnClaudeCodeProcess({
      command: process.execPath,
      args: ["-e", "process.stdout.write('ready'); process.stdin.resume()"],
      env: {},
      signal: abort.signal,
    });
    const ready = Promise.withResolvers<string>();
    child.stdout.once("data", (chunk: Buffer) => ready.resolve(chunk.toString()));
    child.stdout.once("error", ready.reject);
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        child.kill("SIGKILL");
      }),
    );
    expect(yield* Effect.promise(() => ready.promise)).toBe("ready");
    expect(process.getActiveResourcesInfo()).not.toContain("ProcessWrap");
  }).pipe(Effect.scoped);
});
