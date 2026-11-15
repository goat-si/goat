import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { isProviderNativeSubagentThread } from "@goat/contracts";

import { scopedThreadKey } from "../../lib/scopedEntities";
import type { ThreadInspectorPresentation } from "./thread-inspector-preview";
import type { ThreadActivityInput } from "./threadStatusAnnouncement";
import { useThreadStatusAnnouncements } from "./useThreadStatusAnnouncements";

/** The open thread route's screen-reader announcements, from what the route already reads. */
export function useOpenThreadStatusAnnouncements(
  thread: EnvironmentThreadShell | null,
  inspectorPresentation: ThreadInspectorPresentation | undefined,
  requests: {
    readonly activePendingApproval?: { readonly requestId: string } | null;
    readonly activePendingUserInput?: { readonly requestId: string } | null;
  },
  composer: {
    readonly activeWorkStartedAt: string | null;
    readonly isCompacting: boolean;
    readonly selectedThreadAnnouncedRun: ThreadActivityInput["run"];
    readonly selectedThreadDetailBehindShell: boolean;
  },
) {
  useThreadStatusAnnouncements({
    threadKey:
      thread === null || isProviderNativeSubagentThread(thread.source)
        ? null
        : scopedThreadKey(thread.environmentId, thread.id),
    // A preview beside its host names its thread, so the two threads' statuses can't be confused.
    subject:
      inspectorPresentation !== undefined && "onMaximize" in inspectorPresentation
        ? (thread?.title ?? null)
        : null,
    approvalRequestId: requests.activePendingApproval?.requestId ?? null,
    userInputRequestId: requests.activePendingUserInput?.requestId ?? null,
    shellRequestId: thread?.source.pendingRuntimeRequest?.id ?? null,
    shellPendingUserInput: thread?.hasPendingUserInput === true,
    working: composer.activeWorkStartedAt !== null || composer.isCompacting,
    run: composer.selectedThreadAnnouncedRun,
    detailBehind: composer.selectedThreadDetailBehindShell,
  });
}
