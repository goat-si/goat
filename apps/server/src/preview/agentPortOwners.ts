import { ThreadId, type DiscoveredLocalServer } from "@goat/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as FileSystem from "effect/FileSystem";
import type * as ProcessRunner from "../processRunner.ts";

const isThreadId = Schema.is(ThreadId);
const devToolsPortArgument = /(?:^|[\s\0])--remote-debugging-port=/;

const threadFromEnvironment = (text: string) => {
  const value = /(?:^|[\s\0])GOAT_THREAD_ID=([^\s\0]+)/.exec(text)?.[1];
  return value && isThreadId(value) ? ThreadId.make(value) : null;
};

export const annotateAgentServers = Effect.fn("PortDiscovery.annotateAgentServers")(
  function* (input: {
    servers: ReadonlyArray<DiscoveredLocalServer>;
    platform: NodeJS.Platform;
    fileSystem: FileSystem.FileSystem;
    runner: ProcessRunner.ProcessRunner["Service"];
    cache: Map<number, ThreadId | null>;
    retry?: () => void;
  }) {
    const pids = [
      ...new Set(
        input.servers.flatMap((server) =>
          server.pid !== null && server.terminal === null ? [server.pid] : [],
        ),
      ),
    ].slice(0, 4096);
    const missing = pids.filter((pid) => !input.cache.has(pid));
    if (missing.length > 256) input.retry?.();
    const unread = missing.slice(0, 256);
    if (input.platform === "linux") {
      yield* Effect.forEach(
        unread,
        (pid) =>
          input.fileSystem.readFileString(`/proc/${pid}/environ`).pipe(
            Effect.flatMap((environment) =>
              input.fileSystem.readFileString(`/proc/${pid}/cmdline`).pipe(
                Effect.map((cmdline) =>
                  devToolsPortArgument.test(cmdline) ? null : threadFromEnvironment(environment),
                ),
                Effect.orElseSucceed(() => threadFromEnvironment(environment)),
              ),
            ),
            Effect.orElseSucceed(() => null),
            Effect.map((value) => input.cache.set(pid, value)),
          ),
        { concurrency: 8, discard: true },
      );
    } else if (input.platform === "darwin" && unread.length > 0) {
      const result = yield* input.runner
        .run({
          command: "ps",
          args: ["-E", "-ww", "-o", "pid=,command=", "-p", unread.join(",")],
          timeout: Duration.seconds(3),
          maxOutputBytes: 1024 * 1024,
        })
        .pipe(Effect.option);
      if (result._tag === "Some" && result.value.code === 0) {
        for (const line of result.value.stdout.split("\n")) {
          const match = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (match?.[1] !== undefined && match[2] !== undefined)
            input.cache.set(
              Number(match[1]),
              devToolsPortArgument.test(match[2]) ? null : threadFromEnvironment(match[2]),
            );
        }
      } else input.retry?.();
    }
    const active = new Set(pids);
    for (const pid of input.cache.keys()) if (!active.has(pid)) input.cache.delete(pid);
    return input.servers.map((server) => {
      const threadId =
        server.pid === null || server.terminal !== null ? null : input.cache.get(server.pid);
      return threadId ? { ...server, agent: { threadId } } : server;
    });
  },
);
