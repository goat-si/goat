import { expect, it } from "vite-plus/test";
import { composerTextCommandIsLocal } from "./composerSideChatPresentation";

it("recognizes offered usage, feedback and fork commands as local", () => {
  const options = {
    hasAttachmentsOrContext: false,
    usageLimits: true,
    codexFeedback: true,
    fork: true,
  };
  expect(composerTextCommandIsLocal("/usage-limits", options)).toBe(true);
  expect(composerTextCommandIsLocal("/feedback details", options)).toBe(true);
  expect(composerTextCommandIsLocal("/fork", options)).toBe(true);
  expect(composerTextCommandIsLocal("ordinary", options)).toBe(false);
});

it("recognizes feedback text even when a preview-tab reference is present", () => {
  const options = {
    hasAttachmentsOrContext: false,
    usageLimits: false,
    codexFeedback: true,
    fork: false,
  };
  expect(
    composerTextCommandIsLocal(
      "/feedback details [Tab](goat-context://v1/preview-tab/tab_1)",
      options,
    ),
  ).toBe(true);
});

it("shows a side-chat action when an unreferenced reply remains in the draft", async () => {
  const { composerSideChatIsLocal } = await import("./composerSideChatPresentation");
  type Draft = import("../../composerDraftStore").ComposerThreadDraftState;
  type Props = import("./ChatComposer").ChatComposerProps;
  const draft = {
    images: [],
    files: [],
    persistedAttachments: [],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    previewTabs: [],
    replyTo: {},
  } as unknown as Draft;
  const props = {
    multipleModelSelections: null,
    editingQueuedAttachments: null,
    activePendingProgress: null,
  } as unknown as Props;
  expect(
    composerSideChatIsLocal("/side hi", true, draft, draft, { props, selectedProvider: "codex" }),
  ).toBe(true);
});
