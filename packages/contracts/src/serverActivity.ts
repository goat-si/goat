import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * One thread that keeps a server busy for runtime updates and drains, from the same predicate
 * every update path uses. `background` is provider work that outlived its turn, such as a native
 * subagent; `waiting` is a live turn waiting on a person or runtime request.
 */
export const ServerActivityBlocker = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  title: Schema.NullOr(Schema.String),
  reason: Schema.Literals(["running", "waiting", "queued", "background"]),
  since: IsoDateTime,
});
export type ServerActivityBlocker = typeof ServerActivityBlocker.Type;
