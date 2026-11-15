import type { EnvironmentId, ProjectId } from "@goat/contracts";

import { appAtomRegistry } from "./atom-registry";
import {
  composerDraftsAtom,
  retargetNewTaskDraft,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";

/** Retargets a saved draft once drafts load; an absent one is not created. */
export async function retargetSavedNewTaskDraft(
  draftKey: string,
  project: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId },
): Promise<boolean> {
  await waitForComposerDraftsLoaded();
  if (appAtomRegistry.get(composerDraftsAtom)[draftKey] === undefined) return false;
  retargetNewTaskDraft(draftKey, project);
  return true;
}
