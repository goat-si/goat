import { RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderTurnStartServiceV2Shape {
  /**
   * Starts the run's provider turn. When `willRetry` is true, a session open
   * failure is returned so the caller can retry. Workspace contention is always returned.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
    readonly reattach?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}
