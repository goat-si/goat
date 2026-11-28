// Seam for v1 apps/web/src/components/settings/scopedSettings.ts (goat 916b5ccc1b2): GOAT 2 has no project-scoped
// settings, so no key is project scoped, nothing is mixed and every value comes from the environment. Types keep
// v1's shapes (scopedSettings.ts:33-43, 84-91, 166, 382-385).
import type { EnvironmentId, ProjectId, ServerSettings } from "@goat/contracts";
import type { EnvironmentConnectionPhase } from "@goat/client-runtime/connection";

export type ProjectSettingSource = "environment" | "project" | "t3.json";
export type ScopedSettingSource = ProjectSettingSource | "mixed";

export interface ScopedSettingsEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly connection: { readonly phase: EnvironmentConnectionPhase };
  readonly serverConfig: {
    readonly settings: ServerSettings;
    readonly environment?: {
      readonly capabilities: { readonly projectSettingsOverrides?: boolean | undefined };
    };
  } | null;
}

export interface ScopedSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly projectId: ProjectId | null;
  readonly projectFileName?: string;
  readonly settings: ServerSettings;
  readonly sources: Readonly<Record<string, ProjectSettingSource>>;
}

export interface ProjectOverrideEntry {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function isProjectScopedSettingKey(_key: string): false {
  return false;
}

export function scopedSettingsAreMixed(
  _targets: readonly Pick<ScopedSettingsTarget, "settings">[],
  _keys: readonly (keyof ServerSettings)[],
): boolean {
  return false;
}

export function scopedSettingsSource(
  _targets: readonly Pick<ScopedSettingsTarget, "sources">[],
  _keys: readonly (keyof ServerSettings)[],
): ScopedSettingSource {
  return "environment";
}

export function listProjectOverrides(
  _environments: readonly ScopedSettingsEnvironment[],
  _keys: readonly (keyof ServerSettings)[],
): readonly ProjectOverrideEntry[] {
  return [];
}
