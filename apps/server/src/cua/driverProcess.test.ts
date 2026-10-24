// @effect-diagnostics nodeBuiltinImport:off -- These tests run real shell processes to prove group ownership.
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";

import { killDriverGroup, spawnDriverProcess } from "./driverProcess.ts";

const platform = HostProcess.Platform.defaultValue();

// A shell and its own child both hold the pipe: it closes only when neither is left.
const pairLike = () =>
  spawnDriverProcess(platform, "/bin/sh", ["-c", "sleep 60 & echo started; wait"], {
    PATH: "/bin:/usr/bin",
  });
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
});
