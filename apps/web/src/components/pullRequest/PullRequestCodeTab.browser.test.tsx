import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestDiffResult,
} from "@goat/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

const {
  diffAtom,
  pagedDiffAtom,
  imageDiffAtom,
  withheldPageAtom,
  withheldFileAtom,
  withheldFilesAtom,
  withheldAdvertisementAtom,
} = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const filePatch = (path: string) =>
    [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,6 +1,6 @@",
      "-before()",
      "+after()",
      " one()",
      " two()",
      " three()",
      " four()",
      " five()",
      "",
    ].join("\n");
  const firstPage: PullRequestDiffResult = {
    patch: filePatch("a.ts"),
    truncated: false,
    nextCursor: null,
  };
  // An environment query whose refetch returns equal content hands back the previous value
  // itself, so a refresh publishes a new result around the very same page.
  const pages: Record<string, PullRequestDiffResult> = {
    first: {
      patch: Array.from({ length: 40 }, (_, index) => filePatch(`early-${index}.ts`)).join(""),
      truncated: true,
      nextCursor: "page-2",
    },
    "page-2": { patch: filePatch("late.ts"), truncated: false, nextCursor: null },
  };
  // GitHub sends no patch for a binary file, so its section is the header alone.
  const imagePage: PullRequestDiffResult = {
    patch: [
      "diff --git a/docs/shot.png b/docs/shot.png",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/shot.png",
      "",
    ].join("\n"),
    truncated: false,
    nextCursor: null,
  };
  const omittedPatch = [
    "diff --git a/large.js b/large.js",
    "--- a/large.js",
    "+++ b/large.js",
    "",
  ].join("\n");
  const withheldPage: PullRequestDiffResult = {
    patch: omittedPatch,
    truncated: true,
    nextCursor: null,
    omittedFileStats: [{ path: "large.js", additions: 1, deletions: 1 }],
    withheldFilesReadable: true,
  };
  const withheldFileAtom = Atom.family((key: string) => {
    const { path, headSha } = JSON.parse(key) as { path: string; headSha: string };
    const patch =
      path === "large.js"
        ? omittedPatch +
          "@@ -1 +1 @@\n-original()\n+" +
          (headSha.startsWith("b") ? "afterPush()" : "beforePush()") +
          "\n"
        : "";
    return Atom.make(() => {
      mocks.withheldFileReads++;
      return AsyncResult.success({ patch, truncated: false, nextCursor: null });
    });
  });
  const withheldFilesAtom = Atom.family((key: string) => {
    const { target, paths } = JSON.parse(key) as {
      target: { input: { revision: { headSha: string } } };
      paths: string[];
    };
    return Atom.make((get) =>
      paths.map((path) =>
        get(
          withheldFileAtom(
            JSON.stringify({
              path,
              headSha: target.input.revision.headSha,
            }),
          ),
        ),
      ),
    );
  });
  return {
    withheldPageAtom: Atom.family((_fixture: number) =>
      Atom.make(() =>
        AsyncResult.success({
          ...withheldPage,
          revision: { baseSha: "c".repeat(40), headSha: mocks.withheldHeadSha },
        }),
      ),
    ),
    withheldFileAtom,
    withheldFilesAtom,
    withheldAdvertisementAtom: Atom.family((fresh: boolean) => Atom.make(() => fresh)),
    diffAtom: Atom.make(() => AsyncResult.success(firstPage)),
    imageDiffAtom: Atom.make(() => AsyncResult.success(imagePage)),
    pagedDiffAtom: Atom.family((cursor: string) =>
      Atom.make(() => AsyncResult.success(pages[cursor]!)),
    ),
  };
});

const mocks = vi.hoisted(() => ({
  paged: false,
  image: false,
  withheld: false,
  freshWithheldAdvertisement: true,
  withheldFileReads: 0,
  withheldFixture: 0,
  withheldHeadSha: "a".repeat(40),
  assetResources: [] as unknown[],
  diffCommits: [] as Array<string | undefined>,
}));

vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: ((_environmentId: unknown, resource: unknown) => {
    if (resource !== null) mocks.assetResources.push(resource);
    return {
      _tag: "Success",
      url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    };
  }) as never,
  useAssetUrlRefresh: (() => async () => null) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      withheldDiffs: withheldFilesAtom as never,
      withheldDiffAdvertised: () => withheldAdvertisementAtom(mocks.freshWithheldAdvertisement),
      withheldDiff: (({ input }: { input: { path: string; revision: { headSha: string } } }) =>
        withheldFileAtom(
          JSON.stringify({ path: input.path, headSha: input.revision.headSha }),
        )) as never,
      diff: (({ input }: { input: { commit?: string; cursor?: string } }) => {
        mocks.diffCommits.push(input.commit);
        if (mocks.image) return imageDiffAtom;
        if (mocks.withheld) return withheldPageAtom(mocks.withheldFixture);
        return mocks.paged ? pagedDiffAtom(input.cursor ?? "first") : diffAtom;
      }) as never,
    },
  };
});

import { render } from "../../../test/render";
import PullRequestCodeTab from "./PullRequestCodeTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

function setup(paged = false, image = false) {
  mocks.paged = paged;
  mocks.image = image;
  mocks.withheld = false;
  mocks.freshWithheldAdvertisement = true;
  mocks.withheldFileReads = 0;
  mocks.withheldFixture++;
  mocks.withheldHeadSha = "a".repeat(40);
  mocks.assetResources = [];
  mocks.diffCommits = [];
}

