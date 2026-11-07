import { CommandId, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export class OrchestratorCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestratorCommandPreviouslyRejectedError>()(
  "OrchestratorCommandPreviouslyRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was previously rejected: ${this.detail}`;
  }
}

export class OrchestratorCommandIdConflictError extends Schema.TaggedError<OrchestratorCommandIdConflictError>()(
  "OrchestratorCommandIdConflictError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    receiptThreadId: ThreadId,
    commandThreadId: ThreadId,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was already handled for thread ${this.receiptThreadId} and cannot be replayed for ${this.commandThreadId}.`;
  }
}
/**
 * A command receipt only proves that this exact command already ran for the
 * thread it was recorded against. Replaying it for a command aimed at another
 * thread would report success for work that never happened there, so the
 * dispatcher rejects the reuse instead (mirrors v1's command-id conflict).
 */
export function canReplayCommandReceipt(
  receiptThreadId: ThreadId,
  commandThreadId: ThreadId,
): boolean {
  return receiptThreadId === commandThreadId;
}
