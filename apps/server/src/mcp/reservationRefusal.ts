import { OrchestratorMcpFailure } from "@goat/contracts";
import { type AgentSurfaceEntry, agentSurfaceRegistry } from "@goat/contracts/agentSurface";

import { refusalResult } from "./toolRefusals.ts";

type Refusal =
  | "in_progress"
  | "idempotency_mismatch"
  | "outcome_unknown"
  | "storage_failed"
  | "grant_lost";

const toolNameOf = (path: string) =>
  (agentSurfaceRegistry as Readonly<Record<string, AgentSurfaceEntry>>)[path]?.name ?? path;

/** The answer ToolAdmission gives when a keyed write cannot run or cannot be replayed. */
export const reservationRefusal = (
  reason: Refusal,
  entry: AgentSurfaceEntry & { readonly path: string },
  clientRequestId: string,
  host: string | undefined,
) => {
  const reconcile = entry.reconcile ?? entry.path;
  // A routed write happened on that host, so only the same read there can settle it.
  const where = host === undefined ? "" : ` with host ${host}`;
  const call = `${entry.name} with clientRequestId ${clientRequestId}`;
  switch (reason) {
    case "grant_lost":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: `This caller no longer holds the grant it had when it first sent ${call}, so GOAT does not return that call's result.`,
        }),
      );
    case "outcome_unknown":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "conflict",
          reason,
          mayHaveStarted: true,
          reconcile,
          message: `${call} started, but its outcome was never recorded, so GOAT will not run it again. Read ${toolNameOf(reconcile)}${where} to see whether it happened. ${entry.keyRequired ? "Absence from truncated activity is not proof it was not posted. Never resend with a new key; do not treat a partial review as complete. Tell the user if the outcome cannot be confirmed." : "Only if it did not, call again with a new clientRequestId."}`,
        }),
      );
    case "storage_failed":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          reason,
          message: `GOAT could not record ${call}, so it did not run.`,
        }),
      );
    case "in_progress":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "conflict",
          reason,
          message: `${call} is still running, so this call did not run. Call again with the same arguments for its result once it ends.`,
        }),
      );
    case "idempotency_mismatch":
      return refusalResult(
        new OrchestratorMcpFailure({
          code: "conflict",
          reason,
          message: `clientRequestId ${clientRequestId} was already used for ${entry.name} with other arguments, so this call did not run. Use a new clientRequestId for a different request.`,
        }),
      );
  }
};
