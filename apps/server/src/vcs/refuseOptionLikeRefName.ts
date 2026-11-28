import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";

// Checkout/worktree add parse leading dashes as options; pre-2.44 Git cannot guard with --end-of-options.
// A lone - still means previous checkout.
export const refuseOptionLikeRefName = (
  operation: string,
  cwd: string,
  refName: string | undefined,
) =>
  refName !== undefined && refName !== "-" && refName.startsWith("-")
    ? Effect.fail(
        new GitCommandError({
          operation,
          command: "git",
          cwd,
          detail: "Ref names cannot start with '-'.",
        }),
      )
    : Effect.void;
