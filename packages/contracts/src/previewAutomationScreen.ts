import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Leaf of previewAutomation.ts: importing it back would recreate the module-init cycle, so the
// id checks below repeat PreviewAutomationClientId and PreviewAutomationConnectionId.
const ScreenshotRegion = Schema.Struct({
  kind: Schema.Literals(["viewport", "document"]),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

export const ScreenshotPlacementFields = {
  region: Schema.optional(ScreenshotRegion),
  scale: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
};

export const PreviewAutomationScreenExpectation = Schema.Struct({
  browserInstanceId: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  connectionId: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  controlGeneration: Schema.Number,
  origin: Schema.NullOr(Schema.String),
});
