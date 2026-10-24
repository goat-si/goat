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
        // The grandchild names what ends it first: TERM through the group, or the end of its
        // input, which this test closes. If the group was signalled, TERM is already pending when
        // the input ends; the shell may defer it past `read`, but runs it as `wait` starts, before
        // "direct". No PID is ever signalled here, only the leader the test started, and the
        // grandchild ends on its own within a minute if nothing ends it.
        const script =
          "trap 'echo group; exit' TERM; echo started; i=0; " +
          "while [ $i -lt 60 ]; do i=$((i+1)); read -t 1 _; " +
          "[ $? -gt 128 ] || { sleep 1 >/dev/null & wait $!; echo direct; exit; }; done";
        const leaderOnly = spawnDriverProcess(
          platform,
          "/bin/sh",
          // An explicit redirect: a background job's input would otherwise be /dev/null.
          ["-c", '/bin/sh -c "$GRANDCHILD" <&0 & wait'],
          { PATH: "/bin:/usr/bin", GRANDCHILD: script },
        );
        onTestFinished(() => {
          killDriverGroup(platform, leaderOnly, "SIGKILL");
          // A failed test still ends the grandchild through its input.
          leaderOnly.stdin.end();
        });
        let output = "";
        leaderOnly.stdout.on("data", (chunk: Buffer) => (output += String(chunk)));
        yield* started(leaderOnly);
        const exited = Effect.promise(
          () => new Promise<void>((resolve) => leaderOnly.once("exit", () => resolve())),
        );
        // Only the leader, as if the helper's launcher crashed under its service and driver.
        if (leaderOnly.pid !== undefined) process.kill(leaderOnly.pid, "SIGKILL");
        yield* exited;
        killDriverGroup(platform, leaderOnly, "SIGTERM");
        leaderOnly.stdin.end();
        yield* closed(leaderOnly);
        assert.strictEqual(output.split("\n")[1], "direct");
      }),
  );
});
