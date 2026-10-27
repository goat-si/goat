import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewAutomationScope } from "./previewAutomationSnapshot.ts";

const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const PreviewAutomationReadInput = Schema.Struct({
  tabId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  scope: Schema.optional(PreviewAutomationScope),
  format: Schema.optional(Schema.Literals(["markdown", "text"])),
  offset: Schema.optional(nonnegative),
  revision: Schema.optional(TrimmedNonEmptyString),
  maxChars: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 }))),
  maxBytes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 48_000 })),
  ),
  settleMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 5_000 }))),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 30_000 }))),
});
export type PreviewAutomationReadInput = typeof PreviewAutomationReadInput.Type;

export const PreviewAutomationRead = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  urlTruncated: Schema.Boolean,
  titleTruncated: Schema.Boolean,
  format: Schema.Literals(["markdown", "text"]),
  text: Schema.String,
  offset: nonnegative,
  totalChars: nonnegative,
  nextOffset: Schema.NullOr(nonnegative),
  revision: Schema.String,
  changed: Schema.Boolean,
  settled: Schema.Boolean,
  network: Schema.Literals(["idle", "busy", "unknown"]),
  pendingRequests: nonnegative,
  pending: Schema.Struct({
    network: nonnegative,
    domChanging: Schema.Boolean,
    loading: Schema.Boolean,
  }),
  collapsedCount: nonnegative,
  scopeFound: Schema.Boolean,
  omittedFrames: nonnegative,
  truncatedRender: Schema.Boolean,
  next: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type PreviewAutomationRead = typeof PreviewAutomationRead.Type;

export const PreviewAutomationReadFailure = Schema.Literals([
  "scope_not_found",
  "scope_ambiguous",
  "stale_ref",
  "revision_required",
  "pageChanged",
  "output_limit",
]);
export class PreviewAutomationReadError extends Schema.TaggedError<PreviewAutomationReadError>()(
  "PreviewAutomationReadError",
  { reason: PreviewAutomationReadFailure },
) {
  override get message() {
    return `Page read refused: ${this.reason}.`;
  }
}
