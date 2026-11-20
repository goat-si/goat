import { CheckpointId, ProviderThreadId, ThreadId } from "@goat/contracts";
import { assert, it } from "@effect/vitest";
import { SHARED_WORKSPACE_RESTORE_MESSAGE } from "./CheckpointRestoreSafety.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";

it("maps shared-workspace rollback failures to the specific client message without exposing other reasons", () => {
  const makeError = (
    reason:
      | "shared-workspace"
      | "rollback-target-invalid"
      | "active-provider-changed"
      | "provider-turn-unavailable"
      | "unexpected-failure",
  ) =>
    new CheckpointRollbackService.CheckpointRollbackExecutionError({
      reason,
      threadId: ThreadId.make("thread:private"),
      providerThreadId: ProviderThreadId.make("provider:private"),
      checkpointId: CheckpointId.make("checkpoint:private"),
    });
  assert.equal(
    CheckpointRollbackService.rollbackFailureClientMessage(makeError("shared-workspace")),
    SHARED_WORKSPACE_RESTORE_MESSAGE,
  );
  for (const reason of [
    "rollback-target-invalid",
    "active-provider-changed",
    "provider-turn-unavailable",
    "unexpected-failure",
  ] as const) {
    assert.equal(
      CheckpointRollbackService.rollbackFailureClientMessage(makeError(reason)),
      CheckpointRollbackService.ROLLBACK_FAILED_MESSAGE,
    );
  }
});
