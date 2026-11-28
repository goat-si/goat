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
      'List local and launched remote decisions, with unavailableHosts and truncated for partial results. Open local items name their asking thread and parent (from.parentThreadId) and say who is asked first (routedTo: parent or person). Use host for one destination, or hosts to add discovery targets. Reads expire overdue local decisions. Example: goat_decision_list {status: "open"}.',
    guide:
      "Discovery matches direct launch lineage across this environment, without grandchildren. Remote reach requires live read and operate grants plus threads.remote for each host. Foreign filters and forwarded ceilings are transport-only and never fan out; older hosts require an update. Listing does not answer an item.\n\nroutedTo: parent means you, the parent named in from.parentThreadId, were woken for it and may answer or escalate it; anything else is the person's.",
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
      'Read one durable decision or projected pending question by id, optionally on host, including its asking thread, parent, routedTo and any escalation. The origin rechecks remote authority and the destination applies its transport grant intersected with the forwarded ceiling. Example: goat_decision_get {id: "decision:3f2a…"}.',
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
      'Create a durable decision request and return its item and id. Retry with the same clientRequestId to reuse the result. Silence never approves. Example: goat_decision_request {title: "Pick a database", context: "Both pass tests", options: [{id: "pg", label: "Postgres", consequence: "Needs a server"}, {id: "sqlite", label: "SQLite", consequence: "One file"}], requiredProfile: "worker"}.',
    guide:
      "The caller's profile must allow threads.launch. Use distinct option ids and name a stored required permission profile. Optionally recommend one of those ids and set a future expiry. An unanswered request stays open until it expires; expiry does not approve it.\n\nWhen a thread here launched or delegated you, that agent is woken and asked first; it answers or hands the decision to the person, and the answer comes back to you as a message.",
    parameters: {
      title: "The decision, as one short question.",
      context: "What the person needs to know to decide.",
      options: "1 to 20 choices: {id, label, consequence}, with distinct ids.",
      recommended: "The id of the option you recommend.",
      requiredProfile: "The stored permission profile whose holder may answer, such as owner.",
      expiresAt: "ISO time when the request closes unanswered. Expiry never approves.",
    },
    examples: [
      {
        title: "Ask whether to merge with a known failing check",
        args: {
          title: "Merge with the flaky e2e check failing?",
          context: "The same e2e test fails on dev; the change itself passes its own tests.",
          options: [
            {
              id: "merge",
              label: "Merge now",
              consequence: "Lands the fix; dev stays red on that test.",
            },
            {
              id: "wait",
              label: "Wait for the e2e fix",
              consequence: "Holds the fix until the test is repaired.",
            },
          ],
          recommended: "merge",
          requiredProfile: "owner",
          clientRequestId: "merge-decision-1",
        },
      },
    ],
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
      'Answer an open decision here or on host under independently checked origin and destination authority. The asking host records the answer and retries delivery to its own requesting thread. Example: goat_decision_answer {id: "decision:3f2a…", optionId: "sqlite", reason: "The task says no new servers"}.',
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
  "decision.escalate": entry({
    resource: "decision",
    verb: "escalate",
    name: "goat_decision_escalate",
    toolkit: "decision",
    summary:
      "Hand an open decision or question from a thread you launched or delegated to the person, with a reason.",
    description:
      'Hand an open decision or question from a thread you launched or delegated to the person when you cannot or should not answer it. Records who escalated, when and why; it reaches the person\'s Decisions inbox right away and stays open until someone answers. Example: goat_decision_escalate {id: "decision:3f2a…", reason: "Needs the user\'s approval to deploy"}.',
    guide:
      "Only the parent named in the item's from.parentThreadId may escalate, and only while the item is open. Use the id from the wake message or goat_decision_list; a child's question has an id like pending:<threadId>:<requestId>. The first escalation is kept; repeating it returns the item unchanged. Escalating never answers or approves anything.",
    effect: "write",
    capability: "none",
    capabilityReason:
      "Restricted to the asking thread's local parent agent; it records a hand-off and grants nothing.",
    hostRoutable: false,
    requires: "thread",
    dryRun: "unsupported",
    humanSteps: [],
    idempotencyReason:
      "The first escalation of an item is stored with its route; later calls find it recorded and change nothing.",
    annotations: { idempotentHint: true, openWorldHint: false },
  }),
} as const;
