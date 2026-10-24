// @effect-diagnostics nodeBuiltinImport:off -- These tests run real shell processes to prove group ownership.
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import { onTestFinished } from "vite-plus/test";

import { killDriverGroup, spawnDriverProcess } from "./driverProcess.ts";

const platform = HostProcess.Platform.defaultValue();

// A shell and its own child both hold the pipe: it closes only when neither is left. The child
// ends on its own within a minute, so even a test runner killed mid-test leaves nothing behind.
const pairLike = () => {
  const child = spawnDriverProcess(platform, "/bin/sh", ["-c", "sleep 60 & echo started; wait"], {
    PATH: "/bin:/usr/bin",
  });
  // A failed or timed-out test still ends its group; a no-op once the group is gone.
  onTestFinished(() => killDriverGroup(platform, child, "SIGKILL"));
  return child;
};
// Ready once the shell has started its own child, so there is a grandchild to end.
const started = (child: ReturnType<typeof pairLike>) =>
  Effect.promise(() => new Promise<void>((resolve) => child.stdout.once("data", () => resolve())));
const closed = (child: ReturnType<typeof pairLike>) =>
  Effect.promise(() => new Promise<void>((resolve) => child.stdout.once("close", resolve)));

describe.skipIf(platform === "win32")("lease proxy driver processes", () => {
  it.live("stopping one connection ends its child and grandchild, and only that connection's", () =>
    Effect.gen(function* () {
      const stopped = pairLike();
      const other = pairLike();
      yield* started(stopped);
      yield* started(other);
      killDriverGroup(platform, stopped, "SIGKILL");
      yield* closed(stopped);
      assert.isNull(other.exitCode);
      assert.isNull(other.signalCode);
      killDriverGroup(platform, other, "SIGKILL");
      yield* closed(other);
    }),
  );

  it.live(
    "a group whose leader was already reaped is never signalled, so a recycled id is safe",
    () =>
      Effect.gen(function* () {
        // The grandchild prints its PID, then names the first signal that reaches it: TERM through
        // the group, or USR1 sent straight to it by this test. Both are pending together if the
        // group was signalled, and TERM, posted first, runs first.
        const script =
          "trap 'echo group; exit' TERM; trap 'echo direct; exit' USR1; echo $$; " +
          // Bounded, like pairLike's child: at most a minute even if nothing ends it.
          "i=0; while [ $i -lt 60 ]; do i=$((i+1)); sleep 1 & wait $!; done";
        const leaderOnly = spawnDriverProcess(
          platform,
          "/bin/sh",
          ["-c", '/bin/sh -c "$GRANDCHILD" & wait'],
          { PATH: "/bin:/usr/bin", GRANDCHILD: script },
        );
        onTestFinished(() => killDriverGroup(platform, leaderOnly, "SIGKILL"));
        let output = "";
        leaderOnly.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
        const grandchild = yield* Effect.promise(
          () =>
            new Promise<number>((resolve) =>
              leaderOnly.stdout.once("data", (chunk: Buffer) =>
                resolve(Number(String(chunk).trim())),
              ),
            ),
        );
        // The leader is reaped below, so its group can no longer be signalled; a failed test ends
        // the grandchild by the PID it reported itself.
        onTestFinished(() => {
          try {
            process.kill(grandchild, "SIGKILL");
          } catch {
            // Already gone.
          }
        });
        const exited = Effect.promise(
          () => new Promise<void>((resolve) => leaderOnly.once("exit", () => resolve())),
        );
        // Only the leader, as if the helper's launcher crashed under its service and driver.
        if (leaderOnly.pid !== undefined) process.kill(leaderOnly.pid, "SIGKILL");
        yield* exited;
        killDriverGroup(platform, leaderOnly, "SIGTERM");
        process.kill(grandchild, "SIGUSR1");
        yield* closed(leaderOnly);
        assert.strictEqual(output.split("\n")[1], "direct");
      }),
  );
});
