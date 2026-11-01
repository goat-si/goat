import * as Schema from "effect/Schema";
import { AGENT_TEXT_MAX_BYTES } from "./agentWorkspace.ts";

const Handle = Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(16384));
export const AgentTerminalEmptyInput = Schema.Struct({});
export const AgentTerminalHandleInput = Schema.Struct({ handle: Handle });
export type AgentTerminalHandleInput = typeof AgentTerminalHandleInput.Type;
export const AgentTerminalReadInput = Schema.Struct({
  ...AgentTerminalHandleInput.fields,
  cursor: Schema.optionalKey(Handle),
  maxBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
      Schema.isLessThanOrEqualTo(AGENT_TEXT_MAX_BYTES),
    ),
  ),
});
export type AgentTerminalReadInput = typeof AgentTerminalReadInput.Type;
export const AgentTerminalWriteInput = Schema.Struct({
  ...AgentTerminalHandleInput.fields,
  data: Schema.String.check(Schema.isMinLength(1)).check(Schema.isMaxLength(16384)),
});
export type AgentTerminalWriteInput = typeof AgentTerminalWriteInput.Type;
export const AgentTerminalResult = Schema.Struct({
  handle: Handle,
  status: Schema.Literals(["starting", "running", "exited", "error", "closed"]),
  owned: Schema.Boolean,
  pid: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
});
export type AgentTerminalResult = typeof AgentTerminalResult.Type;
export const AgentTerminalListResult = Schema.Struct({
  terminals: Schema.Array(AgentTerminalResult),
  truncated: Schema.Boolean,
});
export type AgentTerminalListResult = typeof AgentTerminalListResult.Type;
export const AgentTerminalReadResult = Schema.Struct({
  data: Schema.String,
  nextCursor: Handle,
  retainedStart: Schema.Number,
  gap: Schema.Boolean,
  status: Schema.Literals(["starting", "running", "exited", "error"]),
  eof: Schema.Boolean,
});
export type AgentTerminalReadResult = typeof AgentTerminalReadResult.Type;
