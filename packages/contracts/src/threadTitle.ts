import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime } from "./baseSchemas.ts";

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export const ThreadTitleRegenerationStatus = Schema.Literals(["renamed", "unchanged", "failed"]);
export type ThreadTitleRegenerationStatus = typeof ThreadTitleRegenerationStatus.Type;

export const ThreadTitleRegenerationOutcome = Schema.Struct({
  status: ThreadTitleRegenerationStatus,
  message: Schema.optional(Schema.String),
});
export type ThreadTitleRegenerationOutcome = typeof ThreadTitleRegenerationOutcome.Type;

export const LastThreadTitleRegeneration = Schema.Struct({
  ...ThreadTitleRegenerationOutcome.fields,
  requestId: CommandId,
  completedAt: IsoDateTime,
});
export type LastThreadTitleRegeneration = typeof LastThreadTitleRegeneration.Type;

/** A thread's last finished regeneration; a client matches requestId to the one it sent. */
export const OrchestrationV2LastTitleRegeneration = Schema.Struct({
  ...ThreadTitleRegenerationOutcome.fields,
  requestId: CommandId,
  completedAt: Schema.DateTimeUtc,
});
export const OrchestrationV2LastTitleRegenerationJson =
  OrchestrationV2LastTitleRegeneration.mapFields((fields) => ({
    ...fields,
    completedAt: Schema.DateTimeUtcFromString,
  }));
