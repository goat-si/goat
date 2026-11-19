import * as M from "@goat/contracts";
import * as Context from "effect/Context";

export const MemoryFloor2Enabled = Context.Reference<boolean>("goat/memory/MemoryFloor2Enabled", {
  defaultValue: () => true,
});

export const memoryFloorAdvertisement = (enabled: boolean) => ({
  features: enabled ? M.MEMORY_FLOOR_2 : (["derivedCap1000", "revisionMarks"] as const),
});
