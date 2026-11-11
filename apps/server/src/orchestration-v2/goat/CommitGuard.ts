import type { CommandId, OrchestrationV2StoredEvent, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class CommitGuardRefused extends Schema.TaggedError<CommitGuardRefused>()(
  "CommitGuardRefused",
  { reason: Schema.String },
) {}

export interface CommitGuardInput {
  readonly commandId: CommandId;
  readonly commandType: string;
  readonly threadId: ThreadId;
}

/**
 * Chooses a check for a command dispatched in this fiber. The check runs inside the transaction
 * that commits the command's new events, after projections are applied, so its writes commit or
 * roll back with them. A receipt replay makes no new events and never runs it.
 */
export type CommitGuardSelector = (
  input: CommitGuardInput,
) =>
  | ((
      storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>,
    ) => Effect.Effect<void, CommitGuardRefused>)
  | undefined;

export const CommitGuard = Context.Reference<CommitGuardSelector | undefined>(
  "goat/orchestration-v2/CommitGuard",
  { defaultValue: () => undefined },
);
