import type { AgentSurfaceEntry, CapabilityDeclaration } from "./types.ts";

const HANDLE =
  "A handle belongs to the thread or client session that received it: another caller, or this caller after its session changed, gets not_found and must start or find the work again.";

/** The operation verbs, kept beside the registry like notes.ts. */
export const operationSurfaceEntries = {
  read: {
    resource: "operation",
    verb: "read",
    name: "goat_operation_read",
    toolkit: "agentSurface",
    summary: "Read the state of long-running work by its operationId",
    description: `Read long-running work by the operationId a goat_call result gave in meta.operation. Runs the status tool of the work it names, with that tool's own checks, and returns operation (state queued, running, waiting_human, succeeded, failed, cancelled or unknown) and result, that tool's answer as a goat_call envelope. unknown means GOAT issued the handle but cannot tell what became of the work; result says why. An expired handle is older than its kind keeps records. ${HANDLE}`,
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  wait: {
    resource: "operation",
    verb: "wait",
    name: "goat_operation_wait",
    toolkit: "agentSurface",
    summary: "Wait for long-running work to finish, up to a deadline",
    description: `Like goat_operation_read, but waits up to timeoutMs (default 60000, at most 300000) for the work to finish, reading it again every pollAfterMs. Returns the last read; timedOut true means the deadline came first and the work may still be running. Waiting never cancels the work. ${HANDLE}`,
    effect: "read",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: true, openWorldHint: true },
  },
  cancel: {
    resource: "operation",
    verb: "cancel",
    name: "goat_operation_cancel",
    toolkit: "agentSurface",
    summary: "Cancel long-running work through its own cancel tool",
    description: `Cancel the work an operationId names through that work's own cancel tool, with that tool's checks; result is its answer. Cancel is cooperative, so read the operation afterwards for its final state. Work without a cancel path, such as SSH setup, fails with not_cancellable. ${HANDLE}`,
    effect: "destructive",
    capability: "none",
    capabilityReason:
      "Runs the operation kind's own cancel tool, which checks its capability for this caller.",
    hostRoutable: false,
    requires: "either",
    dryRun: "unsupported",
    humanSteps: [],
    annotations: { idempotentHint: false, openWorldHint: true },
  },
} as const satisfies Record<string, AgentSurfaceEntry & CapabilityDeclaration>;
