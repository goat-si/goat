// Seam for v1 apps/web/src/components/settings/SettingsScopeContext.tsx (goat 916b5ccc1b2): GOAT 2 renders settings for
// its one environment without v1's scope picker, so no scope provider is mounted and useOptionalSettingsScope() is
// null, the case v1's settingsLayout already handles. The value type keeps the fields v1 readers use.
import type { EnvironmentId, ProjectId } from "@goat/contracts";

import type { EnvironmentPresentation } from "../../state/environments";
import type { ScopedSettingsEnvironment, ScopedSettingsTarget } from "./scopedSettings";

export interface SettingsScopeSearch {
  project?: string | undefined;
  machine?: string | undefined;
  checkout?: string | undefined;
}

export interface SettingsScopeValue {
  readonly scope: {
    readonly kind: "all" | "environment" | "project" | "checkout" | "unavailable";
    readonly label: string;
    readonly environmentIds: readonly EnvironmentId[];
  };
  readonly search: SettingsScopeSearch;
  readonly groups: ReadonlyArray<{
    readonly projectKey: string;
    readonly displayName: string;
    readonly memberProjects: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>;
  }>;
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
  readonly environment: EnvironmentPresentation | null;
  readonly connectedEnvironments: ReadonlyArray<ScopedSettingsEnvironment>;
  readonly targets: ReadonlyArray<ScopedSettingsTarget>;
  readonly target: ScopedSettingsTarget | null;
  readonly singleEnvironment: boolean;
  readonly deviceOnly: boolean;
  readonly selectScope: (next: SettingsScopeSearch) => void;
}

export function useOptionalSettingsScope(): SettingsScopeValue | null {
  return null;
}
