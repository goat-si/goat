import * as Schema from "effect/Schema";

import { GenerateMemorySummaryResult, MemoryGenerationExecution } from "./memory.ts";

/** A generated summary the worker commits. */
export const GenerateMemorySummaryExecutionResult = Schema.Struct({
  result: GenerateMemorySummaryResult,
  execution: MemoryGenerationExecution,
});
export type GenerateMemorySummaryExecutionResult = typeof GenerateMemorySummaryExecutionResult.Type;

/** A provider's answer: null when the supplied messages hold nothing durable to keep. */
export const GenerateMemorySummaryOutcome = Schema.Struct({
  result: Schema.NullOr(GenerateMemorySummaryResult),
  execution: MemoryGenerationExecution,
  /** Present only for a promote request: candidates for the thread's project and for the user. */
  promotions: Schema.optionalKey(
    Schema.Struct({
      project: Schema.NullOr(GenerateMemorySummaryResult),
      user: Schema.NullOr(GenerateMemorySummaryResult),
    }),
  ),
});
export type GenerateMemorySummaryOutcome = typeof GenerateMemorySummaryOutcome.Type;
