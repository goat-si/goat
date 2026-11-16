import * as Cause from "effect/Cause";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";

/** What a person reads when a command fails: its own message, never a crash's. */
export function commandFailureText(
  result: { readonly cause: Cause.Cause<unknown> },
  fallback = "The change was not saved. Try again.",
): string {
  if (Cause.hasDies(result.cause)) return fallback;
  const failure = squashAtomCommandFailure(result);
  const message =
    failure instanceof Error ? failure.message : typeof failure === "string" ? failure : "";
  return message.trim() === "" ? fallback : message;
}
