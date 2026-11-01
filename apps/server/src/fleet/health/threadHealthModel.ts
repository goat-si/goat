import type {
  HostCondition,
  OrchestrationV2ProviderFailureClass,
  OrchestratorMcpThreadPhase,
  RunId,
} from "@goat/contracts";

/**
 * One attempt's health from its goat_thread_status snapshot and its host's conditions, as in
 * docs/internals/agentic-k8s.md "Thread health". Stateless: lastActivityAt moves on every provider
 * event, so no previous read is needed. A pending question or queued run is waiting, never a stall.
 */
const STALL_AFTER_MS = 20 * 60_000;

export type ThreadHealth =
  | { readonly _tag: "waiting" | "unknown" }
  /** idle: no run is active, so drain may move it without interrupting a turn. */
  | { readonly _tag: "healthy"; readonly idle?: boolean }
  | { readonly _tag: "stalled"; readonly idleMs: number }
  | { readonly _tag: "host_lost"; readonly since: string }
  | {
      readonly _tag: "failed";
      readonly failureClass: OrchestrationV2ProviderFailureClass;
      readonly runId: RunId;
    };

/** The goat_thread_status fields health reads; a full status result fits it. */
export interface ThreadStatusSnapshot {
  readonly phase: OrchestratorMcpThreadPhase;
  readonly run: { readonly runId: RunId } | null;
  readonly pendingRequest: unknown;
  readonly queuedRunId: RunId | null;
  readonly lastActivityAt: string;
  readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null | undefined;
}

export function classifyThread(input: {
  readonly status: ThreadStatusSnapshot | null;
  readonly hostConditions: ReadonlyArray<HostCondition>;
  readonly now: number;
  readonly stallAfterMs?: number;
}): ThreadHealth {
  const lost = input.hostConditions.find((condition) => condition.type === "Lost");
  if (lost !== undefined) return { _tag: "host_lost", since: lost.since };
  const status = input.status;
  // Unreachable but not Lost, or never read: nothing to act on yet.
  if (status === null) return { _tag: "unknown" };
  if (status.pendingRequest !== null || status.queuedRunId !== null) return { _tag: "waiting" };
  switch (status.phase) {
    case "waiting_input":
    case "waiting_approval":
    case "waiting":
    case "queued":
      return { _tag: "waiting" };
    case "failed":
      return status.run === null
        ? { _tag: "unknown" }
        : {
            _tag: "failed",
            // A host that predates lastErrorClass reports unknown.
            failureClass: status.lastErrorClass ?? "unknown",
            runId: status.run.runId,
          };
    case "running":
    case "starting": {
      const last = Date.parse(status.lastActivityAt);
      if (!Number.isFinite(last)) return { _tag: "unknown" };
      const idleMs = input.now - last;
      return idleMs >= (input.stallAfterMs ?? STALL_AFTER_MS)
        ? { _tag: "stalled", idleMs }
        : { _tag: "healthy", idle: false };
    }
    default:
      // idle and the terminal phases other than failed: nothing is running.
      return { _tag: "healthy", idle: true };
  }
}
