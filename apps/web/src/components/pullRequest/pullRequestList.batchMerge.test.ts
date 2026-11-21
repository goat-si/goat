import { SourceControlProviderKind } from "@goat/contracts";
import type { EnvironmentId, ProjectId, PullRequestListEntry } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergePullRequestLists, type EnvironmentPullRequestEntry } from "./pullRequestList.logic";

const ENV_1 = "env-1" as EnvironmentId;
const ENV_2 = "env-2" as EnvironmentId;

function entry(
  overrides: Partial<EnvironmentPullRequestEntry> & Pick<PullRequestListEntry, "number">,
) {
  return {
    environmentId: "env-1",
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: "project-1",
    projectTitle: "t3code",
    repository: "goat-si/goat",
    title: "Add the pull requests page",
    url: `https://github.com/goat-si/goat/pull/${overrides.number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `feat/branch-${overrides.number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
    ...overrides,
  } as EnvironmentPullRequestEntry;
}

const answer = (overrides: Partial<Parameters<typeof mergePullRequestLists>[0][number][1]> = {}) =>
  ({
    viewers: { "github.com": "Bilal" },
    providers: [
      {
        host: "github.com",
        kind: "github",
        searchesOnHost: true,
        projectCount: 1,
        configured: true,
        detail: null,
      },
    ],
    entries: [],
    errors: [],
    truncated: false,
    nextCursors: {},
    ...overrides,
  }) as Parameters<typeof mergePullRequestLists>[0][number][1];

describe("merging project batches from one environment", () => {
  it.each([false, true])(
    "merges worktree batches without duplicate rows (reversed: %s)",
    (reverse) => {
      const older = entry({
        projectId: "worktree-1" as ProjectId,
        number: 4,
        updatedAt: "2026-07-01T00:00:00Z",
      });
      const newer = entry({
        projectId: "worktree-101" as ProjectId,
        number: 4,
        updatedAt: "2026-07-02T00:00:00Z",
      });
      const rows = reverse ? [newer, older] : [older, newer];
      const merged = mergePullRequestLists([
        ...rows.map((row) => [ENV_1, answer({ entries: [row] })] as const),
        [ENV_2, answer({ entries: [older] })],
      ]);
      expect(merged?.entries).toEqual([{ ...newer, environmentId: ENV_1 }]);
    },
  );

  it("keeps Azure pull requests from distinct projects with the same repository name and number", () => {
    const first = entry({
      provider: SourceControlProviderKind.make("azure-devops"),
      host: "dev.azure.com",
      repository: "web",
      number: 4,
      projectId: "azure-first" as ProjectId,
      url: "https://dev.azure.com/acme/first/_git/web/pullrequest/4",
    });
    const second = {
      ...first,
      projectId: "azure-second" as ProjectId,
      url: "https://dev.azure.com/acme/second/_git/web/pullrequest/4",
    };
    const merged = mergePullRequestLists([[ENV_1, answer({ entries: [first, second] })]]);
    expect(merged?.entries).toEqual(
      [first, second].map((entry) => ({ ...entry, environmentId: ENV_1 })),
    );
  });

  it("keeps continuations from every project batch on the same environment", () => {
    const merged = mergePullRequestLists([
      [ENV_1, answer({ truncated: true, nextCursors: { "github.com acme/first": "cursor-1" } })],
      [ENV_1, answer({ truncated: true, nextCursors: { "github.com acme/second": "cursor-2" } })],
    ]);
    expect(merged?.nextCursors).toEqual({
      [ENV_1]: { "github.com acme/first": "cursor-1", "github.com acme/second": "cursor-2" },
    });
    expect(merged?.truncatedEnvironments).toEqual([ENV_1]);
  });
});
