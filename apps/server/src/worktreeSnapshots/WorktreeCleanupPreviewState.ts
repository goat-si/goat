import type { WorktreeCleanupPreview } from "@goat/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class StaleCleanupPreviewError extends Schema.TaggedError<StaleCleanupPreviewError>()(
  "StaleCleanupPreviewError",
  { previewId: Schema.String },
) {
  override get message(): string {
    return "This cleanup preview is out of date. Review the new one.";
  }
}

/**
 * Gates automatic worktree removal behind a first-run preview a person saw or confirmed.
 * State survives restarts; see the worktree retention plan for the transitions.
 */
export class WorktreeCleanupPreviewState extends Context.Service<
  WorktreeCleanupPreviewState,
  {
    /** apply: false means the sweep must remove no worktree and report preview instead. */
    readonly evaluate: (input: {
      readonly nowMs: number;
      readonly plannedCount: number;
      readonly requiresConfirmation: boolean;
    }) => Effect.Effect<{
      readonly apply: boolean;
      readonly preview: WorktreeCleanupPreview | null;
    }>;
    readonly respond: (input: {
      readonly previewId: string;
      readonly response: "seen" | "confirm";
      readonly nowMs: number;
    }) => Effect.Effect<void, StaleCleanupPreviewError>;
  }
>()("goat/worktreeSnapshots/WorktreeCleanupPreviewState") {}
