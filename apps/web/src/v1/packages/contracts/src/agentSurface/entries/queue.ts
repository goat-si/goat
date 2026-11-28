import { entry } from "../entry.ts";

export const queueEntries = {
  "queue.list": entry({
    resource: "queue",
    verb: "list",
    name: "goat_queue_list",
    toolkit: "thread",
    summary: "List queued messages in delivery order.",
    description:
      "List queued messages in delivery order. Reads a live offset page; queue changes can shift later pages.",
    guide: "Use goat_thread_read for full thread history.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "queue.read": entry({
    resource: "queue",
    verb: "read",
    name: "goat_queue_read",
    toolkit: "thread",
    summary: "Read up to 16,000 characters of a queued message.",
    description:
      "Read up to 16,000 characters of a queued message without changing it; check truncated.",
    guide: "Returns up to 16,000 characters. Omit threadId to read from this thread.",
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "queue.edit": entry({
    resource: "queue",
    verb: "edit",
    name: "goat_queue_edit",
    toolkit: "thread",
    summary: "Replace a queued message's text, preserving its attachments.",
    description: "Replace a queued message's text while preserving its attachments.",
    guide: "The service rejects runs that are no longer queued.",
    idempotencyReason:
      "queued-run.edit replaces text on the specified queued run while preserving its attachments; it does not append a message and rejects a run that has left the queue.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "queue.cancel": entry({
    resource: "queue",
    verb: "cancel",
    name: "goat_queue_cancel",
    toolkit: "thread",
    summary: "Cancel a queued run using the existing queue command.",
    description:
      "Cancel a queued run. Cancelling a delegated-completion message also drops the pending automatic result deliveries of its cohort.",
    guide:
      "The run must still be queued.\n\nCancellation uses the existing queue command. A delegated-completion message belongs to its parent run's completion cohort; cancelling it disposes every task completion delivery that cohort still owes, so later automatic parent wakes for those tasks do not come.",
    idempotencyReason:
      "queued-run.cancel only accepts the specified run while queued, then cancels it and disposes its completion cohort. A repeat after cancellation is refused before further cancellation effects.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "queue.reorder": entry({
    resource: "queue",
    verb: "reorder",
    name: "goat_queue_reorder",
    toolkit: "thread",
    summary: "Move a queued run before another queued run, or to the end with beforeRunId=null.",
    description:
      "Move a queued run before another queued run, or to the end with beforeRunId=null.",
    guide:
      "Pass the queued run id and beforeRunId. Both runs must still be queued when beforeRunId is non-null.",
    idempotencyReason:
      "queued-run.reorder removes the specified run from the order then inserts it before the same target (or at the end), emitting updates only for changed positions; repeating yields the same order.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
  "queue.promote_to_steer": entry({
    resource: "queue",
    verb: "promote_to_steer",
    name: "goat_queue_promote_to_steer",
    toolkit: "thread",
    summary: "Deliver a queued message as steering to the specified active run.",
    description:
      "Deliver a queued message as steering to the specified active run. Cancels the queued run when promoting its message.",
    guide: "Existing provider and run-state rules apply.",
    idempotencyReason:
      "queued-message.promote-to-steer only accepts a queued run and cancels that run when its message is delivered as steering. The same queuedRunId cannot be promoted again once cancelled.",
    effect: "destructive",
    capability: "threads.launch",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: {
      idempotentHint: false,
      openWorldHint: true,
    },
  }),
} as const;
