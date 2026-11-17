import { TerminalCwdStatError } from "@goat/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  isWorkspaceLeaseUnavailableError,
  reuseHeldWorkspaceLease,
  type WorkspaceLeaseUnavailableError,
  tryEnterWorkspaceLease,
  withWorkspaceLease,
} from "../workspace/workspaceLease.ts";

/** A terminal start found its folder held by someone else before it changed anything. */
export class TerminalLeaseBusy extends Data.TaggedError("TerminalLeaseBusy")<{
  readonly cwd: string;
}> {}

/** Claims of other GOAT servers that cannot be read fail like an unreachable cwd. */
const cwdUnavailable = <A, E, R>(
  cwd: string,
  effect: Effect.Effect<A, E | WorkspaceLeaseUnavailableError, R>,
): Effect.Effect<A, E | TerminalCwdStatError, R> =>
  effect.pipe(
    Effect.catchIf(isWorkspaceLeaseUnavailableError, (error) =>
      Effect.fail(new TerminalCwdStatError({ cwd, cause: error })),
    ),
  );

// Lock order (goat#3674): a thread's terminal lock holder never waits on a folder lease; a lease
// holder, such as a restore running its setup terminal, may wait on a thread's terminal lock.
export const makeTerminalLeaseOrder = (options: {
  readonly resolve: (cwd: string) => string;
  readonly withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}) => {
  /** Runs effect under cwd's lease, or fails TerminalLeaseBusy without running it. */
  const tryTerminalLease = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
    cwdUnavailable(cwd, tryEnterWorkspaceLease(options.resolve(cwd), effect)).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new TerminalLeaseBusy({ cwd })),
          onSome: Effect.succeed,
        }),
      ),
    );

  /**
   * The thread's lock for work that may start a shell. A busy folder releases the lock, waits in
   * the lease's queue holding nothing, then runs the work again under the lease, then the lock.
   */
  const withThreadLockAndLease = <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E | TerminalLeaseBusy, R>,
  ): Effect.Effect<A, E | TerminalCwdStatError, R> => {
    const settle = (
      attempt: Effect.Effect<A, E | TerminalLeaseBusy | TerminalCwdStatError, R>,
    ): Effect.Effect<A, E | TerminalCwdStatError, R> =>
      attempt.pipe(
        Effect.catchIf(
          (error): error is TerminalLeaseBusy => error instanceof TerminalLeaseBusy,
          ({ cwd }) =>
            settle(
              cwdUnavailable(
                cwd,
                withWorkspaceLease(
                  options.resolve(cwd),
                  reuseHeldWorkspaceLease(options.withThreadLock(threadId, effect)),
                ),
              ),
            ),
        ),
      );
    return settle(options.withThreadLock(threadId, effect));
  };

  return { tryTerminalLease, withThreadLockAndLease };
};
