import { scopeProjectRef, scopedProjectKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPOSER_DRAFT_STORAGE_KEY,
  DraftId,
  partializeComposerDraftStoreState,
  useComposerDraftStore,
} from "./composerDraftStore";
import { checkoutPullRequestUrlToLink } from "./composerDraftCheckoutPullRequest";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const STORAGE_VERSION = 10;
const projectId = ProjectId.make("project-checkout");
const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, projectId);
const otherProjectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, ProjectId.make("project-other"));
const threadId = ThreadId.make("thread-checkout");
const draftId = DraftId.make("draft-checkout");
const url = "https://github.com/acme/widgets/pull/42";
const checkout = { url, branch: "feature/pr-42" };

function resetComposerDraftStore() {
  useComposerDraftStore.setState({
    rewindingThreadKeys: new Set(),
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyOptionsByModelByProvider: {},
    stickyActiveProvider: null,
  });
}

const store = () => useComposerDraftStore.getState();
const toLink = () => checkoutPullRequestUrlToLink(store().getDraftSession(draftId));

const persistedDraftThread = (id: ThreadId, extra: Record<string, unknown> = {}) => ({
  threadId: id,
  environmentId: TEST_ENVIRONMENT_ID,
  projectId,
  logicalProjectKey: scopedProjectKey(projectRef),
  createdAt: "2026-08-01T00:00:00.000Z",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: checkout.branch,
  worktreePath: null,
  envMode: "local",
  startFromOrigin: false,
  promotedTo: null,
  ...extra,
});

async function rehydrateFrom(state: Record<string, unknown>) {
  const storage = useComposerDraftStore.persist.getOptions().storage;
  expect(storage).toBeDefined();
  storage?.setItem(COMPOSER_DRAFT_STORAGE_KEY, { version: STORAGE_VERSION, state } as never);
  await vi.advanceTimersByTimeAsync(300);
  await useComposerDraftStore.persist.rehydrate();
}

beforeEach(async () => {
  vi.useFakeTimers();
  await useComposerDraftStore.persist.clearStorage();
  resetComposerDraftStore();
});

afterEach(async () => {
  await useComposerDraftStore.persist.clearStorage();
  vi.useRealTimers();
  resetComposerDraftStore();
});

describe("composerDraftStore checkout pull request", () => {
  // GitActionsControl's live branch sync writes the git status branch onto the draft. The status
  // refresh after a checkout is forked server-side, so the prepare response lands first and the
  // sync replays the stale pre-checkout branch before the fresh status corrects it.
  function liveBranchSync(branch: string) {
    store().setDraftThreadContext(draftId, {
      branch,
      worktreePath: null,
      environmentSelection: "manual",
    });
  }

  it("still links after a local checkout the live branch sync briefly reverts", () => {
    store().setProjectDraftThreadId(projectRef, draftId, { threadId, branch: "main" });
    store().setDraftThreadContext(draftId, {
      branch: checkout.branch,
      worktreePath: null,
      envMode: "local",
      checkoutPullRequest: checkout,
    });
    liveBranchSync("main");
    liveBranchSync(checkout.branch);

    expect(toLink()).toBe(url);
  });

  it("does not link once the draft has moved to another branch", () => {
    store().setProjectDraftThreadId(projectRef, draftId, { threadId, branch: "main" });
    store().setDraftThreadContext(draftId, {
      branch: checkout.branch,
      checkoutPullRequest: checkout,
    });
    liveBranchSync("main");

    expect(toLink()).toBeNull();
  });

  it("is dropped when cleared or when the draft moves to another project", () => {
    store().setProjectDraftThreadId(projectRef, draftId, {
      threadId,
      branch: checkout.branch,
      checkoutPullRequest: checkout,
    });
    store().setDraftThreadContext(draftId, { checkoutPullRequest: null });
    expect(store().getDraftSession(draftId)?.checkoutPullRequest).toBeUndefined();

    store().setDraftThreadContext(draftId, { checkoutPullRequest: checkout });
    store().setDraftThreadContext(draftId, { projectRef: otherProjectRef });
    expect(store().getDraftSession(draftId)?.checkoutPullRequest).toBeUndefined();
  });

  it("persists the pull request, and restores drafts saved before the field existed", async () => {
    const legacyDraftId = DraftId.make("draft-before-checkout-links");
    await rehydrateFrom({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {
        [draftId]: persistedDraftThread(threadId, { checkoutPullRequest: checkout }),
        [legacyDraftId]: persistedDraftThread(ThreadId.make("thread-legacy")),
      },
      logicalProjectDraftThreadKeyByLogicalProjectKey: { [scopedProjectKey(projectRef)]: draftId },
    });

    expect(toLink()).toBe(url);
    const legacy = store().getDraftSession(legacyDraftId);
    expect(legacy).toMatchObject({ branch: checkout.branch });
    expect(checkoutPullRequestUrlToLink(legacy)).toBeNull();
    // The writer writes the typed value only.
    expect(
      partializeComposerDraftStoreState(store()).draftThreadsByThreadKey[draftId],
    ).toMatchObject({ checkoutPullRequest: checkout });
  });
});
