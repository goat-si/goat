import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestListEntry,
  type PullRequestListResult,
} from "@goat/contracts";
import {
  appendPullRequestListPage,
  DEFAULT_PR_LIST_CONTROLS,
  EMPTY_PULL_REQUEST_STATS_CACHE,
  filterPullRequestList,
  mergePullRequestListEntries,
  mergeEnvironmentPullRequestPages,
  nextPullRequestListInput,
  patchPullRequestListEntry,
  PR_LIST_PAGE_SIZE,
  pullRequestFilterChoices,
  pullRequestLabelColors,
  pullRequestListHead,
  pullRequestListInput,
  scopedPullRequestListKey,
  pullRequestListRowsAreEqual,
  pullRequestProjectOrderIsEqual,
  retainPullRequestStatsAnswers,
  withShownPullRequestStats,
  withAnsweredPullRequestStats,
  withListedPullRequests,
  withoutScratchProjectScope,
  pullRequestProjectChoices,
} from "./pullRequestList";

function entry(number: number, patch: Partial<PullRequestListEntry> = {}): PullRequestListEntry {
  return {
    number,
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    repository: "org/repo",
    projectId: "project" as PullRequestListEntry["projectId"],
    projectTitle: "Project",
    title: `Change ${number}`,
    url: `https://github.com/org/repo/pull/${number}`,
    author: { login: "octocat", name: null, avatarUrl: null },
    headBranch: `branch-${number}`,
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: `2026-10-${String(number).padStart(2, "0")}T00:00:00Z`,
    observedAt: 1,
    viewerReviewRequested: false,
    labels: [],
    ...patch,
  };
}
function page(
  entries: readonly PullRequestListEntry[],
  nextCursors: PullRequestListResult["nextCursors"] = {},
): PullRequestListResult {
  return {
    entries,
    nextCursors,
    truncated: Object.keys(nextCursors).length > 0,
    viewers: { "github.com": "octocat" },
    providers: [],
    errors: [],
  };
}

describe("recycled PR list rows", () => {
  const scopedEntry = (patch: Partial<PullRequestListEntry> = {}) => ({
    ...entry(1, patch),
    environmentId: EnvironmentId.make("env-one"),
  });

  it("updates navigation and commands when a duplicate moves to another environment", () => {
    const original = scopedEntry();
    expect(
      pullRequestListRowsAreEqual(original, {
        ...original,
        environmentId: EnvironmentId.make("env-two"),
      }),
    ).toBe(false);
  });
});

