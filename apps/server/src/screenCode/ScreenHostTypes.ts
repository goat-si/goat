import type {
  ActionOutcomeSafety,
  ScreenHostCall,
  ScreenImage,
  ScreenImageMetadata,
  ScreenSurfaceAvailability,
  ScreenActionOutcome,
  ScreenEffectReceipt,
  ScreenRunError,
  ScreenRunLimits,
  ScreenBindingHints,
} from "@goat/contracts";
import type * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

export interface ScreenHostContext {
  readonly runId: string;
  readonly turnId: string;
  readonly cellId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly invocation: McpThreadInvocationScope;
  readonly limits: ScreenRunLimits;
  readonly bindingHints?: ScreenBindingHints;
}

export interface ScreenHostDispatchResult {
  readonly safety?: ActionOutcomeSafety;
  readonly value?: unknown;
  readonly image?: ScreenImage;
  readonly imageMetadata?: ScreenImageMetadata;
  readonly category: ScreenEffectReceipt["category"];
  readonly observedWindow?: string;
  readonly observedBaseline?: string;
  readonly evidence?: readonly string[];
  readonly warnings?: readonly string[];
  readonly outcome?: ScreenActionOutcome;
}

export interface ScreenHostDispatcher {
  readonly availability: (
    context: ScreenHostContext,
  ) => Effect.Effect<readonly ScreenSurfaceAvailability[]>;
  readonly dispatch: (
    call: ScreenHostCall,
    context: ScreenHostContext,
  ) => Effect.Effect<ScreenHostDispatchResult, ScreenRunError>;
  /**
   * Calls of one batch group, in order, as one trip where the host can. It returns an outcome for
   * each call from the first that ran; calls past the end of the list did not run. It marks each
   * call dispatched right before that call can reach the driver.
   */
  readonly dispatchBatch?: (
    calls: ReadonlyArray<ScreenHostCall>,
    context: ScreenHostContext,
    markDispatched: (index: number) => boolean,
  ) => Effect.Effect<ReadonlyArray<Exit.Exit<ScreenHostDispatchResult, ScreenRunError>>>;
}
