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
      "Read fleet placement status: host thread counts and limits, provider quota summaries, reasons goal work would be refused, fallback cooldowns and recent placement decisions. Fleet caps apply to goal work; they do not limit a person's own launch.",
    guide:
      "Status uses settings fleet.*. Each host reports running and queued threads, maxThreads and allowGoals. Quotas identify the provider instance, busiest usage percentage, exhaustion and reset time. Placement decisions include reasons; fallback cooldowns show steps cooling down after failures.\n\nPass local:true to read only this machine. Reading other machines needs a caller allowed to use this machine's SSH keys.",
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
