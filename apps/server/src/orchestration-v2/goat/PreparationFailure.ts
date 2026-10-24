import { GitCommandError } from "@goat/contracts";
import * as Schema from "effect/Schema";

const isGitCommandError = Schema.is(GitCommandError);

/**
 * Most preparation failures are a request this machine cannot satisfy, such as a missing
 * base ref. A stalled or timed-out Git command is a slow or stuck host instead, which a
 * later attempt can get past, so it is retryable and must not read as a bad request.
 */
export function classifyPreparationFailure(cause: unknown): {
  readonly class: "validation_error" | "unknown";
  readonly code: string | null;
  readonly retryable: boolean;
} {
  if (isGitCommandError(cause) && cause.reason === "stalled")
    return { class: "unknown", code: "git_stalled", retryable: true };
  if (isGitCommandError(cause) && cause.reason === "timed_out")
    return { class: "unknown", code: "git_timed_out", retryable: true };
  return { class: "validation_error", code: null, retryable: false };
}
