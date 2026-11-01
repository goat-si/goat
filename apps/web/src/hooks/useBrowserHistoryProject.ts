import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";
import { useEffect } from "react";

import { useBrowserHistoryStore } from "../browserHistoryStore";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKey,
  type ProjectGroupingSettings,
} from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import type { Project } from "../types";

/** Bind visits from every browser entry point to the active thread's sidebar project. */
export function useBrowserHistoryProject({
  threadRef,
  project,
  projects,
  settings,
  primaryEnvironmentId,
  clientSettingsHydrated,
}: {
  threadRef: ScopedThreadRef | null;
  project: Project | null;
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
  clientSettingsHydrated: boolean;
}) {
  useEffect(() => {
    if (!clientSettingsHydrated || !threadRef || !project) return;
    // Duplicate physical projects can borrow a sibling's repository identity;
    // use the sidebar's grouping rather than deriving from this project alone.
    const logicalKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects,
      settings,
      primaryEnvironmentId,
    });
    useBrowserHistoryStore
      .getState()
      .registerThreadProject(
        threadRef,
        logicalKeyByPhysicalKey.get(derivePhysicalProjectKey(project)) ??
          deriveLogicalProjectKeyFromSettings(project, settings),
      );
  }, [threadRef, project, projects, settings, primaryEnvironmentId, clientSettingsHydrated]);
}
