import type { EnvironmentId, UnifiedSettings } from "@goat/contracts";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@goat/client-runtime/state/runtime";

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

export const selectPlanModeEnabled = (settings: UnifiedSettings) => settings.planModeEnabled;

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

/**
 * The redirect's settings, saved before it declines pending approvals: a mode change the server
 * refuses during the turn then declines nothing. The refusal's text, or null once saved or not needed.
 */
export async function saveSettingsBeforeRedirect(
  changesMode: boolean,
  save: () => Promise<AtomCommandResult<void, unknown>>,
): Promise<string | null> {
  if (!changesMode) return null;
  const result = await save();
  if (result._tag === "Success") return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Failed to send message.";
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

/** The branch a send saves when the local checkout moved off the thread's branch. */
export const checkoutBranchOverride = (mismatch: { readonly currentBranch: string } | null) =>
  mismatch ? { branch: mismatch.currentBranch } : {};

/** Runs `run` on the first call; later calls return that first result. */
export const firstCallOnly = <A>(run: () => A): (() => A) => {
  let first: { readonly value: A } | undefined;
  return () => {
    if (first === undefined) first = { value: run() };
    return first.value;
  };
};
