import type { EnvironmentId } from "@goat/contracts";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { environmentPresentations } from "~/state/presentation";
import {
  composerDraftHasUserContent,
  useComposerDraftStore,
  type ComposerThreadTarget,
} from "~/composerDraftStore";

export function readEnvironmentPresentation(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId);
}

export function draftHasNonPromptContent(target: ComposerThreadTarget) {
  const draft = useComposerDraftStore.getState().getComposerDraft(target);
  return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
}
