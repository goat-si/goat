import type { AgentSurfaceEntry, CapabilityDeclaration } from "./types.ts";

/** The operation verbs, kept beside the registry like notes.ts. */
export const operationSurfaceEntries = {
  read: {
    resource: "operation",
    verb: "read",
    name: "goat_operation_read",
    toolkit: "agentSurface",
    summary: "Read the state of long-running work by its operationId",
    description:
      "Read long-running work using its goat_call operation handle. An unknown state means GOAT cannot determine the outcome; inspect the result before deciding whether to retry the original work.",
    guide:
      "The operationId comes from meta.operation. GOAT verifies the handle, then reads the work through its status tool with that tool’s own checks, or reads its handoff and continuation. The response contains the operation and the underlying answer as a goat_call envelope. States are queued, running, waiting_human, succeeded, failed, cancelled and unknown. An expired handle exceeds its kind’s retention period; read the work directly instead. Handles are bound to the issuing environment and receiving thread, or to the client session when no thread is present. Another principal gets not_found and must find or start the work again; changing a client session invalidates a client-bound handle, while another turn in the same thread keeps the same principal.",
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
    description:
      "Wait for long-running work through its goat_call operation handle and return the latest observation. A timeout never cancels the work; it may still be running. The wait also returns immediately when GOAT cannot determine the outcome.",
    guide:
      "GOAT verifies the handle once, then repeats the same reads as goat_operation_read at the kind’s pollAfterMs interval. timeoutMs defaults to 60000 and cannot exceed 300000. Terminal states and unknown return early. timedOut:true means the deadline won; the work may still be running. If the first read itself times out, the response has an unknown operation and no result. Handles are bound to the issuing environment and receiving thread, or to the client session when no thread is present. Another principal gets not_found and must find or start the work again; changing a client session invalidates a client-bound handle, while another turn in the same thread keeps the same principal.",
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
    description:
      "Request cancellation through the work’s own cancel tool. Cancellation is cooperative; use goat_operation_read afterwards to confirm the final state.",
    guide:
      "The response contains a fresh operation state and the cancel tool’s answer as result. GOAT verifies the handle and uses the underlying tool’s own checks. Work without a cancel path, including SSH setup and handoff-only operations, returns not_cancellable. Provider-sync approval that has not produced a sync to cancel also returns not_cancellable. Handles are bound to the issuing environment and receiving thread, or to the client session when no thread is present. Another principal gets not_found and must find or start the work again; changing a client session invalidates a client-bound handle, while another turn in the same thread keeps the same principal.",
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
