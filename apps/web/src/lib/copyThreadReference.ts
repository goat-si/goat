import type { ThreadReferenceCopyTarget } from "@goat/client-runtime/thread-reference";
import type { ThreadId } from "@goat/contracts";
import type { ReactNode } from "react";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@goat/shared/composerContextClipboard";
import { toastManager } from "../components/ui/toast";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";

export function threadIdCopyAction(threadId: ThreadId, icon: ReactNode) {
  return {
    kind: "action" as const,
    value: "action:copy-thread-id",
    searchTerms: ["copy", "thread", "id"],
    title: "Copy thread ID",
    description: threadId,
    icon,
    run: async () => {
      await writeTextToClipboard(threadId, "thread ID");
    },
  };
}

export async function copyThreadReference(target: ThreadReferenceCopyTarget) {
  try {
    const fragment = target.fragment && encodeComposerContextFragment(target.fragment);
    if (target.fragment && !fragment) throw new Error("Thread context is too large to copy.");
    if (
      await writeTextToClipboard(
        target.value,
        target.clipboardTarget,
        fragment ? { [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment } : undefined,
        Boolean(fragment),
      )
    ) {
      toastManager.add({ type: "success", title: target.successTitle });
    }
  } catch (error) {
    toastManager.add({
      type: "error",
      title: target.failureTitle,
      description: error instanceof Error ? error.message : "Clipboard unavailable",
    });
  }
}
