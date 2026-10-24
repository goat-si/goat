/**
 * Why a write keeps the key store of its own domain instead of ToolAdmission's reservation
 * (docs/internals/agent-surface.md#idempotency). idempotency.test.ts requires every write to
 * declare a key or one of these reasons.
 */

/** Local orchestration writes: the receipt commits with the command, in one transaction. */
export const ORCHESTRATION_RECEIPT =
  "Deduplicates clientRequestId as a stable orchestration command id, whose receipt commits in the same transaction as the command and outlives a 24-hour reservation.";

/** Host-routable orchestration writes forward the key, so the machine that runs them dedupes. */
export const ROUTED_ORCHESTRATION_RECEIPT = `${ORCHESTRATION_RECEIPT} A call with host forwards the key, so that machine's receipts deduplicate it where it runs.`;
