import type { SshHostResult, SshHostSetupProgress } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Dispatch from "./SshRemoteDispatch.ts";

export const make = Effect.gen(function* () {
  const dispatch = yield* Dispatch.SshRemoteDispatch;
  return Effect.fn("SshHostSetup.settleJob")(function* (
    host: string,
    operation: SshHostSetupProgress,
    first: Deferred.Deferred<SshHostResult>,
    exit: Exit.Exit<unknown, unknown>,
  ) {
    const pending = !(yield* Deferred.isDone(first));
    const interrupted = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
    const unexpected = Exit.isFailure(exit) && !interrupted;
    if (!pending && !unexpected) return;
    const message = interrupted
      ? `SSH setup on ${host} was interrupted. Try again.`
      : `SSH setup on ${host} ended without a complete response. Try again.`;
    const fix = {
      actor: "agent",
      instruction: `Call goat_call {path:"ssh.host_prepare"} for ${host} to retry.`,
    } as const;
    const failure: SshHostResult = { kind: "error", code: "operation_failed", message, fix };
    yield* Deferred.succeed(first, failure);
    if (interrupted) return;
    yield* dispatch
      .publishSetupOutcome(host, operation, {
        kind: "error",
        reason: "operation_failed",
        message,
        fix,
      })
      .pipe(
        Effect.catchCause(() =>
          Effect.logWarning("SSH setup terminal outcome could not be published", { host }),
        ),
      );
  });
});
