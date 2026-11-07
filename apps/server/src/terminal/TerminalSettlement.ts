import type { TerminalError } from "@goat/contracts";
import * as Effect from "effect/Effect";

export const makeCloseOnSettle = (input: {
  readonly withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly sessionsForThread: (
    threadId: string,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly terminalId: string; readonly stopOnSettle: boolean }>
  >;
  readonly closeSession: (
    threadId: string,
    terminalId: string,
    deleteHistory: boolean,
  ) => Effect.Effect<void, TerminalError>;
  readonly closeIdle: (input: { readonly threadId: string }) => Effect.Effect<void>;
}) =>
  Effect.fn("terminal.closeOnSettle")(function* ({ threadId }: { readonly threadId: string }) {
    yield* input.withThreadLock(
      threadId,
      Effect.gen(function* () {
        const sessions = yield* input.sessionsForThread(threadId);
        yield* Effect.forEach(
          sessions.filter((session) => session.stopOnSettle),
          (session) => input.closeSession(threadId, session.terminalId, false),
          { discard: true },
        );
      }),
    );
    yield* input.closeIdle({ threadId });
  });
