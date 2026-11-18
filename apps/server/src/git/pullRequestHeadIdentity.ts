import type {
  BranchHeadContext,
  PullRequestHeadRemoteInfo,
  PullRequestInfo,
} from "./GitManager.ts";

/** Null when the host did not name the repository the head lives in. */
export function resolveHeadRepositoryNameWithOwner(
  pullRequest: PullRequestHeadRemoteInfo,
): string | null {
  return normalizeOptionalString(pullRequest.headRepositoryNameWithOwner);
}

export function parseRepositoryOwnerLogin(nameWithOwner: string | null): string | null {
  const trimmed = nameWithOwner?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  // The first segment only: a nested path's owner is its top-level group. The full path
  // distinguishes subgroups.
  const [ownerLogin] = trimmed.split("/");
  const normalizedOwnerLogin = ownerLogin?.trim() ?? "";
  return normalizedOwnerLogin.length > 0 ? normalizedOwnerLogin : null;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeOptionalRepositoryNameWithOwner(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeOptionalOwnerLogin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  return normalized ? normalized.toLowerCase() : null;
}

interface PullRequestHeadIdentity {
  readonly repositoryNameWithOwner: string | null;
  readonly ownerLogin: string | null;
}

function resolveExpectedHeadIdentity(
  headContext: Pick<BranchHeadContext, "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin">,
): PullRequestHeadIdentity {
  const repositoryNameWithOwner = normalizeOptionalRepositoryNameWithOwner(
    headContext.headRepositoryNameWithOwner,
  );
  return {
    repositoryNameWithOwner,
    ownerLogin:
      normalizeOptionalOwnerLogin(headContext.headRepositoryOwnerLogin) ??
      parseRepositoryOwnerLogin(repositoryNameWithOwner),
  };
}

function resolvePullRequestHeadIdentity(pr: PullRequestInfo): PullRequestHeadIdentity {
  const repositoryNameWithOwner = normalizeOptionalRepositoryNameWithOwner(
    resolveHeadRepositoryNameWithOwner(pr),
  );
  return {
    repositoryNameWithOwner,
    ownerLogin:
      normalizeOptionalOwnerLogin(pr.headRepositoryOwnerLogin) ??
      parseRepositoryOwnerLogin(repositoryNameWithOwner),
  };
}

export function matchesBranchHeadContext(
  pr: PullRequestInfo,
  headContext: Pick<
    BranchHeadContext,
    "headBranch" | "headRepositoryNameWithOwner" | "headRepositoryOwnerLogin" | "isCrossRepository"
  >,
): boolean {
  if (pr.headRefName !== headContext.headBranch) {
    return false;
  }

  const expectedHead = resolveExpectedHeadIdentity(headContext);
  const pullRequestHead = resolvePullRequestHeadIdentity(pr);

  if (expectedHead.repositoryNameWithOwner) {
    if (pullRequestHead.repositoryNameWithOwner) {
      if (expectedHead.repositoryNameWithOwner !== pullRequestHead.repositoryNameWithOwner) {
        return false;
      }
    }
    if (expectedHead.ownerLogin && pullRequestHead.ownerLogin) {
      if (expectedHead.ownerLogin !== pullRequestHead.ownerLogin) {
        return false;
      }
    }
  }

  if (expectedHead.ownerLogin && pullRequestHead.ownerLogin) {
    if (expectedHead.ownerLogin !== pullRequestHead.ownerLogin) {
      return false;
    }
  }

  if (headContext.isCrossRepository) {
    if (pr.isCrossRepository === false) {
      return false;
    }
    if (
      (expectedHead.repositoryNameWithOwner || expectedHead.ownerLogin) &&
      !pullRequestHead.repositoryNameWithOwner &&
      !pullRequestHead.ownerLogin
    ) {
      return false;
    }
    return true;
  }

  if (pr.isCrossRepository === true) {
    if (
      (!expectedHead.repositoryNameWithOwner && !expectedHead.ownerLogin) ||
      (!pullRequestHead.repositoryNameWithOwner && !pullRequestHead.ownerLogin)
    ) {
      return false;
    }
  }

  return true;
}
