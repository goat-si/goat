import { entry } from "../entry.ts";

export const pendingRequestEntries = {
  "pending_request.list": entry({
    resource: "pending_request",
    verb: "list",
    name: "goat_pending_request_list",
    toolkit: "thread",
    summary: "List pending user-input questions.",
    description:
      "List pending user-input questions. Approvals are human-only and excluded, except that an MCP client token with orchestration:approve also gets approvalRequestIds for one thread. Omit threadId for this thread, or pass host and threadId for another machine. scope='launched' shows your launched threads' questions locally and on connected hosts plus hosts[]. Host fan-out caps at 16; unavailableHosts reports skipped aliases and hosts that could not be queried. Results cap at 100; when truncated, answer questions or narrow with host and threadId. Launcher filters are reserved for outside host transport.",
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
      "Read a pending or resolved user question, including status, responder and resolution time when available. A caller with orchestration:approve can also read an approval, returned with approval.kind and approval.prompt. Pass host and threadId for another machine. Answer with goat_pending_request_respond or forward to the user; old remotes may omit status and provenance.",
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
      "Answer a pending user-input question with answers keyed by question id from goat_pending_request_read: a string for single select/free text, or a string array for multiSelect. Include a required reason shown to the user (1–2000 characters, including non-whitespace text). Pass host and threadId for another machine; remote writes need default interaction mode. Approvals are human-only, except for an MCP client token with orchestration:approve, which answers one with decision ('accept' or 'decline') instead of answers. Forward humanRequired questions to the user. respondedBy is reserved for outside host transport; thread callers must omit it.",
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
