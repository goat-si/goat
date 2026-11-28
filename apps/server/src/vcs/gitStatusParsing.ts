import { trimAsciiWhitespace } from "@goat/contracts";

// `--short` and `--abbrev-ref` print `heads/<name>` when a tag shares the branch's name, so
// branch reads take the full ref and strip the prefix themselves.
export function branchNameFromHeadRef(value: string): string | null {
  const ref = trimAsciiWhitespace(value);
  return ref.startsWith("refs/heads/") && ref.length > "refs/heads/".length
    ? ref.slice("refs/heads/".length)
    : null;
}

export function isUnbornHeadStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("bad revision 'head'") ||
    (normalized.includes("unknown revision") && normalized.includes("path not in the working tree"))
  );
}

// Git reports missing worktree registrations and registered-but-deleted paths differently.
export function isMissingWorktreeStderr(stderr: string): boolean {
  const normalized = stderr.toLowerCase();
  return (
    normalized.includes("is not a working tree") ||
    normalized.includes("cannot remove working tree")
  );
}
