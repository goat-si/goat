// Seam for v1 apps/web/src/components/settings/SettingInheritance.tsx (goat 916b5ccc1b2): project overrides do not
// exist in GOAT 2 (one environment, no project settings), so nothing is inherited or overridden.
import type { ProjectOverrideEntry } from "./scopedSettings";

export type SettingInheritanceState = "default" | "environment" | "inherited" | "overridden" | "mixed";

export interface SettingOverridingProject extends ProjectOverrideEntry {
  readonly label: string;
  readonly open: () => void;
}

export function SettingInheritance(_props: Record<string, unknown>): null {
  return null;
}