describe("mobile PR list pagination", () => {
  it("patches a head-only row before its pages have been recorded", () => {
    const head = page([entry(1)]);
    const patched = patchPullRequestListEntry(null, head, entry(1), { isDraft: true }, 20);
    expect(patched?.entries[0]).toMatchObject({ isDraft: true, observedAt: 20 });
    expect(patched && pullRequestListHead(patched, head)).toBe(patched);
  });

  it("patches the current head while preserving loaded continuations", () => {
    const recorded = appendPullRequestListPage(
      pullRequestListHead(null, page([entry(2)])),
      page([entry(1)], { repo: "next" }),
      { state: "open" },
    );
    const head = page([entry(3)]);
    const patched = patchPullRequestListEntry(recorded, head, entry(3), { state: "merged" }, 20);
    expect(patched?.entries.map(({ number, state }) => [number, state])).toEqual([
      [3, "merged"],
      [2, "open"],
      [1, "open"],
    ]);
    expect(patched?.nextCursors).toEqual({ repo: "next" });
  });

  it("continues only the repositories that have more, preserving the query and filters", () => {
    const first = pullRequestListHead(
      null,
      page([entry(3)], { "github.com org/repo": "opaque-boundary" }),
    );
    expect(
      nextPullRequestListInput(first, {
        state: "open",
        query: "fix",
        filters: { draft: "hide" },
        limit: 30,
      }),
    ).toEqual({
      state: "open",
      query: "fix",
      filters: { draft: "hide" },
      limit: 30,
      cursors: { "github.com org/repo": "opaque-boundary" },
    });
    const next = appendPullRequestListPage(first, page([entry(2), entry(1)]), {
      state: "open",
      cursors: first.nextCursors,
    });
    expect(next.entries.map((row) => row.number)).toEqual([3, 2, 1]);
    expect(nextPullRequestListInput(next, { state: "open" })).toBeNull();
  });
  it("deduplicates page boundaries and never overwrites a fresh row with an older slice", () => {
    const current = entry(2, { title: "Retitled", observedAt: 20 });
    expect(
      mergePullRequestListEntries([current], [entry(2, { observedAt: 10 }), entry(1)]),
    ).toEqual([current, entry(1)]);
    expect(
      mergePullRequestListEntries([entry(1)], [entry(2, { host: "enterprise.test" }), entry(2)]),
    ).toHaveLength(3);
  });
  it("refreshes the head without dropping older loaded pages or rewinding their cursor", () => {
    const first = pullRequestListHead(null, page([entry(3)], { repo: "first" }));
    const continued = appendPullRequestListPage(first, page([entry(2)], { repo: "second" }), {
      state: "open",
      cursors: first.nextCursors,
    });
    const updated = pullRequestListHead(
      continued,
      page([entry(4), entry(3, { title: "New title", observedAt: 2 })], { repo: "first-new" }),
    );
    expect(updated.entries.map((row) => row.number)).toEqual([4, 3, 2]);
    expect(updated.entries[1]?.title).toBe("New title");
    expect(updated.nextCursors).toEqual({ repo: "second" });
    expect(pullRequestListHead(updated, updated.head)).toBe(updated);
  });
  it("can grow legacy listings that provide no cursor, without exceeding the wire limit", () => {
    const first = pullRequestListHead(null, { ...page([entry(1)]), truncated: true });
    expect(nextPullRequestListInput(first, { state: "all" })?.limit).toBe(60);
    expect(nextPullRequestListInput({ ...first, limit: 490 }, { state: "all" })?.limit).toBe(500);
    expect(nextPullRequestListInput({ ...first, limit: 500 }, { state: "all" })).toBeNull();
  });
});

describe("shown PR diff stats", () => {
  it("does not restore an old shown answer after a live row changes", () => {
    const environmentId = EnvironmentId.make("env-one");
    const stat = {
      projectId: entry(1).projectId,
      repository: "org/repo",
      number: 1,
      additions: 5,
      deletions: 2,
    };
    const row = { ...entry(1, { updatedAt: "2026-10-20T00:00:00Z" }), environmentId };
    const { cache } = withListedPullRequests(EMPTY_PULL_REQUEST_STATS_CACHE, [row]);
    const rows = [row];
    const answers = [{ environmentId, stats: [stat] }];
    expect(withShownPullRequestStats(rows, answers, new Map([[environmentId, cache]]))).toBe(rows);
    expect(withShownPullRequestStats(rows, answers, new Map()).at(0)?.additions).toBe(5);
  });

  it("keeps each offline answer while a newly visible stats batch has no answer", () => {
    const first = EnvironmentId.make("env-one");
    const second = EnvironmentId.make("env-two");
    const stat = {
      projectId: entry(1).projectId,
      repository: "org/repo",
      number: 1,
      additions: 5,
      deletions: 2,
    };
    const previous = [
      { environmentId: first, stats: [stat] },
      { environmentId: second, stats: [stat] },
    ];
    expect(
      retainPullRequestStatsAnswers(
        [
          { environmentId: first, stats: null },
          { environmentId: second, stats: null },
        ],
        previous,
      ),
    ).toBe(previous);
    const next = retainPullRequestStatsAnswers(
      [
        { environmentId: first, stats: [{ ...stat, additions: 8 }] },
        { environmentId: second, stats: null },
      ],
      previous,
    );
    const rows = [first, second].map((environmentId) => ({ ...entry(1), environmentId }));
    expect(withShownPullRequestStats(rows, next).map(({ additions }) => additions)).toEqual([8, 5]);
    expect(retainPullRequestStatsAnswers([{ environmentId: first, stats: [] }], previous)).toEqual([
      { environmentId: first, stats: [] },
    ]);
  });

  it("fills offline counts per environment without replacing newer row counts", () => {
    const first = EnvironmentId.make("env-one");
    const second = EnvironmentId.make("env-two");
    const rows = [
      { ...entry(1), environmentId: first },
      { ...entry(1), environmentId: second },
      { ...entry(2, { additions: 9 }), environmentId: first },
    ];
    const stat = (number: number, additions: number) => ({
      projectId: entry(number).projectId,
      repository: "org/repo",
      number,
      additions,
      deletions: 2,
    });
    const filled = withShownPullRequestStats(rows, [
      { environmentId: first, stats: [stat(1, 5), stat(2, 3)] },
      { environmentId: second, stats: [stat(1, 7)] },
    ]);
    expect(filled.map(({ additions }) => additions)).toEqual([5, 7, 9]);
    expect(filled[2]).toBe(rows[2]);
    expect(withShownPullRequestStats(rows, [])).toBe(rows);
  });
});

