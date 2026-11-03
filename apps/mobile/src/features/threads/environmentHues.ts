import { assignEnvironmentHueSlots } from "@goat/client-runtime/state/environment-hue";
import type { EnvironmentId } from "@goat/contracts";
import { splitEnvironmentSections } from "../connection/environmentSections";
import { selectHubEnvironmentId } from "../connection/connectHubIntent";

const HUE_TINTS = [
  "accent-orange-500",
  "accent-emerald-500",
  "accent-violet-500",
  "accent-pink-500",
  "accent-amber-500",
  "accent-teal-500",
  "accent-lime-600",
  "accent-rose-500",
] as const;

export function mobileEnvironmentHueKey(
  environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly isRelayManaged: boolean;
  }[],
  storedHubId: EnvironmentId | null,
): string {
  const { localEnvironments } = splitEnvironmentSections({
    connectedEnvironments: environments,
    cloudEnvironments: null,
  });
  const hub = selectHubEnvironmentId(localEnvironments, storedHubId);
  return JSON.stringify([environments.map((environment) => environment.environmentId).sort(), hub]);
}

export function mobileEnvironmentHuesFromKey(key: string) {
  const [environmentIds, hub] = JSON.parse(key) as [string[], string | null];
  const slots = assignEnvironmentHueSlots(environmentIds.filter((id) => id !== hub));
  return new Map(
    [...slots].map(([id, slot]) => {
      const tint = HUE_TINTS[slot];
      if (tint === undefined) throw new Error(`Unknown environment hue slot: ${slot}`);
      return [id, tint];
    }),
  );
}

export function assignMobileEnvironmentHues(
  environments: readonly {
    readonly environmentId: EnvironmentId;
    readonly isRelayManaged: boolean;
  }[],
  storedHubId: EnvironmentId | null,
) {
  return mobileEnvironmentHuesFromKey(mobileEnvironmentHueKey(environments, storedHubId));
}
