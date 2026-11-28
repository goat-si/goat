import type { VcsRef } from "@goat/contracts";

export interface GitRepositoryPaths {
  readonly gitCommonDir: string;
  readonly worktreeRoot: string | null;
  readonly isAtRepositoryRoot: boolean | undefined;
  readonly currentBranch: string | null;
}

export interface GitRefsSnapshot {
  readonly defaultBranch: string | null;
  readonly localBranches: ReadonlyArray<VcsRef>;
  readonly remoteBranches: ReadonlyArray<VcsRef>;
  readonly hasPrimaryRemote: boolean;
}
