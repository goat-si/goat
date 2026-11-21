import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PreviewAutomationRemoteDiagnosticFields = {
  remoteTag: TrimmedNonEmptyString,
  remoteMessageLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.Defect(),
};

export const PreviewAutomationOptionalRemoteDiagnosticFields = {
  remoteTag: Schema.optional(TrimmedNonEmptyString),
  remoteMessageLength: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  remoteDetailKind: Schema.optional(
    Schema.Literals(["null", "array", "object", "string", "number", "boolean"]),
  ),
  cause: Schema.optional(Schema.Defect()),
};

const PreviewAutomationSnapshotStage = Schema.Literals([
  "metrics",
  "frames",
  "page state",
  "screenshot",
  "accessibility tree",
]);
export type PreviewAutomationSnapshotStage = typeof PreviewAutomationSnapshotStage.Type;

export const PreviewAutomationSnapshotStages = Schema.Array(PreviewAutomationSnapshotStage).check(
  Schema.isMaxLength(5),
);
