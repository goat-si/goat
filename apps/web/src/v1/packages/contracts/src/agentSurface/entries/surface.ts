import { metaSurfaceEntries } from "../surfaceEntries.ts";
import { entry } from "../entry.ts";

export const surfaceEntries = {
  "surface.describe": entry(metaSurfaceEntries.describe),
  "surface.call": entry({
    ...metaSurfaceEntries.call,
    idempotencyReason:
      "Dispatches through the target tool's own authorization and idempotency admission; args.clientRequestId belongs to that target. Caching the dispatcher would bypass target replay checks and freeze call-again flows.",
  }),
  "surface.eval": entry({
    ...metaSurfaceEntries.eval,
    idempotencyReason:
      "The eval journal keys a run by clientRequestId and resumes it step by step; a reservation would answer a resumed run with its first, halted result. Each step keeps its target's own key.",
  }),
} as const;
