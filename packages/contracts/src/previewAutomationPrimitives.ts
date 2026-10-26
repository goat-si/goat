import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { PreviewTabId } from "./preview.ts";

const BoundedUrl = Schema.String.check(Schema.isTrimmed())
  .check(Schema.isNonEmpty())
  .check(Schema.isMaxLength(2048));

const OptionalTimeoutMs = Schema.optional(
  Schema.Int.check(Schema.isGreaterThan(0))
    .check(Schema.isLessThanOrEqualTo(60_000))
    .annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." }),
).annotate({ description: "Maximum wait in milliseconds. Defaults to 15000; maximum 60000." });

const PreviewAutomationTabTargetFields = {
  tabId: Schema.optional(
    PreviewTabId.annotate({
      description:
        "Exact collaborative browser tab to target, including a tab the user opened (see goat_preview_status tabs). Omit to use this agent session's current tab, or the user's visible tab when this session has none.",
    }),
  ).annotate({
    description:
      "Exact collaborative browser tab to target, including a tab the user opened (see goat_preview_status tabs). Omit to use this agent session's current tab, or the user's visible tab when this session has none.",
  }),
};

export const PreviewAutomationFetchInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: BoundedUrl.annotate({
    description:
      "HTTP(S) URL or path relative to the active tab's URL, fetched inside the tab with same-origin credentials.",
  }),
  format: Schema.optional(
    Schema.Literals(["markdown", "text"]).annotate({
      description: "Output format for HTML bodies: markdown (default) or text.",
    }),
  ),
  maxChars: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100_000 })).annotate({
      description: "Maximum characters of text to return. Defaults to 20000; maximum 100000.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
}).annotate({
  description:
    "Fetches an HTTP(S) URL inside the browser tab using its same-origin session and returns bounded, credential-redacted Markdown or text without navigating the tab.",
});
export type PreviewAutomationFetchInput = typeof PreviewAutomationFetchInput.Type;

export const PreviewAutomationFetchResult = Schema.Struct({
  url: Schema.String,
  status: Schema.Int,
  ok: Schema.Boolean,
  contentType: Schema.String,
  format: Schema.Literals(["markdown", "text", "raw"]),
  text: Schema.String,
  truncated: Schema.Boolean,
});
export type PreviewAutomationFetchResult = typeof PreviewAutomationFetchResult.Type;

export const PreviewAutomationScrollCollectInput = Schema.Struct({
  ...PreviewAutomationTabTargetFields,
  url: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
      description:
        "Substring that matching response URLs must contain, for example /api/items. Omit to match any JSON response URL.",
    }),
  ),
  minItems: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_000 })).annotate({
      description: "Stop once at least this many items are collected.",
    }),
  ),
  maxItems: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5_000 })).annotate({
      description: "Maximum items to return. Defaults to 1000; maximum 5000.",
    }),
  ),
  maxScrolls: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })).annotate({
      description: "Maximum wheel scrolls to perform. Defaults to 10; maximum 50.",
    }),
  ),
  settleMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 })).annotate({
      description:
        "Maximum wait in milliseconds for a matching response after each scroll. Defaults to 800.",
    }),
  ),
  timeoutMs: OptionalTimeoutMs,
}).annotate({
  description:
    "Wheel-scrolls the active browser tab while collecting JSON array responses matching a URL substring.",
});
export type PreviewAutomationScrollCollectInput = typeof PreviewAutomationScrollCollectInput.Type;

export const PreviewAutomationScrollCollectResult = Schema.Struct({
  items: Schema.Array(Schema.Unknown),
  rounds: Schema.Int,
  responses: Schema.Int,
  stoppedBecause: Schema.Literals(["minItems", "maxItems", "maxScrolls", "noGrowth"]),
});
export type PreviewAutomationScrollCollectResult = typeof PreviewAutomationScrollCollectResult.Type;
