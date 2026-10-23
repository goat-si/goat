import { entry } from "../entry.ts";

export const pendingRequestEntries = {
  "pending_request.list": entry({
    resource: "pending_request",
    verb: "list",
    name: "goat_pending_request_list",
    toolkit: "thread",
    summary: "List pending user-input questions.",
    description:
      "List pending user-input questions for a thread or your launched threads across machines. Reads only. Launched discovery can be partial: check unavailableHosts and truncated. Approvals are excluded unless an outside MCP client token holds orchestration:approve.",
    guide:
      "Omit threadId for this thread. Pass host and threadId for another machine. An approve-scoped MCP client also gets approvalRequestIds when listing one thread.\n\nUse scope='launched' to discover your launched threads' questions locally, on connected hosts, and on hosts[]. Host fan-out caps at 16; unavailableHosts reports skipped aliases and hosts that could not be queried. Launched results cap at 100; if truncated, answer questions or narrow with host and threadId.\n\nLauncher filters are reserved for outside host transport.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "pending_request.read": entry({
    resource: "pending_request",
    verb: "read",
    name: "goat_pending_request_read",
    toolkit: "thread",
    summary:
      "Read a pending or resolved user question, including status, responder and resolution time when available.",
    description:
      "Read a pending or resolved user question, including status, responder, and resolution time when available. Reads only; use goat_pending_request_respond to answer or forward it to the user.",
    guide:
      "Pass host and threadId for another machine. An outside MCP client token holding orchestration:approve can also read an approval's kind. Older remotes may omit status and provenance.",
    effect: "read",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "pending_request.respond": entry({
    resource: "pending_request",
    verb: "respond",
    name: "goat_pending_request_respond",
    toolkit: "thread",
    summary:
      "Answer a pending user-input question with answers and a required reason (1–2000 characters, including non-whitespace text).",
    description:
      "Answer a pending user-input question or, for an approve-scoped outside MCP client, accept or decline an approval. Records the response and reason for the user. Forward humanRequired questions to the user.",
    guide:
      "Use answers keyed by question id from goat_pending_request_read. Send a string for single select or free text, or a string array for multiSelect. Include reason with 1–2000 characters and some non-whitespace text; it is shown to the user.\n\nPass host and threadId for another machine. Remote writes require default interaction mode.\n\nApprovals require a person, except an MCP client token holding orchestration:approve can answer with decision (accept or decline) instead of answers. Do not send both fields.\n\nrespondedBy is reserved for outside host transport. Thread callers must omit it.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: true,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: ["approval"],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
