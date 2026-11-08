import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";

import { remoteDeadlineSettleMs } from "./remoteDeadline.ts";
import { REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS } from "./remoteRuntime.ts";
import * as SshTunnel from "./tunnel.ts";
import { uploadTarget } from "./tunnel.fixture.ts";
import { fixture, stopped, successfulStatus } from "./tunnel.runtime-status.fixture.ts";

describe("SSH preparation retry", () => {
  it.effect(
    "a launch that times out is retried until the host is ready, without a manual retry",
    () => {
      const f = fixture({ ...stopped, ready: true });
      f.failLaunchConnections(1);
      return Effect.gen(function* () {
        const manager = yield* SshTunnel.SshEnvironmentManager;
        const first = yield* Effect.exit(
          manager.ensureEnvironment(uploadTarget, { keyOnly: true }),
        );
        assert.isTrue(Exit.isFailure(first));
        const failed = yield* manager.status(uploadTarget);
        assert.notEqual(failed.status?.state, "preparing");

        // A packet timeout can end a running session, so the retry waits until a launch script
        // it lost must have ended; nobody calls ensure or presses Retry.
        yield* TestClock.adjust(
          Duration.millis(remoteDeadlineSettleMs(REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS)),
        );
        yield* f.launchStarted(2);
        // Joining the automatic attempt's flight observes its outcome without starting another.
        yield* manager.ensureEnvironment(uploadTarget, { keyOnly: true });
        assert.equal(f.calls.launches, 2);
        // Ready-only callers, such as agent host calls, are admitted again.
        yield* manager.readyEnvironment(uploadTarget);
        assert.notEqual(successfulStatus(yield* manager.status(uploadTarget)).state, "preparing");
      }).pipe(Effect.provide(f.layer), Effect.scoped);
    },
  );
});
