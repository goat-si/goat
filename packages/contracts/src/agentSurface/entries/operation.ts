import { operationSurfaceEntries } from "../operations.ts";
import { entry } from "../entry.ts";

export const operationEntries = {
  "operation.read": entry(operationSurfaceEntries.read),
  "operation.wait": entry(operationSurfaceEntries.wait),
  "operation.cancel": entry({
    ...operationSurfaceEntries.cancel,
    idempotencyReason:
      "Operation.cancel verifies its stable handle and delegates to task.cancel or provider.sync_cancel for the same native task/sync id, then rereads current state. Cancellation is cooperative; repeats must observe current work rather than replay a stale cancellation result.",
  }),
} as const;
