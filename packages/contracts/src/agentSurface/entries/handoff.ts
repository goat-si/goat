import { entry } from "../entry.ts";

export const handoffEntries = {
  "handoff.create": entry({
    resource: "handoff",
    verb: "create",
    name: "request_secret",
    toolkit: "orchestrator",
    summary: "Request a secret from the user",
    description:
      "Ask the user for a secret (a token, API key, signing secret, password) through a private card in this thread, and wait for them to answer. With wait:false it returns needs_human (status pending) with the card's handoff at once; call again with the same clientRequestId before this turn ends to collect it. The value is kept by the app and NEVER returned to you or shown in the transcript. When saved, the result carries a secretRef: pass it to a tool that accepts one (e.g. goat_schedule_create's signature.secretRef). It works once. Never ask for secrets in chat, and never invent one.",
    effect: "write",
    capability: "none",
    capabilityReason: "Asks a person for a secret; the person decides.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: ["secret"],
    annotations: {
      title: "Request a secret from the user",
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
