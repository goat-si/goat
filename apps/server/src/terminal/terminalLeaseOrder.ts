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
 * Which run of a terminal request this is: its first, a rerun after it waited for its folder, a
 * rerun that an open or restart of the same terminal overtook, or one that a close overtook.
 */
export type TerminalAttempt = "first" | "rerun" | "overtaken" | "closed";
const Attempt = Context.Reference<TerminalAttempt>("goat/terminal/terminalLeaseOrder/Attempt", {
  defaultValue: () => "first",
});

interface WaitingRequest {
  /** Undefined for an agent's open, whose terminal id is new each run. */
  readonly terminalId: string | undefined;
  readonly restart: boolean;
  rerunAs: Exclude<TerminalAttempt, "first">;
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
   * Under the thread lock, by an open or restart that ran, or a person's or agent's close (all of
   * the thread's without terminalId): requests still waiting must not undo it when they run again.
   * A reuse leaves waiting restarts to run; housekeeping closes (idle, settle) never call this.
   */
  const supersede = (
    threadId: string,
    terminalId: string | undefined,
    by: "start" | "reuse" | "close",
  ) =>
    Effect.sync(() => {
      for (const request of waiting.get(threadId) ?? []) {
        if (terminalId !== undefined && request.terminalId !== terminalId) continue;
        if (by === "close") request.rerunAs = "closed";
        else if ((by === "start" || !request.restart) && request.rerunAs !== "closed")
          request.rerunAs = "overtaken";
      }
    });

  const attempt = Effect.withFiber((fiber) => Effect.succeed(fiber.getRef(Attempt)));

  /**
   * Starts or restarts a terminal under cwd's lease, or fails TerminalLeaseBusy without running it.
   * An overtaken rerun returns the terminal as it is now; when it is gone, `gone` after a close,
   * else the start, since only housekeeping removed it.
   */
  const tryTerminalLease = <A, E, R, B, E2, R2, C, E3, R3>(
    terminal: { readonly threadId: string; readonly terminalId: string },
    cwd: string,
    effect: Effect.Effect<A, E, R>,
    current: Effect.Effect<Option.Option<B>, E2, R2>,
    gone: Effect.Effect<C, E3, R3>,
  ): Effect.Effect<
    A | B | C,
    E | E2 | E3 | TerminalCwdStatError | TerminalLeaseBusy,
    R | R2 | R3
  > => {
    type Started = Effect.Effect<
      A | B | C,
      E | E3 | TerminalCwdStatError | TerminalLeaseBusy,
      R | R3
    >;
    const start = cwdUnavailable(
      cwd,
      tryEnterWorkspaceLease(
        options.resolve(cwd),
        effect.pipe(Effect.tap(() => supersede(terminal.threadId, terminal.terminalId, "reuse"))),
      ),
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new TerminalLeaseBusy({ cwd })),
          onSome: Effect.succeed,
        }),
      ),
    );
    return Effect.withFiber((fiber) => {
      const run = fiber.getRef(Attempt);
      if (run === "first" || run === "rerun") return start;
      return Effect.flatMap(current, (found): Started =>
        Option.isSome(found) ? Effect.succeed(found.value) : run === "closed" ? gone : start,
      );
    });
  };

  /**
   * The thread's lock for work that may start a shell. A busy folder releases the lock, waits in
   * the lease's queue holding nothing, then runs the work again under the lease, then the lock.
   */
  const withThreadLockAndLease = <A, E, R>(
    threadId: string,
    terminalId: string | undefined,
    effect: Effect.Effect<A, E | TerminalLeaseBusy, R>,
    restart = false,
  ): Effect.Effect<A, E | TerminalCwdStatError, R> => {
    const request: WaitingRequest = { terminalId, restart, rerunAs: "rerun" };
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
              effect.pipe(Effect.provideService(Attempt, rerun ? request.rerunAs : "first")),
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

  const waitingCount = () => [...waiting.values()].reduce((count, set) => count + set.size, 0);

  return { attempt, supersede, tryTerminalLease, waitingCount, withThreadLockAndLease };
};
