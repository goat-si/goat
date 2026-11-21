import type { VcsStatusResult } from "@goat/contracts";

export type GitBranchPullRequest = NonNullable<VcsStatusResult["pr"]> & {
  readonly repositoryKey: string | null;
  readonly updatedAt: string | null;
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly headSha?: string | null;
};
