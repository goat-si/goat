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

/** goat_ssh_host_add and goat_connection_add_ssh run one handler that is meant to be called again. */
export const SSH_HOST_ADD_CONVERGES =
  "Converges on one saved host: a repeat preflights again and continues from where the last call stopped, which is how a caller finishes after a person pins the host key or preparation outlives the call.";

/** Memory writes carry the caller's operationId, which the memory store keeps with its digest. */
export const MEMORY_OPERATION_ID =
  "Requires operationId, which the memory store keeps with a digest of the operation: a repeat returns the first receipt, a changed one is refused, and expectedHeads refuses a stale write.";

/** Notes check the revision the caller read. */
export const NOTE_REVISION =
  "Revision-checked: once the first call lands, a repeat with the same baseRevision is refused as a conflict, so it cannot apply twice.";
