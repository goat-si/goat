import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
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
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { DEFAULT_CLIENT_SETTINGS } from "@goat/contracts/settings";

const {
  diffAtom,
  onlyTestFilesDiffAtom,
  pagedDiffAtom,
  imageDiffAtom,
  withheldPageAtom,
  withheldFileAtom,
  withheldFilesAtom,
  withheldAdvertisementAtom,
  revisionReviewAtom,
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
  const refreshedFirstPage: PullRequestDiffResult = {
    patch: `${filePatch("a.ts")}${filePatch("b.ts")}`,
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
        AsyncResult.success(
          mocks.inlineWithheldPage
            ? firstPage
            : {
                ...withheldPage,
                revision: { baseSha: "c".repeat(40), headSha: mocks.withheldHeadSha },
              },
        ),
      ),
    ),
    withheldFileAtom,
    withheldFilesAtom,
    withheldAdvertisementAtom: Atom.family((fresh: boolean) => Atom.make(() => fresh)),
    revisionReviewAtom: Atom.make(true),
    diffAtom: Atom.make(() =>
      AsyncResult.success(mocks.refreshed ? refreshedFirstPage : firstPage),
    ),
    onlyTestFilesDiffAtom: Atom.make(
      AsyncResult.success({ ...firstPage, patch: filePatch("a.test.ts") }),
    ),
    imageDiffAtom: Atom.make(() => AsyncResult.success(imagePage)),
    pagedDiffAtom: Atom.family((cursor: string) =>
      Atom.make(() => AsyncResult.success(pages[cursor]!)),
    ),
  };
});

const mocks = vi.hoisted(() => ({
  paged: false,
  refreshed: false,
  onlyTestFiles: false,
  image: false,
  withheld: false,
  inlineWithheldPage: false,
  freshWithheldAdvertisement: true,
  withheldFileReads: 0,
  withheldFixture: 0,
  withheldHeadSha: "a".repeat(40),
  assetResources: [] as unknown[],
  diffCommits: [] as Array<string | undefined>,
  viewedPaths: null as ReadonlySet<string> | null,
  viewedListeners: new Set<() => void>(),
  command: vi.fn(),
}));

function deliverViewedPaths(paths: ReadonlySet<string> | null) {
  mocks.viewedPaths = paths;
  for (const listener of mocks.viewedListeners) listener();
}

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
  useAtomCommand: (() => mocks.command) as never,
}));
vi.mock(import("./usePullRequestFilesViewed"), async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.viewedListeners.add(listener);
    return () => mocks.viewedListeners.delete(listener);
  };
  return {
    usePullRequestFilesViewed: () => {
      const viewedPaths = useSyncExternalStore(subscribe, () => mocks.viewedPaths);
      return {
        enabled: viewedPaths !== null,
        isViewed: (path: string) => viewedPaths?.has(path) === true,
        isStale: () => false,
        setViewed: () => {},
        truncated: false,
        error: null,
        refresh: () => {},
      };
    },
  };
});
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      withheldDiffs: withheldFilesAtom as never,
      revisionReviewSupported: () => revisionReviewAtom,
      withheldDiffAdvertised: () => withheldAdvertisementAtom(mocks.freshWithheldAdvertisement),
      withheldDiff: (({ input }: { input: { path: string; revision: { headSha: string } } }) =>
        withheldFileAtom(
          JSON.stringify({ path: input.path, headSha: input.revision.headSha }),
        )) as never,
      diff: (({ input }: { input: { commit?: string; cursor?: string } }) => {
        mocks.diffCommits.push(input.commit);
        if (mocks.image) return imageDiffAtom;
        if (mocks.withheld) return withheldPageAtom(mocks.withheldFixture);
        if (mocks.onlyTestFiles) return onlyTestFilesDiffAtom;
        return mocks.paged ? pagedDiffAtom(input.cursor ?? "first") : diffAtom;
      }) as never,
    },
  };
});

