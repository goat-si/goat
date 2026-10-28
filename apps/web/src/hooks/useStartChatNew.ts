import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext, startNewThreadFromLastWork } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { readThreadShells, readProjects } from "../state/entities";
import { readNewThreadContext } from "./useHandleNewThread";
import { getClientSettings, getLegacySidebarEnabled } from "./useSettings";

/**
 * What the new-thread shortcut does: the last project the user wrote in, else the project
 * picker when several projects are ungrouped, else the current thread's project.
 */
export function useStartChatNew(): () => Promise<void> {
  return createStartChatNew(useRouter());
}

export function createStartChatNew(router: AnyRouter): () => Promise<void> {
  return async () => {
    const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
      readNewThreadContext(router);
    const projectsSidebarEnabled = getLegacySidebarEnabled();
    const projects = readProjects();
    const projectGroupCount = buildSidebarProjectSnapshots({
      projects,
      settings: selectProjectGroupingSettings(getClientSettings()),
      primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
      resolveEnvironmentLabel: () => null,
    }).length;
    // Read shells at call time so callers do not re-render on every thread update.
    const threads = readThreadShells();
    if (await startNewThreadFromLastWork({ threads, projects, handleNewThread })) return;
    if (projectsSidebarEnabled === false && projectGroupCount > 1) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    await startNewThreadFromContext({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
  };
}