describe("cached PR diff stats", () => {
  const stat = (number: number, additions: number) => ({
    projectId: entry(number).projectId,
    repository: "org/repo",
    number,
    additions,
    deletions: 0,
  });

  it("evicts pushed rows and refreshes each answering query once, preserving other rows", () => {
    const query = {
      refs: [1, 2, 3].map((number) => ({
        projectId: entry(number).projectId,
        repository: "org/repo",
        number,
      })),
    };
    const listed = withListedPullRequests(EMPTY_PULL_REQUEST_STATS_CACHE, [
      entry(1),
      entry(2),
      entry(3),
    ]);
    expect(listed.refresh).toEqual([]);
    const answered = withAnsweredPullRequestStats(listed.cache, query, [
      stat(1, 5),
      stat(2, 7),
      stat(3, 9),
    ]);
    expect(withListedPullRequests(answered, [entry(1), entry(2), entry(3)])).toEqual({
      cache: answered,
      refresh: [],
    });
    const pushed = withListedPullRequests(answered, [
      entry(1, { updatedAt: "2026-10-20T00:00:00Z" }),
      entry(2, { updatedAt: "2026-10-20T00:00:00Z" }),
      entry(3),
    ]);
    expect([...pushed.cache.stats.values()]).toEqual([stat(3, 9)]);
    expect(pushed.refresh).toEqual([query]);
    expect(
      withListedPullRequests(pushed.cache, [entry(1, { updatedAt: "2026-10-20T00:00:00Z" })]).cache,
    ).toBe(pushed.cache);
    expect([...answered.stats.values()]).toEqual([stat(1, 5), stat(2, 7), stat(3, 9)]);
    const refreshed = withAnsweredPullRequestStats(pushed.cache, query, [stat(1, 0), stat(2, 11)]);
    expect([...refreshed.stats.values()]).toEqual([stat(3, 9), stat(1, 0), stat(2, 11)]);
  });

  it("keeps identical PR references independent across environment caches and projects", () => {
    const query = { refs: [{ projectId: entry(1).projectId, repository: "org/repo", number: 1 }] };
    const original = withListedPullRequests(EMPTY_PULL_REQUEST_STATS_CACHE, [entry(1)]).cache;
    const local = withAnsweredPullRequestStats(original, query, [stat(1, 5)]);
    const remote = withAnsweredPullRequestStats(original, query, [stat(1, 7)]);
    const otherProject = entry(1, { projectId: "other" as PullRequestListEntry["projectId"] });
    expect(withListedPullRequests(local, [otherProject]).cache.stats.size).toBe(1);
    const pushed = withListedPullRequests(local, [entry(1, { updatedAt: "2026-10-20T00:00:00Z" })]);
    expect(pushed.cache.stats.size).toBe(0);
    expect([...remote.stats.values()]).toEqual([stat(1, 7)]);
  });
});

