import { openCommandPalette } from "../commandPaletteBus";
import { startNewThreadFromContext, startNewThreadFromLastWork } from "../lib/chatThreadActions";
import { selectProjectGroupingSettings } from "../logicalProject";
import { buildSidebarProjectSnapshots } from "../sidebarProjectGrouping";
import { readThreadShells, useProjects } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useHandleNewThread } from "./useHandleNewThread";
import { useClientSettings, useLegacySidebarEnabled } from "./useSettings";

/**
 * What the new-thread shortcut does: the last project the user wrote in, else the project
 * picker when several projects are ungrouped, else the current thread's project.
 */
export function useStartChatNew(): () => Promise<void> {
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const projectsSidebarEnabled = useLegacySidebarEnabled();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupCount = buildSidebarProjectSnapshots({
    projects,
    settings: projectGroupingSettings,
    primaryEnvironmentId,
    resolveEnvironmentLabel: () => null,
  }).length;
  return async () => {
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