const tab = (
  refreshToken: number,
  revealRequest: { readonly path: string; readonly nonce: number } | null = null,
  selectedCommitOid: string | null = null,
  tabDetail: PullRequestDetailView = detail,
) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={detail}
    detail={tabDetail}
    selectedCommitOid={selectedCommitOid}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    refreshToken={refreshToken}
    revealRequest={revealRequest}
  />
);

it("keeps the diff after a refresh that brings back the same page", async () => {
  setup();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  await screen.rerender(tab(1));

  await expect
    .element(screen.getByText("This pull request has no file changes."))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
});

it("never requests the diff of a selected commit the pull request no longer has", async () => {
  setup();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  // The timeline can open a commit that a force-push removed from the pull request.
  await using screen = await render(
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={{
        ...detail,
        commits: [
          {
            oid: "kept",
            messageHeadline: "Kept commit",
            committedDate: "2026-09-01T00:00:00Z",
          },
        ],
      }}
      selectedCommitOid="gone"
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
    />,
    { container },
  );

  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Diff scope: All commits" }))
    .toBeVisible();
  expect(mocks.diffCommits).not.toContain("gone");
});

async function expectFileHeaderShown(
  screen: Awaited<ReturnType<typeof render>>,
  container: HTMLElement,
  path: string,
) {
  const header = screen.getByText(path, { exact: true }).first();
  await expect.element(header).toBeInTheDocument();
  await vi.waitFor(() => {
    const top = header.element().getBoundingClientRect().top;
    const bounds = container.getBoundingClientRect();
    expect(top).toBeGreaterThanOrEqual(bounds.top);
    expect(top).toBeLessThan(bounds.top + bounds.height / 2);
  });
}

it("reveals a pending file across pages while a stale selected commit falls back to all commits", async () => {
  setup(true);
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  // The diff scope menu only renders for a pull request that still has commits.
  const keptCommit = {
    oid: "kept",
    messageHeadline: "Kept commit",
    committedDate: "2026-09-01T00:00:00Z",
  };
  await using screen = await render(
    tab(0, { path: "late.ts", nonce: 1 }, "gone", { ...detail, commits: [keptCommit] }),
    { container },
  );

  await expectFileHeaderShown(screen, container, "late.ts");
  await expect
    .element(screen.getByRole("button", { name: "Diff scope: All commits" }))
    .toBeVisible();
  expect(mocks.diffCommits).not.toContain("gone");
});

it("scrolls to a loaded file requested before the viewer mounts", async () => {
  setup(true);
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  await using screen = await render(tab(0, { path: "early-39.ts", nonce: 1 }), { container });

  await expectFileHeaderShown(screen, container, "early-39.ts");
});

it("previews an image the host sent no patch for at the pull request's head", async () => {
  setup(false, true);
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px] flex-col";
  const headSha = "0123456789abcdef0123456789abcdef01234567";
  await using _screen = await render(tab(0, null, null, { ...detail, headSha }), { container });

  // A file the host sent no patch for starts collapsed; the image shows once a person expands it.
  const image = page.getByAltText("docs/shot.png", { exact: true });
  await expect.element(image).not.toBeVisible();
  const header = await vi.waitFor(() => {
    const found = container
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector<HTMLElement>("[data-diffs-header]");
    expect(found).toBeTruthy();
    return found!;
  });
  await userEvent.click(header);
  await expect.element(image).toBeVisible();
  expect(mocks.assetResources).toContainEqual({
    _tag: "github-media",
    cwd: "/workspace",
    url: `https://github.com/owner/repo/raw/${headSha}/docs/shot.png`,
    repository: "owner/repo",
  });
});

it("drops a loaded withheld patch across a force-push and loads the current file on demand", async () => {
  setup();
  mocks.withheld = true;
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const original = { ...detail, headSha: "a".repeat(40) };
  const pushed = { ...detail, headSha: "b".repeat(40) };
  await using screen = await render(tab(0, null, null, original), { container });
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  const load = screen.getByRole("button", { name: "Load file diff" });
  await expect.element(load).toBeVisible();
  await userEvent.click(load);
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();

  mocks.withheldHeadSha = pushed.headSha;
  await screen.rerender(tab(1, null, null, pushed));
  await expect.element(screen.getByText("beforePush()", { exact: true })).not.toBeInTheDocument();
  await expect.element(load).toBeVisible();
  await userEvent.click(load);
  await expect.element(screen.getByText("afterPush()", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
});

it("keeps a cached withheld page readable after a rollback without offering a file request", async () => {
  setup();
  mocks.withheld = true;
  mocks.freshWithheldAdvertisement = false;
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await expect.element(screen.getByText("This file’s diff is too large to display.")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Load file diff" }))
    .not.toBeInTheDocument();
});

it("retains a loaded immutable patch when the Code tab refreshes the same revision", async () => {
  setup();
  mocks.withheld = true;
  mocks.withheldHeadSha = "d".repeat(40);
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await userEvent.click(screen.getByRole("button", { name: "Load file diff" }));
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  const reads = mocks.withheldFileReads;

  await screen.rerender(tab(1));
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  expect(mocks.withheldFileReads).toBe(reads);
});
