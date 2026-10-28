import {
  ProjectId,
  ResourceTelemetryHistory,
  ReviewDiffFileContentsInput,
  ReviewDiffPreviewInput,
  ReviewDiffPreviewResult,
  ServerProcessResourceHistoryResult,
  ThreadId,
  UsageSummary,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const { cwd: _previewCwd, ...previewFields } = ReviewDiffPreviewInput.fields;
const { cwd: _fileCwd, ...fileFields } = ReviewDiffFileContentsInput.fields;
const target = {
  projectId: Schema.optionalKey(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
};
export const DiffPreviewInput = Schema.Struct({ ...target, ...previewFields });
export type DiffPreviewInput = typeof DiffPreviewInput.Type;
export const DiffFileInput = Schema.Struct({ ...target, ...fileFields });
export type DiffFileInput = typeof DiffFileInput.Type;
export const UsageResult = Schema.Struct({ ...UsageSummary.fields, truncated: Schema.Boolean });
export const ProcessHistoryResult = Schema.Struct({
  ...ServerProcessResourceHistoryResult.fields,
  truncated: Schema.Boolean,
});
export const ResourceHistoryResult = Schema.Struct({
  ...ResourceTelemetryHistory.fields,
  truncated: Schema.Boolean,
});
export const DiffPreviewResult = Schema.Struct({
  ...ReviewDiffPreviewResult.fields,
  truncated: Schema.Boolean,
});
export const DiffFileResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
  oldTruncated: Schema.Boolean,
  newTruncated: Schema.Boolean,
  truncated: Schema.Boolean,
});
