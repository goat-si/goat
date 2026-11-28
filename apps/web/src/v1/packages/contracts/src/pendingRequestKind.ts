import type { OrchestrationV2PendingRuntimeRequestSummary } from "./orchestrationV2.ts";

type PendingRequest = Pick<OrchestrationV2PendingRuntimeRequestSummary, "kind" | "handoff">;

/**
 * A thread shell's pending request that asks a person to approve something: a provider approval
 * or a waiting approval handoff. Handoffs travel as user_input so older clients keep working.
 */
export const isPendingApprovalRequest = (request: PendingRequest | null | undefined): boolean =>
  request != null &&
  (request.handoff === undefined
    ? request.kind !== "user_input" && request.kind !== "auth_refresh"
    : request.handoff.kind === "approval");

/** A pending request that asks a person for input; an approval handoff is not one. */
export const isPendingUserInputRequest = (request: PendingRequest | null | undefined): boolean =>
  request?.kind === "user_input" && request.handoff?.kind !== "approval";
