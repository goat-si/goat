export const coreResponse = (pullRequest: Readonly<Record<string, unknown>> = {}) => ({
  data: {
    repository: {
      mergeCommitAllowed: true,
      squashMergeAllowed: false,
      rebaseMergeAllowed: true,
      autoMergeAllowed: true,
      viewerPermission: "WRITE",
      pullRequest: {
        number: 7,
        title: "Pull request 7",
        url: "https://github.com/acme/web/pull/7",
        body: "",
        isDraft: false,
        mergeable: "MERGEABLE",
        mergeStateStatus: "BLOCKED",
        reviewDecision: null,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        mergedAt: null,
        closedAt: null,
        isCrossRepository: false,
        maintainerCanModify: true,
        headRepositoryOwner: null,
        headRepository: null,
        headRef: null,
        author: null,
        autoMergeRequest: null,
        headRefName: "feature",
        baseRefName: "main",
        headRefOid: "abc123",
        state: "OPEN",
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        viewerCanUpdate: true,
        viewerDidAuthor: false,
        viewerCanUpdateBranch: true,
        baseRef: { compare: { behindBy: 2 } },
        reviewRequests: { nodes: [] },
        labels: { nodes: [] },
        commits: { nodes: [] },
        ...pullRequest,
      },
    },
  },
});

export const rowDefaults = {
  author: null,
  state: "OPEN",
  isDraft: false,
  mergeable: "UNKNOWN",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  mergedAt: null,
  reviewRequests: { nodes: [] },
  labels: { nodes: [] },
  commits: { nodes: [] },
};

export const lastPage = { hasNextPage: false, endCursor: null };

export function rows(
  count: number,
  firstNumber: number,
  overrides: (number: number) => Readonly<Record<string, unknown>> = () => ({}),
): ReadonlyArray<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => {
    const number = firstNumber + index;
    const { reviewRequests, checks, ...rest } = overrides(number) as {
      reviewRequests?: ReadonlyArray<Record<string, string>>;
      checks?: string;
    } & Record<string, unknown>;
    return {
      ...rowDefaults,
      number,
      title: `Pull request ${number}`,
      url: `https://github.com/acme/web/pull/${number}`,
      headRefName: "feat/page",
      baseRefName: "main",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      repository: { nameWithOwner: "acme/web" },
      ...(reviewRequests === undefined
        ? {}
        : {
            reviewRequests: {
              nodes: reviewRequests.map((requestedReviewer) => ({
                requestedReviewer: {
                  __typename: "slug" in requestedReviewer ? "Team" : "User",
                  ...requestedReviewer,
                },
              })),
            },
          }),
      ...(checks === undefined
        ? {}
        : { commits: { nodes: [{ commit: { statusCheckRollup: { state: checks } } }] } }),
      ...rest,
    };
  });
}
