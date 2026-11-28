import type { MouseEvent } from "react";
import { openCommandPalette } from "../../commandPaletteBus";
import type { readNewThreadContext } from "../../hooks/useHandleNewThread";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";

export function resolveScopedNewThreadProjectRef<
  TRef extends { readonly environmentId: string; readonly projectId: string },
>(input: {
  shiftKey: boolean;
  scopedProjectGroups: readonly {
    readonly environmentId: string;
    readonly id: string;
    readonly memberProjectRefs: readonly TRef[];
  }[];
  viewed: { readonly environmentId: string; readonly projectId: string } | null | undefined;
}): TRef | null {
  const [group, ...otherGroups] = input.scopedProjectGroups;
  if (input.shiftKey || !group || otherGroups.length > 0) return null;
  const memberAt = (environmentId: string, projectId: string) =>
    group.memberProjectRefs.find(
      (ref) => ref.environmentId === environmentId && ref.projectId === projectId,
    );
  return (
    (input.viewed && memberAt(input.viewed.environmentId, input.viewed.projectId)) ??
    memberAt(group.environmentId, group.id) ??
    null
  );
}

export function createSidebarNewThreadHandler(input: {
  context: Omit<ReturnType<typeof readNewThreadContext>, "activeThread"> & {
    activeThread: ReturnType<typeof readNewThreadContext>["activeThread"] | null;
  };
  groups: readonly SidebarProjectSnapshot[];
  isMobile: boolean;
  closeMobile: () => void;
  startChatNew: () => Promise<void>;
}) {
  return (event?: MouseEvent) => {
    const scoped = resolveScopedNewThreadProjectRef({
      shiftKey: event?.shiftKey ?? false,
      scopedProjectGroups: input.groups,
      viewed: input.context.activeThread ?? input.context.activeDraftThread,
    });
    if (input.isMobile) input.closeMobile();
    if (scoped) {
      void input.context.handleNewThread(scoped);
    } else if (event?.shiftKey) {
      void startNewThreadFromContext({
        ...input.context,
        activeThread: input.context.activeThread ?? undefined,
      }).then((started) => {
        if (!started) openCommandPalette({ open: "new-thread-in" });
      });
    } else {
      void input.startChatNew();
    }
  };
}
