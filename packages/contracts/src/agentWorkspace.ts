import * as Schema from "effect/Schema";
import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProjectEntry, ProjectTextFormat } from "./project.ts";

export const AGENT_TEXT_MAX_BYTES = 32 * 1024;
export const AGENT_RESPONSE_MAX_BYTES = 256 * 1024;
const PageLimit = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(
  Schema.isLessThanOrEqualTo(AGENT_TEXT_MAX_BYTES),
);
export const AgentWorkspaceTarget = {
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
};
export const AgentWorkspaceReadInput = Schema.Struct({
  ...AgentWorkspaceTarget,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  offset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  maxBytes: Schema.optionalKey(PageLimit),
});
export type AgentWorkspaceReadInput = typeof AgentWorkspaceReadInput.Type;
export const AgentWorkspaceReadResult = Schema.Struct({
  path: Schema.String,
  contents: Schema.String,
  byteLength: Schema.Number,
  offset: Schema.Number,
  nextOffset: Schema.Number,
  eof: Schema.Boolean,
  exists: Schema.Boolean,
  textFormat: Schema.optionalKey(ProjectTextFormat),
  version: Schema.optionalKey(Schema.String),
});
export type AgentWorkspaceReadResult = typeof AgentWorkspaceReadResult.Type;
export const AgentWorkspaceListInput = Schema.Struct({
  ...AgentWorkspaceTarget,
  path: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4096))),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(200)),
  ),
  cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(8192))),
});
export type AgentWorkspaceListInput = typeof AgentWorkspaceListInput.Type;
export const AgentWorkspaceListResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  nextCursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
export type AgentWorkspaceListResult = typeof AgentWorkspaceListResult.Type;
export const AgentWorkspaceSearchInput = Schema.Struct({
  ...AgentWorkspaceTarget,
  query: Schema.String.check(Schema.isMaxLength(256)),
  limit: Schema.optionalKey(
    Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).check(Schema.isLessThanOrEqualTo(100)),
  ),
});
export type AgentWorkspaceSearchInput = typeof AgentWorkspaceSearchInput.Type;
export const AgentWorkspaceSearchResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type AgentWorkspaceSearchResult = typeof AgentWorkspaceSearchResult.Type;
export const AgentWorkspaceWriteInput = Schema.Struct({
  ...AgentWorkspaceTarget,
  path: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
  contents: Schema.String.check(Schema.isMaxLength(AGENT_TEXT_MAX_BYTES)),
  expectedVersion: Schema.NullOr(Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))),
  textFormat: Schema.optionalKey(ProjectTextFormat),
});
export type AgentWorkspaceWriteInput = typeof AgentWorkspaceWriteInput.Type;
export const AgentWorkspaceWriteResult = Schema.Struct({
  path: Schema.String,
  version: Schema.String,
});
export type AgentWorkspaceWriteResult = typeof AgentWorkspaceWriteResult.Type;
