/** How a provider settings change merges into an instance's stored config and environment. */
import type { ProviderInstanceConfig, ProviderUpdateInput } from "@goat/contracts";

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Applies a config patch; a null value removes its key. */
export const mergeConfig = (base: unknown, patch: Readonly<Record<string, unknown>> = {}) => {
  const next: Record<string, unknown> = isRecord(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
};

/** Applies an environment patch by name; a null value removes the variable. */
export const mergeEnvironment = (
  base: ProviderInstanceConfig["environment"],
  patch: ProviderUpdateInput["environment"],
): ProviderInstanceConfig["environment"] => {
  if (patch === undefined) return base;
  const byName = new Map((base ?? []).map((variable) => [variable.name, variable]));
  for (const change of patch) {
    if (change.value === null) {
      byName.delete(change.name);
      continue;
    }
    byName.set(change.name, {
      name: change.name,
      value: change.value,
      sensitive: change.sensitive ?? byName.get(change.name)?.sensitive ?? false,
    });
  }
  return [...byName.values()];
};
