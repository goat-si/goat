import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@goat/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { useContext } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { type ComposerThreadTarget, useComposerDraftStore } from "../../composerDraftStore";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function useApplyThreadModelPick() {
  const registry = useContext(RegistryContext);
  const setModelSelection = useOrchestrationCommand(threadEnvironment.setModelSelection, {
    reportFailure: false,
  });
  return useStableCallback(async (target: ComposerThreadTarget) => {
    if (typeof target === "string") return;
    const store = useComposerDraftStore.getState();
    const key = scopedThreadKey(target);
    const draft = store.draftsByThreadKey[key];
    const pick = draft?.activeProvider
      ? draft.modelSelectionByProvider[draft.activeProvider]
      : undefined;
    const thread = registry.get(environmentThreadShells.threadShellAtom(target));
    if (
      !pick ||
      !thread ||
      store.draftThreadsByThreadKey[key] ||
      pick.instanceId !== thread.modelSelection.instanceId
    )
      return;
    const result = await setModelSelection({
      environmentId: target.environmentId,
      input: { threadId: target.threadId, modelSelection: pick },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not apply model selection",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    }
  });
}