describe("PR filter project order", () => {
  it("ignores rebuilt groups while noticing group, member and environment changes", () => {
    const first = { environmentId: EnvironmentId.make("env-one"), projectId: entry(1).projectId };
    const second = { ...first, projectId: "other" as PullRequestListEntry["projectId"] };
    const order = [{ memberProjectRefs: [first, second] }];
    expect(
      pullRequestProjectOrderIsEqual(order, [{ memberProjectRefs: [{ ...first }, { ...second }] }]),
    ).toBe(true);
    expect(pullRequestProjectOrderIsEqual(order, [{ memberProjectRefs: [second, first] }])).toBe(
      false,
    );
    expect(
      pullRequestProjectOrderIsEqual(order, [
        { memberProjectRefs: [first] },
        { memberProjectRefs: [second] },
      ]),
    ).toBe(false);
    expect(
      pullRequestProjectOrderIsEqual(order, [
        { memberProjectRefs: [first, { ...second, environmentId: EnvironmentId.make("env-two") }] },
      ]),
    ).toBe(false);
  });
});

describe("all-environment PR list", () => {
  const cups = EnvironmentId.make("cups");
  const mbp = EnvironmentId.make("mbp");
  it("combines independent pages, collapses duplicate PRs, and keeps their source for navigation", () => {
    const first = pullRequestListHead(null, page([entry(3), entry(1)], { repo: "cups-next" }));
    const second = pullRequestListHead(null, page([entry(2), entry(1)], { repo: "mbp-next" }));
    const merged = mergeEnvironmentPullRequestPages([
      { environmentId: cups, pages: first },
      { environmentId: mbp, pages: second },
    ]);
    const rows = filterPullRequestList(
      merged.entries,
      DEFAULT_PR_LIST_CONTROLS,
      merged.viewers,
      "",
      merged.localSearchHosts,
    );
    expect(rows.map((row) => [row.number, row.environmentId])).toEqual([
      [3, cups],
      [2, mbp],
      [1, cups],
    ]);
    expect(scopedPullRequestListKey(rows[1]!)).toBe("mbp:github.com:org/repo:2");
    expect(nextPullRequestListInput(first, { state: "open" })?.cursors).toEqual({
      repo: "cups-next",
    });
    expect(nextPullRequestListInput(second, { state: "open" })?.cursors).toEqual({
      repo: "mbp-next",
    });
    const continued = appendPullRequestListPage(first, page([entry(4)]), {
      state: "open",
      cursors: first.nextCursors,
    });
    expect(nextPullRequestListInput(continued, { state: "open" })).toBeNull();
    expect(nextPullRequestListInput(second, { state: "open" })?.cursors).toEqual({
      repo: "mbp-next",
    });
  });
  it("uses the viewer account and search support from each environment before deduplicating", () => {
    const remote = {
      ...page([entry(1, { author: { login: "other", name: null, avatarUrl: null } })]),
      viewers: { "github.com": "other" },
    };
    const local = page([entry(1), entry(2)]);
    const merged = mergeEnvironmentPullRequestPages([
      { environmentId: cups, pages: pullRequestListHead(null, remote) },
      { environmentId: mbp, pages: pullRequestListHead(null, local) },
    ]);
    const byMe = filterPullRequestList(
      merged.entries,
      { ...DEFAULT_PR_LIST_CONTROLS, involvement: "authored" },
      merged.viewers,
      "",
      merged.localSearchHosts,
    );
    expect(byMe.map((row) => [row.number, row.environmentId])).toEqual([
      [2, mbp],
      [1, cups],
    ]);
    const localOnlySearch = new Set([`${cups} github.com`]);
    const searched = filterPullRequestList(
      merged.entries,
      DEFAULT_PR_LIST_CONTROLS,
      merged.viewers,
      "body match",
      localOnlySearch,
    );
    expect(searched.map((row) => [row.number, row.environmentId])).toEqual([
      [2, mbp],
      [1, mbp],
    ]);
  });
  it("scopes a project to its owning environment even if another has the same project id", () => {
    const merged = mergeEnvironmentPullRequestPages([
      { environmentId: cups, pages: pullRequestListHead(null, page([entry(1)])) },
      { environmentId: mbp, pages: pullRequestListHead(null, page([entry(2)])) },
    ]);
    expect(
      filterPullRequestList(
        merged.entries,
        { ...DEFAULT_PR_LIST_CONTROLS, projectId: "project", projectEnvironmentId: mbp },
        merged.viewers,
        "",
        merged.localSearchHosts,
      ).map((row) => row.environmentId),
    ).toEqual([mbp]);
  });
});

