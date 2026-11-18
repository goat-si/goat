import type { GitCommandFailureReason } from "@goat/contracts";

import { isNonRepositoryGitStderr } from "./gitNonRepository.ts";

// Stderr can echo credentials from argv/URLs; classify fixed patterns without exposing matched text.
const GIT_FAILURE_REASON_PATTERNS: ReadonlyArray<readonly [RegExp, GitCommandFailureReason]> = [
  [/would clobber existing tag/i, "tag_would_be_clobbered"],
  [/is already (?:used by worktree at|checked out at)/i, "branch_checked_out_in_worktree"],
  [/a branch named .+ already exists/i, "branch_already_exists"],
  [/'refs\/[^'\n]+' exists; cannot create 'refs\//i, "ref_name_conflict"],
  [
    /(?:authentication failed|could not read Username|could not read Password|permission denied \([a-z-]+(?:,[a-z-]+)*\)|permission denied, please try again)/i,
    "authentication_failed",
  ],
  [/host key verification failed/i, "host_key_unverified"],
  [
    /(?:could not read from remote repository|does not appear to be a git repository|repository .+ not found)/i,
    "remote_unreachable",
  ],
  // Unquoted already-exists errors also describe ref/tag collisions; require quoted paths.
  [/fatal: '[^']+' already exists|destination path .+ already exists/i, "path_already_exists"],
  // Ambiguous revision/path and pathspec failures can name files, so omit them.
  // Anchor to a diagnostic line to avoid matching quoted paths in other errors.
  [
    /^fatal: (?:invalid reference: |not a valid object name|needed a single revision|bad revision |'.+' is not a commit and a branch '.+' cannot be created from it)/im,
    "ref_not_found",
  ],
  // `[remote rejected]` is only printed for a push. The remote's explanation
  // follows in parentheses; it is server text, so it is never quoted.
  [/^[ \t]*![ \t]+\[remote rejected\]/im, "push_rejected_by_remote"],
  // A fetch into a diverged local branch prints the same `[rejected]` line, but
  // only a push goes on to report "failed to push some refs".
  [
    /^[ \t]*![ \t]+\[rejected\][^\n]*\((?:non-fast-forward|fetch first)\)[\s\S]*^error: failed to push some refs/im,
    "push_rejected_non_fast_forward",
  ],
];

// Reasons the user can act on get a sentence in place of the generic detail.
const GIT_FAILURE_REASON_DETAILS: Partial<Record<GitCommandFailureReason, string>> = {
  push_rejected_by_remote:
    "The remote rejected the push. Push this branch from a terminal to see the server's message.",
  push_rejected_non_fast_forward:
    "The remote has commits this branch doesn't have. Pull or rebase, then push again.",
};

export function gitFailureDetail(reason: GitCommandFailureReason | null): string {
  return (
    (reason === null ? undefined : GIT_FAILURE_REASON_DETAILS[reason]) ??
    "Git command exited with a non-zero status."
  );
}

// Existing non-commit objects share the missing-ref fatal diagnostic; Git
// distinguishes them with a separate error line.
const GIT_NOT_A_COMMIT_PATTERN = /^error: .+(?:, not a commit|expected commit type)/im;

// Trust only Git's diagnostic prefixes: local hooks can write indistinguishable text.
// Exclude `remote:` too, since it prefixes remote hook output as well as server diagnostics.
const GIT_DIAGNOSTIC_LINE_PATTERN = /^(?:fatal|error):|^!\s|^\s+!\s/;
// SSH credential refusals are unprefixed; Git's later generic error would otherwise misclassify them as unreachable.
const SSH_TRANSPORT_REFUSAL_PATTERN =
  /Permission denied \((?:publickey|password|keyboard-interactive)|Permission denied, please try again|Host key verification failed/i;

export function classifyGitFailure(stderr: string): GitCommandFailureReason | null {
  const diagnostics = stderr
    .split(/\r?\n/)
    .filter(
      (line) =>
        GIT_DIAGNOSTIC_LINE_PATTERN.test(line) ||
        (!line.startsWith("remote:") && SSH_TRANSPORT_REFUSAL_PATTERN.test(line)),
    )
    .join("\n");
  if (diagnostics.length === 0) return null;
  if (isNonRepositoryGitStderr(diagnostics)) return "not_a_repository";
  for (const [pattern, reason] of GIT_FAILURE_REASON_PATTERNS) {
    if (!pattern.test(diagnostics)) continue;
    if (reason === "ref_not_found" && GIT_NOT_A_COMMIT_PATTERN.test(diagnostics)) continue;
    return reason;
  }
  return null;
}
