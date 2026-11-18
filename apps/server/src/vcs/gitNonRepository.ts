import type { GitCommandError } from "@goat/contracts";
import * as PlatformError from "effect/PlatformError";

export function isMissingGitCwdError(error: GitCommandError): boolean {
  if (!(error.cause instanceof PlatformError.PlatformError)) return false;
  const reason = error.cause.reason;
  if (reason._tag === "NotFound") return reason.pathOrDescriptor === error.cwd;
  return (
    reason._tag === "BadResource" &&
    reason.pathOrDescriptor === error.cwd &&
    typeof reason.cause === "object" &&
    reason.cause !== null &&
    "code" in reason.cause &&
    reason.cause.code === "ENOTDIR"
  );
}

export function isNonRepositoryGitStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("not a git repository") ||
    normalized.includes("gitfile does not point to a valid repository")
  );
}
