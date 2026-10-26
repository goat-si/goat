import type { EnvironmentId, PreviewTabContextRecord } from "@goat/contracts";
import { toKindScopedComposerContextId } from "@goat/shared/composerContextReferences";

import { randomUUID } from "~/lib/utils";
import { toastManager } from "../ui/toast";

/**
 * The browser tab a pasted context imports as, or undefined when the tab is on another
 * environment. A record whose id is already in the draft gets a fresh one.
 */
export function importedPreviewTabRecord(
  record: PreviewTabContextRecord,
  environmentId: EnvironmentId,
  conflicts: boolean,
): PreviewTabContextRecord | undefined {
  if (record.environmentId !== environmentId) {
    toastManager.add({
      type: "error",
      title: "Browser tab is on another machine",
      description: "Choose a tab on this environment instead.",
    });
    return undefined;
  }
  return conflicts
    ? {
        ...record,
        contextId: toKindScopedComposerContextId("preview-tab", randomUUID()),
      }
    : record;
}
