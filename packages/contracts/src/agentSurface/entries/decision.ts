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
      "List durable decisions and projections of pending GOAT questions in this environment. The read also expires overdue durable decisions.",
    guide:
      "Projected approvals require a person in a GOAT client or an outside MCP client token holding orchestration:approve. Other humanRequired questions require a person in an authenticated GOAT client. Listing a projection does not answer it.",
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
    description:
      "Read one durable decision or projected pending question by id. The read also expires overdue durable decisions.",
    guide: "Pass the decision or projected question id.",
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
      "Create a durable decision request and return its item and id. Each call creates a new request; check goat_decision_list before retrying after an uncertain result. Silence never approves.",
    guide:
      "Use distinct option ids and name a stored required permission profile. Optionally recommend one of those ids and set a future expiry. An unanswered request stays open until it expires; expiry does not approve it.",
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
      "Answer an open durable decision or projected pending question. The answer is recorded first; notifying the requesting thread can lag and is retried, and a request from an outside client has no thread to notify.",
    guide:
      "Use optionId for a durable decision. For a projected pending question, send answers or decision plus reason; omit optionId.\n\nMeet the effective permission profile requirements named by the item, except for provider approvals. A provider approval requires a person in a GOAT client or an MCP client token holding orchestration:approve under its own runtime ceiling, as with goat_pending_request_respond. Other humanRequired items require a person in an authenticated GOAT client.",
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
