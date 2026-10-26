import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const PreviewAutomationScreenshotRegion = Schema.Struct({
  kind: Schema.Literals(["viewport", "document"]),
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

export const PreviewAutomationScreenshot = Schema.Struct({
  mimeType: Schema.Literal("image/png"),
  data: Schema.String,
  width: Schema.Int,
  height: Schema.Int,
  fullPage: Schema.optional(Schema.Boolean),
  clipped: Schema.optional(Schema.Boolean),
  byteLength: Schema.optional(Schema.Int),
  region: Schema.optional(PreviewAutomationScreenshotRegion),
  scale: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});

export const PreviewAutomationClientId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PreviewAutomationClientId = typeof PreviewAutomationClientId.Type;
export const PreviewAutomationConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));
export type PreviewAutomationConnectionId = typeof PreviewAutomationConnectionId.Type;

export const PreviewAutomationScreenExpectation = Schema.Struct({
  browserInstanceId: PreviewAutomationClientId,
  connectionId: PreviewAutomationConnectionId,
  controlGeneration: Schema.Number,
  origin: Schema.NullOr(Schema.String),
});
