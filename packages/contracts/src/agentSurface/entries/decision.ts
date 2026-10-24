import { entry } from "../entry.ts";

export const decisionEntries = {
  "decision.list": entry({
    resource: "decision",
    verb: "list",
    name: "goat_decision_list",
    toolkit: "decision",
    summary:
      "List local decisions and decisions from threads this environment launched on other hosts.",
    description:
      "List local and launched remote decisions, with unavailableHosts and truncated for partial results. Use host for one destination, or hosts to add discovery targets. Reads expire overdue local decisions.",
    guide:
      "Discovery matches direct launch lineage across this environment, without grandchildren. Remote reach requires live read and operate grants plus threads.remote for each host. Foreign filters and forwarded ceilings are transport-only and never fan out; older hosts require an update. Listing does not answer an item.",
    effect: "read",
    hostRoutable: true,
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
      "Read one durable decision or projected pending question by id, optionally on host. The origin rechecks remote authority and the destination applies its transport grant intersected with the forwarded ceiling.",
    guide:
      "Pass the item id and its from.host when remote. Its from.environmentId identifies the destination; ids alone are not globally unique.",
    effect: "read",
    hostRoutable: true,
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
      "Create a durable decision request and return its item and id. Retry with the same clientRequestId to reuse the result. Silence never approves.",
    guide:
      "The caller's profile must allow threads.launch. Use distinct option ids and name a stored required permission profile. Optionally recommend one of those ids and set a future expiry. An unanswered request stays open until it expires; expiry does not approve it.",
    effect: "write",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotency: "key",
    reconcile: "decision.list",
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
      "Answer an open decision here or on host under independently checked origin and destination authority. The asking host records the answer and retries delivery to its own requesting thread.",
    guide:
      "Pass the row's from.host for a remote decision. Use optionId for a durable decision. For a projected pending question, send answers or decision plus reason; omit optionId.\n\nMeet the effective permission profile requirements named by the item, except for provider approvals. A provider approval requires a person in a GOAT client or an MCP client token holding orchestration:approve under its own runtime ceiling, as with goat_pending_request_respond. Other humanRequired items require a person in an authenticated GOAT client and are refused over transport. Remote approvals require an approve-capable SSH session; linked hosts refuse them. Agents must dominate a locally known required profile, with their effective ceiling forwarded to the destination.",
    effect: "destructive",
    capability: "none",
    capabilityReason:
      "Checked against the profile the decision names; approvals need a person or an approve-scoped client.",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "DecisionInbox.answer atomically changes an open durable decision to answered and queues one delivery keyed by decision id; projected answers use the orchestrator's pending-to-resolved request transition, which rejects another response.",
    annotations: { idempotentHint: false, openWorldHint: false },
  }),
} as const;
