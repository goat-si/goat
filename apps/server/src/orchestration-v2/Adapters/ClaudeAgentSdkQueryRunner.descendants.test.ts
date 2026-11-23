// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@goat/contracts";
import { ProviderEventLoggers } from "@goat/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ClaudeAgentSdkQueryRunner, layerQueryRunner } from "./ClaudeAgentSdkQueryRunner.ts";

function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process tree", () => {
  it.effect("reads the CLI's process tree once when its turn ends and not while it is idle", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          `while read -r line; do case "$line" in *'"type":"user"'*) break;; esac; done`,
          `perl -e 'setpgrp(0, 0); exec @ARGV' sleep 600 > "$dir/alive" &`,
          'echo $! > "$dir/leftover.pid"',
          `echo '{"type":"result","subtype":"success","is_error":false,"result":"done","session_id":"native-session-fake-cli"}'`,
          'read -r _ < "$dir/exit"',
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "exit")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();
      let listings = 0;
      const countingSpawner = Layer.effect(
        ChildProcessSpawner.ChildProcessSpawner,
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          return ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.command === "ps") listings += 1;
            return spawner.spawn(command);
          });
        }),
      ).pipe(Layer.provide(NodeServices.layer));

      const session = yield* Effect.gen(function* () {
        const runner = yield* ClaudeAgentSdkQueryRunner;
        return yield* runner.open({
          threadId: ThreadId.make("thread-fake-cli"),
          providerSessionId: ProviderSessionId.make("session-fake-cli"),
          options: {
            sessionId: "native-session-fake-cli",
            model: "claude-sonnet-4-6",
            tools: [],
            permissionMode: "default",
            pathToClaudeCodeExecutable: cli,
          },
        });
      }).pipe(
        Effect.provide(
          layerQueryRunner.pipe(
            Layer.provide(countingSpawner),
            Layer.provide(
              Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
            ),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      );
      const turnEnded = yield* Deferred.make<void>();
      yield* session.messages.pipe(
        Stream.tap((message) =>
          message.type === "result" ? Deferred.succeed(turnEnded, undefined) : Effect.void,
        ),
        Stream.runDrain,
        Effect.ignore,
        Effect.forkScoped,
      );
      yield* session.offer({
        type: "user",
        message: { role: "user", content: "Start a job." },
        parent_tool_use_id: null,
        session_id: "native-session-fake-cli",
      });
      yield* Deferred.await(turnEnded);
      const listingsAtTurnEnd = listings;
      yield* TestClock.adjust("1 minute");
      // The CLI exits on its own, so only the turn-end read can have recorded the job.
      yield* Effect.promise(() => NodeFS.promises.writeFile(NodePath.join(dir, "exit"), "\n"));
      yield* Effect.promise(() => leftoverStopped);
      assert.equal(listings, listingsAtTurnEnd + 1);
    }),
  );
});
