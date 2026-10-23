import { entry } from "../entry.ts";

export const computerUseEntries = {
  "computer_use.request": entry({
    resource: "computer_use",
    verb: "request",
    name: "goat_computer_use_request",
    toolkit: "computerUse",
    summary: "Ask a person to admit this thread to computer use on this host until a set time.",
    description:
      "Ask a person to admit this thread to computer use (the cua-driver tools that see and control this host's screen) until a set time. Threads started by GOAT Bot, Slack or iMessage, scheduled or webhook tasks, or launched by them, get cua-driver only after this approval; threads a person runs directly already have it when computer use is on. Returns needs_human with a handoff: a person allowed to change this environment's settings approves it in a GOAT app, never by replying in a chat channel. Approval is admission for this thread's turns until the stated expiry, not approval of each action; the person can end it early. Your next turn after approval has the cua-driver tools; end this turn after asking. Only one unattended thread per host holds computer use at a time; a second request is refused with the holder's thread id.",
    effect: "write",
    capability: "none",
    capabilityReason: "Asks a person, who decides whether to admit the thread.",
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
