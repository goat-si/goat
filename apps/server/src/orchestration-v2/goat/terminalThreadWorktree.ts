import { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TerminalThreadWorktree from "../../terminal/TerminalThreadWorktree.ts";
import * as ProjectionStoreV2 from "../ProjectionStore.ts";

// Where a thread works now, for terminal requests that waited; the manager never reads projections.
export const layer = Layer.effect(
  TerminalThreadWorktree.TerminalThreadWorktree,
  Effect.gen(function* () {
    const projection = yield* ProjectionStoreV2.ProjectionStoreV2;
    return TerminalThreadWorktree.TerminalThreadWorktree.of({
      current: Effect.fn("TerminalThreadWorktree.current")(function* (threadId: string) {
        const shell = yield* projection
          .getThreadShell(ThreadId.make(threadId))
          .pipe(
            Effect.mapError(
              (cause) => new TerminalThreadWorktree.TerminalThreadWorktreeError({ cause }),
            ),
          );
        return shell === null || shell.deletedAt !== null
          ? Option.none<string | null>()
          : Option.some(shell.worktreePath);
      }),
    });
  }),
);
