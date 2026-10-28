import { DEFAULT_SCREEN_RUN_LIMITS, type ScreenRunLimits as Limits } from "@goat/contracts";

export const screenBytes = (value: string) => Buffer.byteLength(value, "utf8");

/** The most calls one batch group carries (ScreenBatchGroups); the driver allows 64 steps. */
export const MAX_BATCH_CALLS = 16;

// The QuickJS module declares 16 MiB of initial WASM memory.
const MINIMUMS: Partial<Record<keyof Limits, number>> = {
  treeBytes: 512,
  turnWasmBytes: 16 * 1024 * 1024,
};

export function screenRunLimits(requested: Partial<Limits> = {}): Limits {
  const limits = { ...DEFAULT_SCREEN_RUN_LIMITS };
  for (const key of Object.keys(limits) as (keyof Limits)[]) {
    const value = requested[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < (MINIMUMS[key] ?? 1) || value > limits[key]) {
      throw new Error(`Invalid screen limit ${key}`);
    }
    limits[key] = value;
  }
  return limits;
}
