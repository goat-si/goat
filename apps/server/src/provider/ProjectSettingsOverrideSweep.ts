import * as NodeUtil from "node:util";
import { PROJECT_SETTINGS_OVERRIDES_REMOVAL, type ProjectSettingsOverrides } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Settings from "../serverSettings.ts";

export function deletedProjectOverridePatch(entry: ProjectSettingsOverrides | undefined) {
  return entry?.worktreeCleanup !== undefined
    ? { ...PROJECT_SETTINGS_OVERRIDES_REMOVAL, worktreeCleanup: entry.worktreeCleanup }
    : PROJECT_SETTINGS_OVERRIDES_REMOVAL;
}

export const sweep = Effect.gen(function* () {
  const serverSettings = yield* Settings.ServerSettingsService;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* serverSettings.getSettings;
  const projects = yield* projectStore.list({ includeDeleted: true });
  const projectsById = new Map<string, ProjectStore.ProjectRow>(
    projects.map((project) => [project.projectId, project]),
  );
  const overrides = Object.entries(settings.projectSettingsOverrides).flatMap(
    ([projectId, entry]) => {
      const project = projectsById.get(projectId);
      if (project?.deletedAt === null) return [];
      const patch = project
        ? deletedProjectOverridePatch(entry)
        : PROJECT_SETTINGS_OVERRIDES_REMOVAL;
      const desired =
        project && entry.worktreeCleanup !== undefined
          ? { ...PROJECT_SETTINGS_OVERRIDES_REMOVAL, worktreeCleanup: entry.worktreeCleanup }
          : undefined;
      if (NodeUtil.isDeepStrictEqual(entry, desired)) return [];
      return [[projectId, patch] as const];
    },
  );
  if (overrides.length === 0) return;
  yield* serverSettings.updateSettings({ projectSettingsOverrides: Object.fromEntries(overrides) });
}).pipe(
  Effect.asVoid,
  Effect.catchCause((cause) =>
    Effect.logWarning("Failed to sweep orphaned project settings overrides.", cause),
  ),
);
