import { Handoff, HandoffError, TurnItemId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export const decodeAddress = Schema.decodeUnknownEffect(
  Schema.Struct({ threadId: Handoff.fields.requestedBy.fields.threadId, handoffId: TurnItemId }),
);
export const unavailable = (cause: unknown) => new HandoffError({ reason: "unavailable", cause });
