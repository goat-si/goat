import { DEFAULT_SCREEN_RUN_LIMITS, type ScreenRunLimits as Limits } from "@goat/contracts";

export const screenBytes = (value: string) => Buffer.byteLength(value, "utf8");

export function screenRunLimits(requested: Partial<Limits> = {}): Limits {
  const limits = { ...DEFAULT_SCREEN_RUN_LIMITS };
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    const value = requested[key];
    if (value === undefined) continue;
    if (
      !Number.isSafeInteger(value) ||
      value < (key === "treeBytes" ? 512 : 1) ||
      value > limits[key]
    ) {
      throw new Error(`Invalid screen limit ${key}`);
    }
    limits[key] = value;
  }
  return limits;
}
