import { entry } from "../entry.ts";

export const computerUseEntries = {
  "computer_use.request": entry({
    resource: "computer_use",
    verb: "request",
    name: "goat_computer_use_request",
    toolkit: "computerUse",
    summary: "Ask a person to admit this thread to computer use on this host until a set time.",
    description:
      "Ask a person to admit this thread to see and control this host’s screen until an expiry. End this turn after asking; approved tools attach on the next eligible turn. Admission covers the thread’s turns until expiry, rather than approving each action.",
    guide:
      "The tools are cua-driver. Unattended origins include GOAT Bot and channel tasks, scheduled or webhook-triggered work, and threads launched or messaged by unattended threads. Such turns need an approved admission; a person-directed turn can attach the driver directly. All attachments still require an enabled and available driver, a supported provider, a non-plan interaction mode and write access. The request returns a needs_human handoff for a person using a GOAT client with orchestration:operate and settings:write; a chat-channel reply cannot grant admission. The person can end admission early. Only one unattended thread can hold admission on a host at once; a competing request is refused and identifies the holder. The expiry begins when the request is created, so approval does not restart the requested duration.",
    effect: "write",
    capability: "none",
    capabilityReason: "Asks a person, who decides whether to admit the thread.",
    idempotencyReason:
      "Pending requests with the same purpose and duration reuse this thread’s existing computer-use handoff; an admitted thread returns its existing admission.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
} as const;
