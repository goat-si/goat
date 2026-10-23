import { operationSurfaceEntries } from "../operations.ts";
import { entry } from "../entry.ts";

export const operationEntries = {
  "operation.read": entry(operationSurfaceEntries.read),
  "operation.wait": entry(operationSurfaceEntries.wait),
  "operation.cancel": entry(operationSurfaceEntries.cancel),
} as const;
