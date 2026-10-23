import { metaSurfaceEntries } from "../surfaceEntries.ts";
import { entry } from "../entry.ts";

export const surfaceEntries = {
  "surface.describe": entry(metaSurfaceEntries.describe),
  "surface.call": entry(metaSurfaceEntries.call),
} as const;
