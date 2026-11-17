import { TerminalCwdStatError } from "@goat/contracts";
import * as Context from "effect/Context";
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

/**
 * Which run of a terminal request this is: its first, a rerun after it waited for its folder, or
 * a rerun that an open, restart or close of the same terminal overtook while it waited.
 */
export type TerminalAttempt = "first" | "rerun" | "overtaken";
const Attempt = Context.Reference<TerminalAttempt>("goat/terminal/terminalLeaseOrder/Attempt", {
  defaultValue: () => "first",
});

interface WaitingRequest {
  /** Undefined for an agent's open, whose terminal id is new each run. */
  readonly terminalId: string | undefined;
  overtaken: boolean;
}

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

const isBusy = (error: unknown): error is TerminalLeaseBusy => error instanceof TerminalLeaseBusy;

// Lock order (goat#3674): a thread's terminal lock holder never waits on a folder lease; a lease
// holder, such as a restore running its setup terminal, may wait on a thread's terminal lock.
export const makeTerminalLeaseOrder = (options: {
  readonly resolve: (cwd: string) => string;
  readonly withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
}) => {
  /** Requests that gave up their thread's lock to wait for a folder, by thread. */
  const waiting = new Map<string, Set<WaitingRequest>>();

  /**
   * Under the thread lock, by whatever opens, restarts or closes a terminal (all of the thread's
   * without terminalId): requests still waiting for it must not undo that when they run again.
   */
  const supersede = (threadId: string, terminalId?: string) =>
    Effect.sync(() => {
      for (const request of waiting.get(threadId) ?? [])
        if (terminalId === undefined || request.terminalId === terminalId) request.overtaken = true;
    });

  const attempt = Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(Attempt)));

  /**
   * Starts or restarts a terminal under cwd's lease, or fails TerminalLeaseBusy without running
   * it. An overtaken rerun runs `overtaken` instead, which must start nothing.
   */
  const tryTerminalLease = <A, E, R, B, E2, R2>(
    terminal: { readonly threadId: string; readonly terminalId: string },
    cwd: string,
    effect: Effect.Effect<A, E, R>,
    overtaken: Effect.Effect<B, E2, R2>,
  ): Effect.Effect<A | B, E | E2 | TerminalCwdStatError | TerminalLeaseBusy, R | R2> =>
    Effect.withFiber<A | B, E | E2 | TerminalCwdStatError | TerminalLeaseBusy, R | R2>((fiber) =>
      fiber.getRef(Attempt) === "overtaken"
        ? overtaken
        : cwdUnavailable(
            cwd,
            tryEnterWorkspaceLease(
              options.resolve(cwd),
              effect.pipe(Effect.tap(() => supersede(terminal.threadId, terminal.terminalId))),
            ),
          ).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new TerminalLeaseBusy({ cwd })),
                onSome: Effect.succeed,
              }),
            ),
          ),
    );

  /**
   * The thread's lock for work that may start a shell. A busy folder releases the lock, waits in
   * the lease's queue holding nothing, then runs the work again under the lease, then the lock.
   */
  const withThreadLockAndLease = <A, E, R>(
    threadId: string,
    terminalId: string | undefined,
    effect: Effect.Effect<A, E | TerminalLeaseBusy, R>,
  ): Effect.Effect<A, E | TerminalCwdStatError, R> => {
    const request: WaitingRequest = { terminalId, overtaken: false };
    const join = Effect.sync(() => {
      const requests = waiting.get(threadId) ?? new Set<WaitingRequest>();
      waiting.set(threadId, requests.add(request));
    });
    const leave = Effect.sync(() => {
      const requests = waiting.get(threadId);
      requests?.delete(request);
      if (requests?.size === 0) waiting.delete(threadId);
    });
    // A busy run joins the waiting requests before it gives the thread lock up.
    const run = (rerun: boolean) =>
      options.withThreadLock(
        threadId,
        Effect.suspend(() =>
          leave.pipe(
            Effect.andThen(
              effect.pipe(
                Effect.provideService(
                  Attempt,
                  !rerun ? "first" : request.overtaken ? "overtaken" : "rerun",
                ),
              ),
            ),
            Effect.tapError((error) => (isBusy(error) ? join : Effect.void)),
          ),
        ),
      );
    const settle = (
      attempt: Effect.Effect<A, E | TerminalLeaseBusy | TerminalCwdStatError, R>,
    ): Effect.Effect<A, E | TerminalCwdStatError, R> =>
      attempt.pipe(
        Effect.catchIf(isBusy, ({ cwd }) =>
          settle(
            cwdUnavailable(
              cwd,
              withWorkspaceLease(options.resolve(cwd), reuseHeldWorkspaceLease(run(true))),
            ),
          ),
        ),
      );
    return settle(run(false)).pipe(Effect.ensuring(leave));
  };

  return { attempt, supersede, tryTerminalLease, withThreadLockAndLease };
};
