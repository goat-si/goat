import * as Schema from "effect/Schema";

import { SecretRef, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

export const PreviewAutomationFillSecretInput = Schema.Struct({
  tabId: Schema.optional(PreviewTabId),
  secretRef: SecretRef.annotate({
    description: "From request_secret with origin set to this page's origin.",
  }),
  selector: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2048))).annotate({
    description:
      "CSS selector matching exactly one password input in the page (open shadow roots included). Omit to fill the password field that has focus, including one inside a frame.",
  }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isGreaterThan(0)).check(Schema.isLessThanOrEqualTo(60_000)),
  ).annotate({ description: "Default 15000." }),
});
export type PreviewAutomationFillSecretInput = typeof PreviewAutomationFillSecretInput.Type;

export const PreviewAutomationFillSecretResult = Schema.Struct({
  filled: Schema.Literal(true),
  origin: Schema.String,
  privateMode: Schema.Boolean.annotate({
    description: "A secret field still has focus, so the tab stays private until it loses focus.",
  }),
});
export type PreviewAutomationFillSecretResult = typeof PreviewAutomationFillSecretResult.Type;
