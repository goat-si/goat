import * as Schema from "effect/Schema";
import { CommandId, ThreadId, TurnItemId } from "./baseSchemas.ts";
import { HandoffActor, HandoffState } from "./handoff.ts";

export const HandoffTransitionCommand = Schema.Struct({
  type: Schema.Literal("handoff.transition"),
  commandId: CommandId,
  threadId: ThreadId,
  handoffId: TurnItemId,
  state: HandoffState,
  actor: HandoffActor,
  computerUseScope: Schema.optionalKey(Schema.Literals(["session", "always"])),
  resultMessage: Schema.optionalKey(Schema.String),
  browserClaimDecisionAt: Schema.optionalKey(Schema.DateTimeUtc),
});
