import { GitCommandError } from "@goat/contracts";
import * as Schema from "effect/Schema";

export function isMissingGitRepository(stderr: string): boolean {
  const diagnostic = stderr.toLowerCase();
  return (
    diagnostic.includes("not a git repository") ||
    diagnostic.includes("gitfile does not point to a valid repository")
  );
}

const isGitCommandError = Schema.is(GitCommandError);

export function cleanupFailureReason(error: { readonly message: string }) {
  return isGitCommandError(error)
    ? `${error.command}: ${error.detail.split(/\r?\n/)[0]}${error.reason ? ` (${error.reason})` : ""}`
    : (error.message.split(/\r?\n/)[0] ?? error.message);
}
