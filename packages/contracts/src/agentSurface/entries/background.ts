import { entry } from "../entry.ts";

export const backgroundEntries = {
  "background.wait": entry({
    resource: "background",
    verb: "wait",
    name: "goat_background_wait",
    toolkit: "orchestrator",
    summary: "Wait on background work",
    description:
      "Keep this thread in Working while background work runs. Pass its task ID after starting it. Not for work left running (dev server, watcher). waiting=false clears. Does not stop the task. Claude only.",
    guide:
      "Use after starting a background command, Monitor, or subagent this turn waits on, such as tests or a build. The thread shows Working until the task finishes or waiting=false clears it, and the result wakes this thread. Unknown task IDs come back in unmatched.",
    idempotencyReason:
      "Sets the awaited flag on the named background tasks of the caller's own thread; repeating the same call leaves the same flags.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Changes only the waiting state of the calling thread's own background tasks.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Wait on background work",
      idempotentHint: true,
      openWorldHint: false,
    },
  }),
} as const;
