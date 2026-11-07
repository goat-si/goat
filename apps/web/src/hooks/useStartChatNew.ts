import { type AnyRouter, useRouter } from "@tanstack/react-router";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext, startNewThreadFromLastWork } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { readThreadShells, readProjects } from "../state/entities";
import { readNewThreadContext } from "./useHandleNewThread";
import { getClientSettings } from "./useSettings";

/**
 * Offer project selection when several projects are open; otherwise reuse last work.
 */
export function useStartChatNew(): () => Promise<void> {
  return createStartChatNew(useRouter());
}

export function createStartChatNew(router: AnyRouter): () => Promise<void> {
  return async () => {
    const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
      readNewThreadContext(router);
    const projects = readProjects();
    const projectGroups = buildSidebarProjectSnapshots({
      projects,
      settings: selectProjectGroupingSettings(getClientSettings()),
      primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
      resolveEnvironmentLabel: () => null,
    });
    if (projectGroups.filter((group) => !group.archived).length > 1) {
      openCommandPalette({ open: "new-thread-in" });
      return;
    }
    // Read shells at call time so callers do not re-render on every thread update.
    const threads = readThreadShells();
    if (await startNewThreadFromLastWork({ threads, projects, handleNewThread })) return;
    const started = await startNewThreadFromContext({
      activeDraftThread,
      activeThread: activeThread ?? undefined,
      defaultProjectRef,
      handleNewThread,
    });
    if (!started) openCommandPalette({ open: "new-thread-in" });
  };
}
