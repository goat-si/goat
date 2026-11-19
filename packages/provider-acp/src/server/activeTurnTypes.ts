import * as Schema from "effect/Schema";
import type * as DateTime from "effect/DateTime";

export class AcpModelSelectionError extends Schema.TaggedError<AcpModelSelectionError>()(
  "AcpModelSelectionError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The agent did not accept the model "${this.model}". Choose another model for this provider, then retry.`;
  }
}

export interface ActiveTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  sourceMessageId: string | null;
  text: string;
  // The running node and first text have been emitted.
  emitted: boolean;
  // Text changed since the last emission; a delayed flush is scheduled.
  dirty: boolean;
}

export interface ActiveTextStream {
  current: ActiveTextSegment | null;
  nextSegment: number;
  /** Closed messages a later chunk can resume, oldest first, up to MAX_RESUMABLE_TEXT_SEGMENTS. */
  readonly closedNamedSegments: Map<string, ActiveTextSegment>;
}

export interface AcpNativeBuildConfiguration {
  readonly modeId?: string;
  readonly configOptions: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

export const ACP_STOP_CONFIRM_TIMEOUT_MS = 10_000;
