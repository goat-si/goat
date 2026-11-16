import type * as Cause from "effect/Cause";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";

/** What a person reads when a command fails: its own message when it has one. */
export function commandFailureText(result: { readonly cause: Cause.Cause<unknown> }): string {
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error && failure.message.trim() !== ""
    ? failure.message
    : "The change was not saved. Try again.";
}