import { act, fakeTimers, render } from "../../../test/render";
import { RegistryContext } from "@effect/atom-react";
import { AtomRegistry } from "effect/reactivity";
import PullRequestCodeTab from "./PullRequestCodeTab";
import { PullRequestReviewForm } from "./PullRequestReviewForm";
import { pullRequestReviewKey, usePullRequestReviewStore } from "./pullRequestReviewStore";

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
  mocks.refreshed = false;
  mocks.onlyTestFiles = false;
  mocks.image = image;
  mocks.withheld = false;
  mocks.inlineWithheldPage = false;
  mocks.freshWithheldAdvertisement = true;
  mocks.withheldFileReads = 0;
  mocks.withheldFixture++;
  mocks.withheldHeadSha = "a".repeat(40);
  mocks.assetResources = [];
  mocks.diffCommits = [];
  mocks.viewedPaths = null;
  mocks.viewedListeners.clear();
  mocks.command.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  usePullRequestReviewStore.getState().clear(pullRequestReviewKey(detail));
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

it("can show test files again from the narrow Code tab empty state", async () => {
  setup();
  mocks.onlyTestFiles = true;
  const container = document.createElement("div");
  container.className = "h-[700px] w-[429px]";
  await using screen = await render(tab(0), { container });
  await screen.getByRole("button", { name: "Hide test files", exact: true }).click();

  await expect.element(screen.getByText("1 test file hidden", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Show test files", exact: true }).click();
  await expect.element(screen.getByText("a.test.ts", { exact: true }).first()).toBeVisible();
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

// regression: #42199 an agent's push re-keyed every file and dropped the comment being typed
it("keeps an unfinished inline comment when a background refresh changes another file", async () => {
  setup();
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: false });
  using _preferences = {
    [Symbol.dispose]() {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    },
  };
  const reviewable = {
    ...detail,
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, inlineComment: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
  };
  const reviewTab = (backgroundRefreshToken: number) => (
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={reviewable}
      detail={reviewable}
      selectedCommitOid={null}
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
      backgroundRefreshToken={backgroundRefreshToken}
    />
  );
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(reviewTab(0), { container });
  const header = screen.getByText("a.ts", { exact: true }).first();
  await expect.element(header).toBeVisible();
  const root = header.element().getRootNode() as ShadowRoot;
  await userEvent.click(root.querySelector<HTMLElement>('[data-column-number="1"]')!);
  const input = () => screen.getByRole("textbox", { name: "Comment on lines a.ts:1" });
  await input().fill("Unsent review note");

  mocks.refreshed = true;
  await screen.rerender(reviewTab(1));

  await expect.element(screen.getByText("2 files", { exact: true })).toBeVisible();
  await expect.element(input()).toHaveValue("Unsent review note");
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
  await using screen = await render(
    tab(0, null, null, { ...detail, headSha: mocks.withheldHeadSha }),
    { container },
  );
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
  await using screen = await render(
    tab(0, null, null, { ...detail, headSha: mocks.withheldHeadSha }),
    { container },
  );
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await userEvent.click(screen.getByRole("button", { name: "Load file diff" }));
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  const reads = mocks.withheldFileReads;

  await screen.rerender(tab(1, null, null, { ...detail, headSha: mocks.withheldHeadSha }));
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  expect(mocks.withheldFileReads).toBe(reads);
});

it("stops review of withheld lines when detail advances before the diff page", async () => {
  setup();
  mocks.withheld = true;
  const original = {
    ...detail,
    headSha: mocks.withheldHeadSha,
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, inlineComment: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
  };
  const pushed = { ...original, headSha: "b".repeat(40) };
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0, null, null, original), { container });
  const load = screen.getByRole("button", { name: "Load file diff" });
  const draft = screen.getByRole("textbox");
  const oldLine = screen.getByText("beforePush()", { exact: true });
  const renderedLineControl = (selector: string) =>
    vi.waitFor(() => {
      const control = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector<HTMLElement>(selector);
      if (!control) throw new Error(`Missing diff control: ${selector}`);
      return control;
    });
  const openDraft = async () => {
    await userEvent.hover(
      await renderedLineControl("[data-column-number][data-line-type='change-addition']"),
    );
    await userEvent.click(await renderedLineControl("[data-utility-button]"));
    await expect.element(draft).toBeVisible();
  };
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await userEvent.click(load);
  await expect.element(oldLine).toBeVisible();
  await openDraft();

  await screen.rerender(tab(0, null, null, pushed));
  await expect.element(oldLine).not.toBeInTheDocument();
  await expect.element(draft).not.toBeInTheDocument();
  await expect.element(load).not.toBeInTheDocument();

  mocks.withheldHeadSha = pushed.headSha;
  await screen.rerender(tab(1, null, null, pushed));
  await userEvent.click(load);
  await expect.element(screen.getByText("afterPush()", { exact: true })).toBeVisible();
  await openDraft();
});

