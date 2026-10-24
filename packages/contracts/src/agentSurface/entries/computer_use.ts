import { entry } from "../entry.ts";

export const computerUseEntries = {
  "computer_use.request": entry({
    resource: "computer_use",
    verb: "request",
    name: "goat_computer_use_request",
    toolkit: "computerUse",
    summary:
      "Ask a person to admit this thread to apps or the screen of this host until a set time.",
    description:
      "Ask a person to admit this thread to the apps it names, or the whole screen of this host, until an expiry. End this turn after asking. Admission covers the thread’s turns until expiry, rather than approving each action.",
    guide:
      "The tools are cua-driver, reached through GOAT's proxy. A person-directed turn gets them without asking, but may act only on approved apps: a call to another app's window is refused with appNotAllowed, and calls that act on the whole desktop or run scripts with targetRefused; ask with apps set to the bundle_id list_apps reports. Unattended origins include GOAT Bot and channel tasks, scheduled or webhook-triggered work, and threads launched or messaged by unattended threads; such turns need an approved admission before any tool attaches. All attachments still require an enabled and available driver, a supported provider, a non-plan interaction mode and write access. The request returns a needs_human handoff for a person using a GOAT client with orchestration:operate and settings:write; a chat-channel reply cannot grant admission. A person can end admission early, press Stop, stop every thread on the host, or take the screen over: refusals say userStoppedSession or userIntervened, and after any refusal observe again before acting. Only one unattended thread can hold admission on a host at once; a competing request is refused and identifies the holder. The expiry begins when the request is created, so approval does not restart the requested duration.",
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
