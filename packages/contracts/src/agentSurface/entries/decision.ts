import { entry } from "../entry.ts";

export const decisionEntries = {
  "decision.list": entry({
    resource: "decision",
    verb: "list",
    name: "goat_decision_list",
    toolkit: "decision",
    summary:
      "List durable decisions and read-only projections of pending GOAT questions in this environment.",
    description:
      "List durable decisions and read-only projections of pending GOAT questions in this environment. Projected approvals and humanRequired questions remain human-only.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: false },
  }),
  "decision.read": entry({
    resource: "decision",
    verb: "read",
    name: "goat_decision_get",
    toolkit: "decision",
    summary: "Read one durable decision or projected pending question by id.",
    description: "Read one durable decision or projected pending question by id.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: false },
  }),
  "decision.request": entry({
    resource: "decision",
    verb: "request",
    name: "goat_decision_request",
    toolkit: "decision",
    summary:
      "Request a durable decision with distinct option ids, an optional recommendation and expiry, and a required permission profile.",
    description:
      "Request a durable decision with distinct option ids, an optional recommendation and expiry, and a required permission profile. Requires the caller’s profile to allow threads.launch. Returns the decision id and item. Silence never approves.",
    effect: "write",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: false },
  }),
  "decision.answer": entry({
    resource: "decision",
    verb: "answer",
    name: "goat_decision_answer",
    toolkit: "decision",
    summary:
      "Answer an open decision using optionId, or a projected pending question using answers or decision plus reason.",
    description:
      "Answer an open decision using optionId, or a projected pending question using answers or decision plus reason. Requires the effective permission profile named by the item, except provider approvals. A provider approval takes a person in a GOAT client or an MCP client token holding orchestration:approve (under its own runtime ceiling), as with goat_pending_request_respond; other humanRequired items require a person in an authenticated GOAT client.",
    effect: "destructive",
    capability: "none",
    capabilityReason:
      "Checked against the profile the decision names; approvals need a person or an approve-scoped client.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: false },
  }),
} as const;