describe("mobile PR scan and filters", () => {
  it("resolves authored and author:me per host rather than mixing account identities", () => {
    const rows = [entry(1), entry(2, { host: "enterprise.test" })];
    const viewers = { "github.com": "Octocat", "enterprise.test": "someone-else" };
    expect(
      filterPullRequestList(
        rows,
        { ...DEFAULT_PR_LIST_CONTROLS, involvement: "authored" },
        viewers,
        "",
        new Set(),
      ).map((row) => row.number),
    ).toEqual([1]);
    expect(
      filterPullRequestList(
        rows,
        { ...DEFAULT_PR_LIST_CONTROLS, filters: { author: "me" } },
        viewers,
        "",
        new Set(),
      ).map((row) => row.number),
    ).toEqual([1]);
    expect(
      filterPullRequestList(rows, DEFAULT_PR_LIST_CONTROLS, viewers, "author:@me", new Set()).map(
        (row) => row.number,
      ),
    ).toEqual([1]);
  });
  it("reads a typed draft qualifier as a filter and searches only the text left over", () => {
    expect(pullRequestListInput(DEFAULT_PR_LIST_CONTROLS, "draft:false fix")).toEqual({
      state: "open",
      involvement: "all",
      filters: { draft: "hide" },
      limit: PR_LIST_PAGE_SIZE,
      query: "fix",
    });
    const rows = [
      entry(1, { title: "Fix parser" }),
      entry(2, { title: "Fix drafts", isDraft: true }),
      entry(3),
    ];
    expect(
      filterPullRequestList(
        rows,
        DEFAULT_PR_LIST_CONTROLS,
        {},
        "draft:false fix",
        new Set(["github.com"]),
      ).map((row) => row.number),
    ).toEqual([1]);
  });
  it("does not label unsupported review summaries as reviewed or match text locally on host-search results", () => {
    expect(
      filterPullRequestList(
        [entry(1)],
        { ...DEFAULT_PR_LIST_CONTROLS, filters: { review: "approved" } },
        {},
        "body text",
        new Set(),
      ),
    ).toHaveLength(1);
    expect(
      filterPullRequestList(
        [entry(1)],
        DEFAULT_PR_LIST_CONTROLS,
        {},
        "body text",
        new Set(["github.com"]),
      ),
    ).toHaveLength(0);
  });
  it("lists a shared repository's row from a connected environment over an offline one", () => {
    const rows = [
      { ...entry(1), environmentId: "laptop" },
      { ...entry(1), environmentId: "server" },
    ];
    const pick = (connected: ReadonlySet<string>) =>
      filterPullRequestList(rows, DEFAULT_PR_LIST_CONTROLS, {}, "", new Set(), connected).map(
        (row) => row.environmentId,
      );
    expect(pick(new Set(["server"]))).toEqual(["server"]);
    expect(pick(new Set(["laptop", "server"]))).toEqual(["laptop"]);
    expect(pick(new Set())).toEqual(["laptop"]);
  });
});

