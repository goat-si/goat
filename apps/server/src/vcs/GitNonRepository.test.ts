import { assert, describe, it } from "@effect/vitest";
import { isNonRepositoryGitStderr } from "./gitNonRepository.ts";

describe("isNonRepositoryGitStderr", () => {
  it.each([
    "fatal: not a git repository (or any of the parent directories): .git",
    "fatal: not a git repository: /missing-git-directory",
    // Git 2.56+ wording for a `.git` gitfile that points at a missing directory.
    "fatal: gitfile does not point to a valid repository: /tmp/worktrees/feature/.git",
    "FATAL: GITFILE DOES NOT POINT TO A VALID REPOSITORY: /tmp/x/.git",
  ])("classifies %j as a non-repository", (stderr) => {
    assert.isTrue(isNonRepositoryGitStderr(stderr));
  });

  it.each([
    "",
    "fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree.",
    "fatal: Unable to create '/repo/.git/index.lock': File exists.",
    "fatal: invalid gitfile format: /repo/.git",
  ])("does not classify %j as a non-repository", (stderr) => {
    assert.isFalse(isNonRepositoryGitStderr(stderr));
  });
});
