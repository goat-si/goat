import * as Schema from "effect/Schema";

export const OrchestrationV2ThreadCapabilities = Schema.Struct({
  canCreateEmptyThread: Schema.Boolean,
  canReadThreadSnapshot: Schema.Boolean,
  canRollbackThread: Schema.Boolean,
  canForkThread: Schema.Boolean,
  canForkFromTurn: Schema.Boolean,
  canForkFromSubagentThread: Schema.Boolean,
  exposesNativeThreadId: Schema.Boolean,
  /** Native fork starts the new provider thread in the target thread's cwd. */
  forkHonorsTargetCwd: Schema.optionalKey(Schema.Boolean),
});
