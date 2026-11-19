import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { act, fakeTimers, render } from "../../../test/render";
import { pullRequestGroups } from "./pullRequestListGroups.logic";
import type { EnvironmentPullRequestEntry } from "./pullRequestList.logic";
import { preferredPullRequestEntries } from "./pullRequestListTargets";
import { rememberPullRequestHosts } from "./pullRequestProjectAssignment.logic";
import {
  type PullRequestsSearch,
  usePullRequestQueryFilters,
  usePullRequestScope,
} from "./usePullRequestListView";

vi.mock(import("~/state/environments"), () => ({
  useEnvironments: () =>
    ({
      environments: ["own", "readable"].map((environmentId) => ({
        environmentId,
        label: environmentId,
        serverConfig: { environment: { capabilities: { pullRequests: true } } },
      })),
    }) as ReturnType<typeof import("~/state/environments").useEnvironments>,
}));

vi.mock(import("~/state/entities"), () => ({
  useAllEnvironmentShellsBootstrapped: () => true,
  useProjects: () =>
    ["own", "readable"].map((environmentId) => ({
      id: environmentId,
      environmentId,
      repositoryIdentity: { canonicalKey: "github:org/repo", provider: "github" },
    })) as unknown as ReturnType<typeof import("~/state/entities").useProjects>,
}));

it("keeps author:me on the preferred account in immediate rows and the debounced request", async () => {
  const own = EnvironmentId.make("own");
  const readable = EnvironmentId.make("readable");
  const kind = SourceControlProviderKind.make("github");
  const host = "github.com";
  const availability = rememberPullRequestHosts(new Map(), [
    [
      own,
      {
        providers: [
          {
            host,
            kind,
            configured: false,
            searchesOnHost: false,
            projectCount: 1,
            detail: null,
            projectIds: [ProjectId.make("own")],
          },
        ],
      },
      1,
    ],
  ]);
  const carried: EnvironmentPullRequestEntry = {
    environmentId: readable,
    projectId: ProjectId.make("readable"),
    projectTitle: "Fallback copy",
    provider: kind,
    host,
    repository: "org/repo",
    number: 1,
    title: "Sample PR",
    url: "https://github.com/org/repo/pull/1",
    author: { login: "fallback-viewer", name: null, avatarUrl: null },
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 0,
    deletions: 0,
    createdAt: "2026-11-18T00:00:00Z",
    updatedAt: "2026-11-18T00:00:00Z",
    viewerReviewRequested: false,
    labels: [],
  };

  function Probe({ q }: { q: string }) {
    const search: PullRequestsSearch = { involvement: "all", state: "open", q };
    const filters = usePullRequestQueryFilters(search, q);
    const scope = usePullRequestScope(search, availability, filters.filters.author);
    const { entries } = pullRequestGroups({
      known: [carried],
      baseline: [carried],
      providers: [],
      viewers: { [readable + ":" + host]: "fallback-viewer", [host]: "fallback-viewer" },
      involvement: "all",
      localFilters: filters.localFilters,
      hasLocalFilters: filters.hasLocalFilters,
      text: filters.typedParsed.text,
      answeredLocally: filters.querySettled,
      baselineEmpty: false,
      authored: undefined,
      reviewing: undefined,
      held: undefined,
      partitionsWanted: false,
      isPreferredEntry: preferredPullRequestEntries(scope.preferredEnvironmentQueries),
    });
    return (
      <>
        <output data-testid="query">
          {scope.environmentQueries.map(({ environmentId }) => environmentId).join(",")}
        </output>
        <output data-testid="rows">{entries.length}</output>
      </>
    );
  }

  await using screen = await render(<Probe q="" />);
  expect(screen.getByTestId("query").element().textContent).toBe("readable");
  expect(screen.getByTestId("rows").element().textContent).toBe("1");
  using _timers = fakeTimers();
  await screen.rerender(<Probe q="author:me" />);
  expect(screen.getByTestId("query").element().textContent).toBe("readable");
  expect(screen.getByTestId("rows").element().textContent).toBe("0");
  await act(() => vi.advanceTimersByTimeAsync(250));
  expect(screen.getByTestId("query").element().textContent).toBe("own");
});