describe("withoutScratchProjectScope", () => {
  const projects = [
    { id: "repo", environmentId: "env-a" },
    { id: "scratch", environmentId: "env-a", isScratch: true as const },
  ];

  it("reads a scope saved on the Scratch folder as all projects", () => {
    const controls = withoutScratchProjectScope(
      { ...DEFAULT_PR_LIST_CONTROLS, projectId: "scratch", projectEnvironmentId: "env-a" },
      projects,
    );
    expect(controls.projectId).toBeUndefined();
    expect(controls.projectEnvironmentId).toBeUndefined();
  });

  it("keeps a repository scope, and one whose projects have not arrived yet", () => {
    const repository = {
      ...DEFAULT_PR_LIST_CONTROLS,
      projectId: "repo",
      projectEnvironmentId: "env-a",
    };
    expect(withoutScratchProjectScope(repository, projects)).toBe(repository);
    const pending = { ...repository, projectId: "scratch" };
    expect(withoutScratchProjectScope(pending, [])).toBe(pending);
  });

  it("keeps another server's project that shares the Scratch folder's id", () => {
    const elsewhere = {
      ...DEFAULT_PR_LIST_CONTROLS,
      projectId: "scratch",
      projectEnvironmentId: "env-b",
    };
    expect(withoutScratchProjectScope(elsewhere, projects)).toBe(elsewhere);
  });
});

describe("pullRequestLabelColors", () => {
  it("keeps the first usable color each label name carries", () => {
    expect(
      pullRequestLabelColors([
        { name: "Bug", color: null },
        { name: "bug", color: "d73a4a" },
        { name: "BUG", color: "#000000" },
        { name: "docs", color: "not-a-color" },
        { name: "size:S", color: "#69C35F" },
      ]),
    ).toEqual({ bug: "#d73a4a", "size:s": "#69C35F" });
  });
});

describe("pullRequestFilterChoices", () => {
  it("keeps the picked value in view and adds host answers no loaded row carries, once", () => {
    expect(
      pullRequestFilterChoices({
        selected: ["size:XL"],
        suggestions: ["bug", "size:XL", "docs"],
        hosted: ["Bug", "backend"],
        query: "b",
      }),
    ).toEqual(["size:XL", "bug", "backend"]);
  });

  it("leaves room for the host's answers when loaded matches alone would fill the list", () => {
    const loaded = Array.from({ length: 120 }, (_, index) => `label-${index}`);
    const rows = pullRequestFilterChoices({
      selected: [],
      suggestions: loaded,
      hosted: ["label-from-host"],
      query: "label",
    });
    expect(rows).toHaveLength(100);
    expect(rows[50]).toBe("label-from-host");
  });
});

describe("pullRequestProjectChoices", () => {
  const laptop = EnvironmentId.make("env-laptop");
  const desktop = EnvironmentId.make("env-desktop");
  const project = (id: string, environmentId: EnvironmentId) => ({
    id: ProjectId.make(id),
    environmentId,
    title: "t3code",
    workspaceRoot: `/work/${id}`,
    repositoryIdentity: { canonicalKey: "github.com/pingdotgg/t3code" },
  });
  const projects = [project("main", laptop), project("worktree", laptop), project("main", desktop)];
  const choices = (
    servesPullRequests: (environmentId: EnvironmentId) => boolean,
    scope: { projectId?: string; projectEnvironmentId?: string } = {},
  ) =>
    pullRequestProjectChoices(projects, {
      environmentId: null,
      controls: { ...DEFAULT_PR_LIST_CONTROLS, ...scope },
      environmentLabels: new Map([
        [laptop, "laptop"],
        [desktop, "desktop"],
      ]),
      servesPullRequests,
    }).map(({ id, environmentId, title }) => ({ id, environmentId, title }));

  it("lists each repository once per environment that serves pull requests", () => {
    expect(choices(() => true)).toEqual([
      { id: "main", environmentId: desktop, title: "t3code · desktop" },
      { id: "main", environmentId: laptop, title: "t3code · laptop" },
    ]);
    expect(choices((environmentId) => environmentId === desktop)).toEqual([
      { id: "main", environmentId: desktop, title: "t3code" },
    ]);
  });

  it("keeps the saved scope when its environment stops serving or has not loaded", () => {
    const scope = { projectId: "worktree", projectEnvironmentId: laptop };
    expect(choices((environmentId) => environmentId === desktop, scope)).toEqual([
      { id: "main", environmentId: desktop, title: "t3code · desktop" },
      { id: "worktree", environmentId: laptop, title: "t3code · laptop" },
    ]);
    expect(choices(() => false, scope)).toEqual([
      { id: "worktree", environmentId: laptop, title: "t3code" },
    ]);
  });
});
