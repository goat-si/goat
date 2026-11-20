// A browser test: the attachment check reads real localStorage, which the unit environment lacks.
import { scopeProjectRef, scopedProjectKey } from "@goat/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@goat/contracts";
import { expect, it } from "vite-plus/test";

import { COMPOSER_DRAFT_STORAGE_KEY, DraftId, useComposerDraftStore } from "./composerDraftStore";

const TEST_ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-checkout");
const projectRef = scopeProjectRef(TEST_ENVIRONMENT_ID, projectId);

const persistedDraftThread = (id: string, extra: Record<string, unknown> = {}) => ({
  threadId: ThreadId.make(id),
  environmentId: TEST_ENVIRONMENT_ID,
  projectId,
  logicalProjectKey: scopedProjectKey(projectRef),
  createdAt: "2026-08-01T00:00:00.000Z",
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature/pr-42",
  worktreePath: null,
  envMode: "local",
  startFromOrigin: false,
  promotedTo: null,
  ...extra,
});

/** Seeds the stored drafts and clears them, and the store, when the test ends. */
async function storedDrafts(state: Record<string, unknown>) {
  localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify({ version: 10, state }));
  await useComposerDraftStore.persist.rehydrate();
  return {
    async [Symbol.asyncDispose]() {
      await useComposerDraftStore.persist.clearStorage();
      useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
    },
  };
}

/** What another tab, or another client version, writes into the shared storage. */
function writeFromAnotherTab(edit: (state: Record<string, Record<string, unknown>>) => void) {
  const stored = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
  edit(stored.state);
  localStorage.setItem(COMPOSER_DRAFT_STORAGE_KEY, JSON.stringify(stored));
}

it("keeps every other draft's prompt and saved images when another tab stores a malformed link", async () => {
  const otherTabDraftId = DraftId.make("draft-from-another-tab");
  const imageDraftId = DraftId.make("draft-with-image");
  const image = {
    id: "img-1",
    name: "shot.png",
    mimeType: "image/png",
    sizeBytes: 1,
    dataUrl: "data:image/png;base64,YQ==",
  };
  await using _drafts = await storedDrafts({
    draftsByThreadKey: { [imageDraftId]: { prompt: "kept with an image", attachments: [image] } },
    draftThreadsByThreadKey: { [imageDraftId]: persistedDraftThread("thread-image") },
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const store = useComposerDraftStore.getState();
  await store.syncPersistedAttachments(imageDraftId, [image]);

  // Writes merge with what is stored, so a draft this tab never touched keeps the other tab's value.
  writeFromAnotherTab((state) => {
    state.draftsByThreadKey = {
      ...state.draftsByThreadKey,
      [otherTabDraftId]: { prompt: "kept beside a bad link", attachments: [] },
    };
    state.draftThreadsByThreadKey = {
      ...state.draftThreadsByThreadKey,
      [otherTabDraftId]: persistedDraftThread("thread-other-tab", {
        checkoutPullRequest: { url: 5, branch: "x".repeat(5000) },
      }),
    };
  });
  await useComposerDraftStore.getState().syncPersistedAttachments(imageDraftId, [image]);

  const draft = useComposerDraftStore.getState().getComposerDraft(imageDraftId);
  expect(draft?.prompt).toBe("kept with an image");
  expect(draft?.persistedAttachments.map(({ id }) => id)).toEqual(["img-1"]);
  expect(draft?.nonPersistedImageIds).toEqual([]);
  const stored = JSON.parse(localStorage.getItem(COMPOSER_DRAFT_STORAGE_KEY) ?? "{}");
  expect(stored.state.draftsByThreadKey[otherTabDraftId]?.prompt).toBe("kept beside a bad link");

  // Reading it in this tab drops the malformed link and keeps the draft.
  await useComposerDraftStore.persist.rehydrate();
  const hydrated = useComposerDraftStore.getState();
  expect(hydrated.getDraftSession(otherTabDraftId)).toBeDefined();
  expect(hydrated.getDraftSession(otherTabDraftId)?.checkoutPullRequest).toBeUndefined();
  expect(hydrated.getComposerDraft(otherTabDraftId)?.prompt).toBe("kept beside a bad link");
});
