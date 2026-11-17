import type { EnvironmentId } from "@goat/contracts";

import {
  type ComposerThreadTarget,
  composerDraftHasUserContent,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { fileAttachmentCapabilityBlockReason } from "./composerAttachmentFiles";

export function readEnvironmentPresentation(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId);
}

export function draftHasNonPromptContent(target: ComposerThreadTarget) {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
}

/** The send's attachment capabilities, read live from the environment's server config. */
export function liveAttachmentCapabilities(
  environmentId: EnvironmentId,
  composerFilesSnapshot: Parameters<typeof fileAttachmentCapabilityBlockReason>[0]["files"],
) {
  const config = appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId) ?? null;
  const liveSupportsAttachmentUploads = config?.environment.capabilities.attachmentUploads === true;
  return {
    supportsAttachmentUploads: liveSupportsAttachmentUploads,
    fileBlockReason: fileAttachmentCapabilityBlockReason({
      files: composerFilesSnapshot,
      attachmentUploadsCapabilityKnown: config !== null,
      supportsAttachmentUploads: liveSupportsAttachmentUploads,
      maxFileAttachmentBytes:
        config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null,
    }),
  };
}

/** Why a multiple-model send needs a new thread in a Git project. */
export function showMultipleModelsNeedGitThread() {
  toastManager.add(
    stackedThreadToast({
      type: "warning",
      title: "Choose models and a base branch",
      description:
        "Multiple models need a new thread in a Git project. Each gets its own worktree.",
    }),
  );
}