function reviewableWithheldDetail(headSha = mocks.withheldHeadSha) {
  return {
    ...detail,
    headSha,
    capabilities: {
      ...detail.capabilities,
      review: { ...detail.capabilities.review, inlineComment: true },
    },
    viewerPermissions: { ...detail.viewerPermissions, comment: true },
  };
}

async function openWithheldDraft(container: HTMLElement) {
  const control = (selector: string) =>
    vi.waitFor(() => {
      const found = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector<HTMLElement>(selector);
      if (!found) throw new Error("Missing diff control: " + selector);
      return found;
    });
  await userEvent.hover(await control("[data-column-number][data-line-type='change-addition']"));
  await userEvent.click(await control("[data-utility-button]"));
}

function codeWithReview(pr: PullRequestDetailView, refreshToken = 0) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="min-h-0 flex-1">{tab(refreshToken, null, null, pr)}</div>
      <PullRequestReviewForm
        environmentId={EnvironmentId.make("environment")}
        reference={detail}
        headSha={pr.headSha}
        completionScope={null}
        term="pull request"
        verdicts={["comment"]}
        requestChangesSummaryRequired={false}
        textareaRef={{ current: null }}
        pending={false}
        onPendingChange={() => {}}
        onSubmitted={() => {}}
      />
    </div>
  );
}

it("blocks queued withheld-line review after a force-push", async () => {
  setup();
  mocks.withheld = true;
  const original = reviewableWithheldDetail();
  const pushed = reviewableWithheldDetail("b".repeat(40));
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(codeWithReview(original), { container });
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await userEvent.click(screen.getByRole("button", { name: "Load file diff" }));
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  await openWithheldDraft(container);
  await userEvent.fill(
    screen.getByRole("textbox", { name: /Comment on lines/ }),
    "Keep this review note",
  );
  await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
  const submit = screen.getByRole("button", { name: "Submit review" });
  await expect.element(submit).toBeEnabled();

  await screen.rerender(codeWithReview(pushed));
  await expect.element(submit).toBeDisabled();
  expect(mocks.command).not.toHaveBeenCalled();
  await expect.element(screen.getByRole("button", { name: "Move comment" })).toBeDisabled();

  mocks.withheldHeadSha = pushed.headSha;
  await screen.rerender(codeWithReview(pushed, 1));
  await userEvent.click(screen.getByRole("button", { name: "Move comment" }));
  await userEvent.click(screen.getByRole("button", { name: "Load file diff" }));
  await expect.element(screen.getByText("afterPush()", { exact: true })).toBeVisible();
  await openWithheldDraft(container);
  await expect
    .element(screen.getByRole("textbox", { name: /Comment on lines/ }))
    .toHaveValue("Keep this review note");
  await userEvent.click(screen.getByRole("button", { name: "Move comment here" }));
  await expect.element(submit).toBeEnabled();
  await userEvent.click(submit);
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      input: expect.objectContaining({
        revision: { headSha: pushed.headSha, baseSha: "c".repeat(40) },
        comments: [
          {
            path: "large.js",
            position: { kind: "added", newLine: 1 },
            body: "Keep this review note",
          },
        ],
      }),
    }),
  );
});

