import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import * as Screen from "./previewAutomationScreen.ts";

export const PreviewAutomationFeature = Schema.Literal("snapshotOptions");
export const PreviewAutomationScope = Schema.Struct({
  ref: Schema.optional(TrimmedNonEmptyString),
  selector: Schema.optional(TrimmedNonEmptyString),
}).check(
  Schema.makeFilter(
    (input) =>
      Number(input.ref !== undefined) + Number(input.selector !== undefined) === 1 ||
      "Supply exactly one of ref or selector.",
  ),
);
export type PreviewAutomationScope = typeof PreviewAutomationScope.Type;

export const PreviewAutomationSnapshotInput = Schema.Struct({
  tabId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
  scope: Schema.optional(PreviewAutomationScope).annotate({
    description: "Restrict the tree and visible text to one ref or selector match.",
  }),
  interactiveOnly: Schema.optional(Schema.Boolean).annotate({
    description: "Keep only interactive roles and their refs before applying the tree budget.",
  }),
  diff: Schema.optional(Schema.Boolean).annotate({
    description:
      "Compare semantic lines with this caller’s previous complete snapshot of the same document, scope and mode.",
  }),
  annotate: Schema.optional(Schema.Boolean).annotate({
    description: "Draw ref labels on a requested or saved screenshot; remove labels after capture.",
  }),
  fullPage: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Capture the document from its top-left instead of the viewport. Defaults to false. Full-page captures are clipped to 3840 × 16384 CSS pixels and scaled to at most 3840 × 16384 image pixels and 8 MiB; screenshot.clipped reports omitted document content.",
    }),
  ),
});
export type PreviewAutomationSnapshotInput = typeof PreviewAutomationSnapshotInput.Type;

export const PreviewAutomationElement = Schema.Struct({
  tag: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  selector: Schema.String,
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});
export type PreviewAutomationElement = typeof PreviewAutomationElement.Type;

export const PreviewAutomationConsoleEntry = Schema.Struct({
  level: Schema.String,
  text: Schema.String,
  timestamp: Schema.String,
  source: Schema.optional(Schema.String),
});
export type PreviewAutomationConsoleEntry = typeof PreviewAutomationConsoleEntry.Type;

export const PreviewAutomationNetworkEntry = Schema.Struct({
  url: Schema.String,
  method: Schema.String,
  status: Schema.NullOr(Schema.Number),
  failed: Schema.Boolean,
  errorText: Schema.optional(Schema.String),
  timestamp: Schema.String,
  requestId: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.Literals(["request", "response", "finished", "failed"])),
  durationMs: Schema.optional(Schema.Number),
});
export type PreviewAutomationNetworkEntry = typeof PreviewAutomationNetworkEntry.Type;

export const PreviewAutomationPageError = Schema.Struct({
  message: Schema.String,
  stack: Schema.optional(Schema.String),
  timestamp: Schema.String,
});
export type PreviewAutomationPageError = typeof PreviewAutomationPageError.Type;

export const PreviewAutomationActionEvent = Schema.Struct({
  id: Schema.String,
  action: Schema.String,
  status: Schema.Literals(["running", "succeeded", "failed", "interrupted"]),
  startedAt: Schema.String,
  completedAt: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
export type PreviewAutomationActionEvent = typeof PreviewAutomationActionEvent.Type;

export const PreviewAutomationSnapshot = Schema.Struct({
  url: Schema.String,
  title: Schema.String,
  loading: Schema.Boolean,
  visibleText: Schema.String,
  interactiveElements: Schema.Array(PreviewAutomationElement),
  accessibilityTree: Schema.Unknown,
  consoleEntries: Schema.Array(PreviewAutomationConsoleEntry),
  networkEntries: Schema.Array(PreviewAutomationNetworkEntry),
  actionTimeline: Schema.Array(PreviewAutomationActionEvent),
  /** Absent when the request skipped the capture because nothing would show or save it. */
  screenshot: Schema.optional(
    Schema.Struct({
      mimeType: Schema.Literal("image/png"),
      data: Schema.String,
      width: Schema.Int,
      height: Schema.Int,
      fullPage: Schema.optional(Schema.Boolean),
      clipped: Schema.optional(Schema.Boolean),
      byteLength: Schema.optional(Schema.Int),
      ...Screen.ScreenshotPlacementFields,
    }),
  ),
  treeComplete: Schema.optional(Schema.Boolean),
  refGeneration: Schema.optional(Schema.String),
  /** The tab the snapshot read, so callers can key per-tab state when they omitted tabId. */
  tabId: Schema.optional(TrimmedNonEmptyString),
  omitted: Schema.optional(
    Schema.Array(
      Schema.Literals(["tree_budget", "unread_frames", "text_budget", "transport_budget"]),
    ),
  ),
  diff: Schema.optional(
    Schema.Struct({
      base: Schema.Literals(["previous", "none"]),
      added: Schema.Array(Schema.String),
      removed: Schema.Array(Schema.String),
    }),
  ),
  next: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
});
export type PreviewAutomationSnapshot = typeof PreviewAutomationSnapshot.Type;
