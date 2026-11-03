import { assignEnvironmentHueSlots } from "@goat/client-runtime/state/environment-hue";

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

export function assignMobileEnvironmentHues(environmentIds: readonly string[], hub: string | null) {
  const slots = assignEnvironmentHueSlots(environmentIds.filter((id) => id !== hub));
  return new Map(
    [...slots].map(([id, slot]) => {
      const tint = HUE_TINTS[slot];
      if (tint === undefined) throw new Error(`Unknown environment hue slot: ${slot}`);
      return [id, tint];
    }),
  );
}
