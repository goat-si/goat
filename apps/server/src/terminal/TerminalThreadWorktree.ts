import {
  TerminalCwdStatError,
  TerminalRequestError,
  TerminalSessionLookupError,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** The thread's current worktree could not be read. */
export class TerminalThreadWorktreeError extends Data.TaggedError("TerminalThreadWorktreeError")<{
  readonly cause: unknown;
}> {}

/** Where a thread works now, for terminal requests that waited while it may have moved. */
export class TerminalThreadWorktree extends Context.Service<
  TerminalThreadWorktree,
  {
    /** The thread's worktree path, Some(null) without one, or None when the thread is gone. */
    readonly current: (
      threadId: string,
    ) => Effect.Effect<Option.Option<string | null>, TerminalThreadWorktreeError>;
  }
>()("goat/terminal/TerminalThreadWorktree") {}

const MOVED =
  "This thread moved to another worktree while the terminal waited. Open the terminal again to start it there.";
const UNREAD =
  "The terminal could not be started because GOAT could not read the thread's worktree. Try again.";

/** Cleared for GOAT's own setup terminal, which opens before its thread is bound to the folder. */
const CheckBinding = Context.Reference<boolean>(
  "goat/terminal/TerminalThreadWorktree/CheckBinding",
  {
    defaultValue: () => true,
  },
);

/** Runs a setup terminal's request without the moved-worktree check. */
export const withoutBindingCheck = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, CheckBinding, false);

/**
 * A person's request that waited for its worktree starts nothing when the thread has left that
 * worktree or is gone, or when that cannot be checked.
 */
export const refuseMovedWorktree = (
  worktrees: TerminalThreadWorktree["Service"],
  resolve: (folder: string) => string,
  request: {
    readonly threadId: string;
    readonly terminalId: string;
    readonly worktreePath?: string | null | undefined;
    readonly terminalErrorMessage?: true | undefined;
  },
) => {
  const requested = request.worktreePath;
  if (!requested) return Effect.void;
  const reject = (message: string) =>
    Effect.fail(
      request.terminalErrorMessage === true
        ? new TerminalRequestError({ message })
        : new TerminalCwdStatError({ cwd: requested, cause: new Error(message) }),
    );
  const check = worktrees.current(request.threadId).pipe(
    Effect.catch((error) =>
      Effect.logWarning("A waiting terminal was not started: its thread's worktree is unreadable", {
        threadId: request.threadId,
        requested,
        cause: error.cause,
      }).pipe(Effect.andThen(reject(UNREAD))),
    ),
    Effect.flatMap(
      (
        current,
      ): Effect.Effect<
        void,
        TerminalRequestError | TerminalCwdStatError | TerminalSessionLookupError
      > => {
        if (Option.isNone(current))
          return Effect.fail(
            new TerminalSessionLookupError({
              threadId: request.threadId,
              terminalId: request.terminalId,
            }),
          );
        // A thread not bound to a worktree yet has not moved; only one bound elsewhere has.
        if (current.value === null || resolve(current.value) === resolve(requested))
          return Effect.void;
        return Effect.logWarning(
          "A waiting terminal was not started: its thread moved to another worktree",
          { threadId: request.threadId, requested, current: current.value },
        ).pipe(Effect.andThen(reject(MOVED)));
      },
    ),
  );
  return Effect.withFiber((fiber) => (fiber.getRef(CheckBinding) ? check : Effect.void));
};
