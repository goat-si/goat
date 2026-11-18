import { CommandId, ProviderInteractionMode, RuntimeMode, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export class OrchestratorThreadAboveModeLimitError extends Schema.TaggedError<OrchestratorThreadAboveModeLimitError>()(
  "OrchestratorThreadAboveModeLimitError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    mode: Schema.Literals(["runtime", "interaction"]),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} now runs in ${this.runtimeMode}/${this.interactionMode} mode, above what this caller may change.`;
  }
}
