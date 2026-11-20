import * as Schema from "effect/Schema";
import { ThreadId } from "../baseSchemas.ts";

export const OrchestrationV2WorktreeThreadIds = Schema.Struct({
  threadIds: Schema.Array(ThreadId),
  /** Whether GOAT made the worktree; clients offer its removal only when true. Older servers omit it. */
  managed: Schema.optionalKey(Schema.Boolean),
});
