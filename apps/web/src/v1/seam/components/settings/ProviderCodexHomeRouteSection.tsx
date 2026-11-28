// Seam for v1 apps/web/src/components/settings/ProviderCodexHomeRouteSection.tsx (goat 916b5ccc1b2): OpenCodex Home
// routing is a v1-only service, so the section is not shown. Callback props keep v1's types (:8-20).
import type { ProviderInstanceConfig } from "@goat/contracts";

export function ProviderCodexHomeRouteSection(_props: {
  readonly instance: ProviderInstanceConfig;
  readonly expectedInstance: ProviderInstanceConfig | null;
  readonly canOpenDashboard: boolean;
  readonly onConfigure: (
    instance: ProviderInstanceConfig,
    expectedInstance: ProviderInstanceConfig | null,
  ) => Promise<void>;
  readonly [prop: string]: unknown;
}): null {
  return null;
}
