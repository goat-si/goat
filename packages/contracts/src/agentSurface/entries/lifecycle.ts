import { entry } from "../entry.ts";

const write = {
  toolkit: "threadLifecycle",
  effect: "destructive",
  capability: "threads.launch",
  hostRoutable: false,
  requires: "either",
  dryRun: "unsupported",
  humanSteps: [],
  idempotency: "key",
  annotations: { idempotentHint: false, openWorldHint: true },
} as const;
const read = {
  toolkit: "threadLifecycle",
  effect: "read",
  hostRoutable: false,
  requires: "either",
  dryRun: "unsupported",
  humanSteps: [],
  annotations: { idempotentHint: true, openWorldHint: false },
} as const;
const retry =
  " Calls stay in this environment, including targets in another project. Thread callers need a live orchestration credential; outside clients need orchestration:operate and write access. Targets cannot exceed the caller's permission modes. clientRequestId is optional: only an identical retained key and arguments guarantee deduplication, for at least 24 hours. Without a key there is no retry guarantee. accepted means command acceptance, not provider execution or effect completion. Read the resource's receipt with the same key after an uncertain response; never infer non-execution from a missing receipt, which may have expired.";
const receiptGuide =
  "Read only this caller's retained request in this environment. Thread identity or outside-client session identity must match, and the caller must still hold the recorded grant, including live orchestration:operate authorization. Returns completed with the recorded MCP result/failure, in_progress, unknown, or missing. commandStatus can reconcile a committed command if outcome recording failed; accepted confirms intake only. Reading never redispatches. Missing may mean expired and never proves non-execution.";

export const lifecycleEntries = {
  "queue.resume": entry({
    ...write,
    resource: "queue",
    verb: "resume",
    name: "goat_queue_resume",
    summary: "Resume a held thread queue.",
    description:
      "Resume a held queue using the existing queue rules. Acceptance confirms intake, not execution. Retry an identical retained clientRequestId or read queue.receipt.",
    guide:
      'Omit threadId for the calling thread. Existing ordering, usage-limit, provider-disabled and drain rules apply. Example: goat_call {path: "queue.resume", args: {threadId: "thread:target", clientRequestId: "resume-1"}}.' +
      retry,
    reconcile: "queue.receipt",
    examples: [
      {
        title: "Resume a held queue",
        args: { threadId: "<threadId>", clientRequestId: "resume-1" },
      },
    ],
  }),
  "queued_run.start": entry({
    ...write,
    resource: "queued_run",
    verb: "start",
    name: "goat_queued_run_start",
    summary: "Send a selected queued user message now.",
    description:
      "Start a selected queued user message while stopped. Stale selections are refused. Acceptance is not execution. Read queued_run.receipt after an uncertain response.",
    guide:
      'Pass queuedRunId from queue.list. The run must still be queued and the thread stopped. Existing usage-limit, provider-disabled and drain rules apply. Example: goat_call {path: "queued_run.start", args: {threadId: "thread:target", queuedRunId: "run:queued", clientRequestId: "start-1"}}.' +
      retry,
    reconcile: "queued_run.receipt",
    examples: [
      {
        title: "Start a selected queued user run",
        args: { threadId: "<threadId>", queuedRunId: "<queuedRunId>", clientRequestId: "start-1" },
      },
    ],
  }),
  "thread.delete": entry({
    ...write,
    resource: "thread",
    verb: "delete",
    name: "goat_thread_delete",
    summary: "Irreversibly delete an inactive thread.",
    description:
      "Irreversibly delete an inactive thread. Refuses self, nonterminal runs, active subagents and provider-native children. No restore tool. Read thread.lifecycle_receipt to reconcile.",
    guide:
      'Deletion is irreversible; there is no restore tool. Use thread.organize for reversible archive instead. Refuses the caller\'s own thread, every nonterminal run (including queued/preparing), active background subagents and provider-native read-only children. Existing cleanup applies. Example: goat_call {path: "thread.delete", args: {threadId: "thread:target", clientRequestId: "delete-1"}}.' +
      retry,
    reconcile: "thread.lifecycle_receipt",
    examples: [
      {
        title: "Permanently delete an inactive thread",
        args: { threadId: "<threadId>", clientRequestId: "delete-1" },
      },
    ],
  }),
  "provider_session.detach": entry({
    ...write,
    resource: "provider_session",
    verb: "detach",
    name: "goat_provider_session_detach",
    summary: "Disconnect a target thread's provider session.",
    description:
      "Disconnect an owned provider session on another thread. Refuses the caller's thread. Acceptance precedes disconnect completion. Read provider_session.receipt to reconcile.",
    guide:
      'Pass an explicit providerSessionId belonging to threadId. A live provider session will disconnect, which can affect threads sharing provider-session continuity. The caller cannot detach its own thread. A later send creates or resumes a session according to provider support; there is no reattach tool. Example: goat_call {path: "provider_session.detach", args: {threadId: "thread:target", providerSessionId: "session:target", clientRequestId: "detach-1"}}.' +
      retry,
    reconcile: "provider_session.receipt",
    examples: [
      {
        title: "Disconnect another thread's provider session",
        args: {
          threadId: "<threadId>",
          providerSessionId: "<providerSessionId>",
          clientRequestId: "detach-1",
        },
      },
    ],
  }),
  "queue.receipt": entry({
    ...read,
    resource: "queue",
    verb: "receipt",
    name: "goat_queue_receipt",
    summary: "Read this caller's queue.resume receipt.",
    description:
      "Read a retained queue.resume outcome without running it again. Missing may mean expired, never proof of non-execution.",
    guide: receiptGuide,
    examples: [{ title: "Reconcile queue resumption", args: { clientRequestId: "resume-1" } }],
  }),
  "queued_run.receipt": entry({
    ...read,
    resource: "queued_run",
    verb: "receipt",
    name: "goat_queued_run_receipt",
    summary: "Read this caller's queued_run.start receipt.",
    description:
      "Read a retained queued_run.start outcome without redispatch. Missing may mean expired, never proof of non-execution.",
    guide: receiptGuide,
    examples: [
      { title: "Reconcile a selected queued start", args: { clientRequestId: "start-1" } },
    ],
  }),
  "thread.lifecycle_receipt": entry({
    ...read,
    resource: "thread",
    verb: "lifecycle_receipt",
    name: "goat_thread_lifecycle_receipt",
    summary: "Read this caller's thread.delete receipt, even after deletion.",
    description:
      "Read a retained thread.delete result, including after deletion. Reading does not require the deleted target. Missing may mean expired.",
    guide: receiptGuide,
    examples: [
      {
        title: "Reconcile deletion after the thread disappears",
        args: { clientRequestId: "delete-1" },
      },
    ],
  }),
  "provider_session.receipt": entry({
    ...read,
    resource: "provider_session",
    verb: "receipt",
    name: "goat_provider_session_receipt",
    summary: "Read this caller's provider_session.detach receipt.",
    description:
      "Read a retained provider_session.detach outcome without redispatch. Command acceptance does not confirm disconnect completion.",
    guide: receiptGuide,
    examples: [
      { title: "Reconcile provider session disconnection", args: { clientRequestId: "detach-1" } },
    ],
  }),
} as const;
