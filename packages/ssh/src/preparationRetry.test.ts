import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { SshCommandError } from "./errors.ts";
import {
  isTransientPreparationFailure,
  makePreparationRetries,
  preparationRetryDelayMs,
} from "./preparationRetry.ts";
import { uploadTarget } from "./tunnel.fixture.ts";

const sshFailure = (exitCode: number | null, stderr: string) =>
  new SshCommandError({ message: stderr, command: ["ssh"], exitCode, stderr });
const timedOut = sshFailure(null, "Checking GOAT runtime on devbox timed out after 60s.");
const denied = sshFailure(255, "alex@devbox.example.com: Permission denied (publickey).");

describe("SSH preparation retry policy", () => {
  it("retries timeouts and dropped connections, never authentication or remote script failures", () => {
    assert.isTrue(isTransientPreparationFailure(timedOut));
    assert.isTrue(
      isTransientPreparationFailure(sshFailure(255, "Connection reset by 10.0.0.2 port 22")),
    );
    assert.isFalse(isTransientPreparationFailure(denied));
    assert.isFalse(isTransientPreparationFailure(sshFailure(1, "unsupported platform")));
  });

  it("backs off exponentially with jitter up to a one-minute cap", () => {
    assert.equal(preparationRetryDelayMs(0, 0), 1_000);
    assert.equal(preparationRetryDelayMs(0, 1), 2_000);
    assert.equal(preparationRetryDelayMs(1, 1), 4_000);
    assert.equal(preparationRetryDelayMs(10, 1), 60_000);
    assert.equal(preparationRetryDelayMs(10, 0), 30_000);
  });

  it.effect(
    "keeps retrying transient failures and stops on success, a lasting failure, or cancel",
    () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        let wanted = true;
        let attempts = 0;
        const outcomes: Array<Effect.Effect<void, SshCommandError>> = [];
        const retries = makePreparationRetries({
          scope,
          wanted: () => wanted,
          attempt: () =>
            Effect.suspend(() => {
              attempts++;
              return outcomes.shift() ?? Effect.void;
            }),
        });

        // Two more timeouts, then success: three attempts in all, then the loop ends.
        outcomes.push(Effect.fail(timedOut), Effect.fail(timedOut));
        yield* retries.failed("devbox", 1, timedOut, uploadTarget);
        yield* TestClock.adjust("10 minutes");
        assert.equal(attempts, 3);
        assert.isUndefined(retries.refusal("devbox", "devbox"));

        // A failure a person must fix ends the loop.
        outcomes.push(Effect.fail(denied));
        yield* retries.failed("devbox", 1, timedOut, uploadTarget);
        assert.isDefined(retries.refusal("devbox", "devbox"));
        yield* TestClock.adjust("10 minutes");
        assert.equal(attempts, 4);
        assert.isUndefined(retries.refusal("devbox", "devbox"));

        // Nothing loops after a non-transient failure from a caller.
        yield* retries.failed("devbox", 1, denied, uploadTarget);
        yield* TestClock.adjust("10 minutes");
        assert.equal(attempts, 4);

        // Removing the host cancels a pending retry.
        yield* retries.failed("devbox", 1, timedOut, uploadTarget);
        yield* retries.cancel("devbox");
        yield* TestClock.adjust("10 minutes");
        assert.equal(attempts, 4);

        // A host that is no longer wanted is not attempted when the delay ends.
        yield* retries.failed("devbox", 1, timedOut, uploadTarget);
        wanted = false;
        yield* TestClock.adjust("10 minutes");
        assert.equal(attempts, 4);
        yield* Scope.close(scope, Exit.void);
      }),
  );
});
