import { clearComposerDraft, waitForComposerDraftsLoaded } from "./use-composer-drafts";

const DRAFT_HYDRATION_TIMEOUT_MS = 5_000;

export function clearDeletedThreadDraft(draftKey: string): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("Draft hydration timed out")),
      DRAFT_HYDRATION_TIMEOUT_MS,
    );
  });
  void Promise.race([waitForComposerDraftsLoaded(), timeout])
    .then(() => clearComposerDraft(draftKey))
    .catch((error: unknown) =>
      console.warn("[composer-drafts] could not clear a deleted thread draft", error),
    )
    .finally(() => clearTimeout(timer));
}
