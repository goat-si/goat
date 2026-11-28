import { assert, it } from "@effect/vitest";
import { ThreadId, type DiscoveredLocalServer } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as ProcessRunner from "../processRunner.ts";
import { annotateAgentServers } from "./agentPortOwners.ts";

it.effect("attributes a Linux listener to its inherited thread and forgets exited pids", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cache = new Map<number, ThreadId | null>();
    const server: DiscoveredLocalServer = {
      host: "localhost",
      port: 3000,
      url: "http://localhost:3000",
      processName: "node",
      pid: 123,
      terminal: null,
    };
    const input = {
      platform: "linux" as const,
      fileSystem: fs,
      runner: {} as ProcessRunner.ProcessRunner["Service"],
      cache,
    };
    const result = yield* annotateAgentServers({ ...input, servers: [server] });
    assert.equal(result[0]?.agent?.threadId, ThreadId.make("thread-pi"));
    yield* annotateAgentServers({ ...input, servers: [] });
    assert.equal(cache.size, 0);
  }).pipe(
    Effect.provide(
      FileSystem.layerNoop({
        readFileString: () => Effect.succeed("PATH=/bin\0GOAT_THREAD_ID=thread-pi\0"),
      }),
    ),
  ),
);

it.effect.each(["linux", "darwin"] as const)("does not attribute an agent browser DevTools listener on %s", (platform) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const server: DiscoveredLocalServer = {
      host: "localhost", port: 4321, url: "http://localhost:4321", processName: "chrome", pid: 123, terminal: null,
    };
    const result = yield* annotateAgentServers({
      servers: [server], platform, fileSystem, cache: new Map(),
      runner: { run: () => Effect.succeed({ code: 0, stdout: "123 chrome --remote-debugging-port=0 GOAT_THREAD_ID=thread-pi", stderr: "", timedOut: false }) } as ProcessRunner.ProcessRunner["Service"],
    });
    assert.isUndefined(result[0]?.agent);
  }).pipe(Effect.provide(FileSystem.layerNoop({
    readFileString: (path) => Effect.succeed(path.endsWith("cmdline") ? "chrome\0--remote-debugging-port=0\0" : "GOAT_THREAD_ID=thread-pi\0"),
  }))),
);
