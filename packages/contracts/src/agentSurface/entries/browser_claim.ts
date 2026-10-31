import { entry } from "../entry.ts";

export const browserClaimEntries = {
  "browser_claim.request": entry({
    resource: "browser_claim",
    verb: "request",
    name: "goat_browser_claim_request",
    toolkit: "browserClaims",
    summary: "Ask a person to approve one browser tab",
    description:
      "Request access to the active tab in a named browser window for a specified origin. A person decides whether to approve it.",
    effect: "write",
    capability: "none",
    capabilityReason: "Creates only a pending request; a person decides whether to grant access.",
    idempotencyReason: "Each request creates a separate pending approval.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      title: "Request browser tab access",
      idempotentHint: false,
      openWorldHint: false,
    },
  }),
  "browser_claim.list": entry({
    resource: "browser_claim",
    verb: "list",
    name: "goat_browser_claim_list",
    toolkit: "browserClaims",
    summary: "List this thread's browser claims",
    description: "List browser origin grants and attached tab claims for the calling thread.",
    effect: "read",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { title: "List browser tab claims", idempotentHint: true, openWorldHint: false },
  }),
} as const;
