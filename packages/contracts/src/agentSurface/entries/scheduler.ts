import { entry } from "../entry.ts";

export const schedulerEntries = {
  "scheduler.status": entry({
    resource: "scheduler",
    verb: "status",
    name: "goat_scheduler_status",
    toolkit: "fleetResources",
    summary:
      "Read fleet placement status: per host counts, limits, quota windows and why goal work would be refused, plus fallback cooldowns and recent placement decisions.",
    description:
      "Read fleet placement status from settings fleet.*: per host running and queued threads, maxThreads and allowGoals, quota per provider instance with exhausted windows and reset times, and the reason goal work would be refused there now (caps bind goal work only, never a person's own launch). Also lists fallback steps cooling down after a failure and the last placement decisions with reasons. Pass local:true for this machine only; reading other machines needs a caller allowed to use this machine's SSH keys.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