it("preserves an open inline draft across a force-push until the reader re-anchors it", async () => {
  setup();
  mocks.withheld = true;
  const original = reviewableWithheldDetail();
  const pushed = reviewableWithheldDetail("b".repeat(40));
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0, null, null, original), { container });
  const load = screen.getByRole("button", { name: "Load file diff" });
  const editor = screen.getByRole("textbox", { name: /Comment on lines/ });
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await userEvent.click(load);
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  await openWithheldDraft(container);
  await userEvent.fill(editor, "An unsent note on this line");

  await screen.rerender(tab(0, null, null, pushed));
  const parked = screen.getByRole("region", { name: "Stale inline draft" });
  const reanchor = parked.getByRole("button", { name: "Re-anchor draft" });
  await expect.element(parked.getByText("An unsent note on this line")).toBeVisible();
  await expect.element(reanchor).toBeDisabled();
  await expect.element(editor).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: "Add to review" }))
    .not.toBeInTheDocument();

  mocks.withheldHeadSha = pushed.headSha;
  await screen.rerender(tab(1, null, null, pushed));
  await expect.element(reanchor).toBeEnabled();
  await expect.element(editor).not.toBeInTheDocument();
  await userEvent.click(reanchor);
  await userEvent.click(load);
  await expect.element(screen.getByText("afterPush()", { exact: true })).toBeVisible();
  await openWithheldDraft(container);
  await expect.element(editor).toHaveValue("An unsent note on this line");
  await expect.element(parked).not.toBeInTheDocument();
});

it("requires moving a queued comment when the same head gets an inline diff without a verified base", async () => {
  setup();
  mocks.withheld = true;
  const pr = reviewableWithheldDetail();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(codeWithReview(pr), { container });
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await userEvent.click(screen.getByRole("button", { name: "Load file diff" }));
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  await openWithheldDraft(container);
  await userEvent.fill(
    screen.getByRole("textbox", { name: /Comment on lines/ }),
    "Check this base",
  );
  await userEvent.click(screen.getByRole("button", { name: "Add to review" }));
  const submit = screen.getByRole("button", { name: "Submit review" });
  await expect.element(submit).toBeEnabled();

  mocks.inlineWithheldPage = true;
  await screen.rerender(codeWithReview(pr, 1));
  await expect.element(screen.getByText("a.ts", { exact: true })).toBeVisible();
  await expect.element(submit).toBeDisabled();
  expect(mocks.command).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "Move comment" }));
  const expand = screen.getByRole("button", { name: "Expand diff" });
  if (expand.query()) await userEvent.click(expand);
  await expect.element(screen.getByText("after()", { exact: true })).toBeVisible();
  await openWithheldDraft(container);
  await expect
    .element(screen.getByRole("textbox", { name: /Comment on lines/ }))
    .toHaveValue("Check this base");
  await userEvent.click(screen.getByRole("button", { name: "Move comment here" }));
  await userEvent.click(submit);
  expect(mocks.command).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      input: expect.objectContaining({
        revision: { headSha: pr.headSha },
        comments: [
          { path: "a.ts", position: { kind: "added", newLine: 1 }, body: "Check this base" },
        ],
      }),
    }),
  );
});

