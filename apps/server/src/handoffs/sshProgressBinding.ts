import { EnvironmentId, SshHostAlias, SshHostResult, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export const SshProgressBinding = Schema.Struct({
  host: SshHostAlias,
  aliasGeneration: Schema.Int,
  operationId: Schema.String,
  completion: Schema.optional(
    Schema.Struct({
      result: SshHostResult,
      aliasRevision: Schema.optional(Schema.String),
    }),
  ),
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type SshProgressBinding = typeof SshProgressBinding.Type;