it("explains why a connection that only offers withheld reads cannot queue a line review", async () => {
  setup();
  mocks.withheld = true;
  const registry = AtomRegistry.make();
  using _registry = { [Symbol.dispose]: () => registry.dispose() };
  using _capability = { [Symbol.dispose]: registry.mount(revisionReviewAtom) };
  registry.set(revisionReviewAtom, false);
  const pr = reviewableWithheldDetail();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(
    <RegistryContext value={registry}>{codeWithReview(pr)}</RegistryContext>,
    { container },
  );
  await userEvent.click(screen.getByRole("button", { name: "Expand diff" }));
  await userEvent.click(screen.getByRole("button", { name: "Load file diff" }));
  await expect.element(screen.getByText("beforePush()", { exact: true })).toBeVisible();
  await openWithheldDraft(container);
  const editor = screen.getByRole("textbox", { name: /Comment on lines/ });
  await userEvent.fill(editor, "Keep this unsent");
  const queue = screen.getByRole("button", { name: "Add to review" });
  await expect.element(queue).toBeDisabled();
  await expect
    .element(
      screen.getByText("This connection cannot submit review comments at a specific revision."),
    )
    .toBeVisible();
  await userEvent.keyboard("{Control>}{Enter}{/Control}");
  await expect.element(editor).toHaveValue("Keep this unsent");
  await expect.element(screen.getByRole("button", { name: "Submit review" })).toBeDisabled();

  await act(() => registry.set(revisionReviewAtom, true));
  await expect.element(queue).toBeEnabled();
  await userEvent.click(queue);
  await expect.element(screen.getByRole("button", { name: "Submit review" })).toBeEnabled();
});

const linked = (
  revealUrl: string | undefined,
  onRevealSettled: (url: string) => void,
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
    revealRequest={revealRequest}
    revealUrl={revealUrl}
    onRevealSettled={onRevealSettled}
  />
);
const diffAnchor = (path: string) => bytesToHex(sha256(new TextEncoder().encode(path)));

it("pages forward to a linked line range, settles the link, and reveals it again on a later click", async () => {
  setup(true);
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  const settled = vi.fn();
  await using screen = await render(linked(undefined, settled), { container });
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();

  const url = `${detail.url}/files#diff-${diffAnchor("late.ts")}R4-R5`;
  await screen.rerender(linked(url, settled));

  await expectFileHeaderShown(screen, container, "late.ts");
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
  await screen.rerender(linked(undefined, settled, { path: "early-0.ts", nonce: 1 }));
  await expectFileHeaderShown(screen, container, "early-0.ts");
  await screen.rerender(linked(url, settled, { path: "early-0.ts", nonce: 1 }));
  await expectFileHeaderShown(screen, container, "late.ts");
});

it("answers a commit's diff link only once that commit's diff is shown", async () => {
  setup();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const oid = "c".repeat(40);
  const withCommit = {
    ...detail,
    commits: [{ oid, messageHeadline: "Linked commit", committedDate: "2026-09-01T00:00:00Z" }],
  };
  const url = `${detail.url}/commits/${oid}#diff-${diffAnchor("a.ts")}R2`;
  const settled = vi.fn();
  await using screen = await render(linked(undefined, settled, null, null, withCommit), {
    container,
  });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  // The panel selects the link's commit after this tab has already seen the link.
  await screen.rerender(linked(url, settled, null, null, withCommit));
  expect(settled).not.toHaveBeenCalled();
  await screen.rerender(linked(url, settled, null, oid, withCommit));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
});

// regression: a Viewed answer that lands after a link reveals a file must not fold it
it("keeps a revealed file open when its Viewed mark loads afterwards", async () => {
  setup();
  using _preferences = __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    diffFilesCollapsed: false,
  });
  mocks.viewedPaths = new Set();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0, { path: "a.ts", nonce: 1 }), { container });
  await using _poolCleanup = {
    async [Symbol.asyncDispose]() {
      // Dispose the shared diff pool before the next test mounts a fresh viewer.
      using _timers = fakeTimers();
      await screen.unmount();
      await act(() => vi.runOnlyPendingTimersAsync());
    },
  };
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();

  deliverViewedPaths(new Set(["a.ts"]));
  await expect.element(screen.getByRole("checkbox", { name: "Viewed" })).toBeChecked();

  await expect
    .element(screen.getByRole("button", { name: "Collapse diff" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();
});
