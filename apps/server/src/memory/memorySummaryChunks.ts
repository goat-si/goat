import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import { MemoryWorkerError } from "./MemoryWorkerError.ts";
import { scanMemoryValue } from "./MemorySecretScanner.ts";

export interface SummarySource {
  readonly messages: M.GenerateMemorySummaryInput["messages"];
  readonly watermark: M.MemorySourceWatermark;
}

export interface GeneratedSummary {
  readonly input: M.GenerateMemorySummaryInput;
  readonly output: M.GenerateMemorySummaryExecutionResult;
}

export interface SummaryPromotions {
  /** The final chunk's input, which the candidates cite. */
  readonly input: M.GenerateMemorySummaryInput;
  readonly candidates: NonNullable<M.GenerateMemorySummaryOutcome["promotions"]>;
  readonly execution: M.MemoryGenerationExecution;
}

/**
 * Summarizes every bounded source chunk in order. A chunk with nothing durable leaves the previous
 * summary standing and later chunks still run; the last useful chunk is the result. Promotion is
 * asked for on the final chunk only, when the model sees the whole accumulated summary.
 */
export const generateSummaryChunks = Effect.fn("MemoryWorker.generateSummaryChunks")(function* <
  E,
  R,
>(options: {
  readonly first: SummarySource;
  readonly throughSequence: number;
  readonly previousSummary: M.MemoryPayload | undefined;
  readonly dependencies: ReadonlyArray<M.MemoryRevisionId>;
  readonly promote: boolean;
  readonly buildInput: (
    source: SummarySource,
    previousSummary: M.MemoryPayload | undefined,
    promote: boolean,
  ) => Effect.Effect<M.GenerateMemorySummaryInput, E | MemoryWorkerError>;
  readonly readFrom: (
    fromSequence: number,
  ) => Effect.Effect<SummarySource, E | MemoryWorkerError, R>;
  readonly renewClaim: Effect.Effect<void, E | MemoryWorkerError>;
  readonly generate: (
    input: M.GenerateMemorySummaryInput,
  ) => Effect.Effect<M.GenerateMemorySummaryOutcome, E | MemoryWorkerError>;
  readonly sameExecution: (execution: M.MemoryGenerationExecution) => boolean;
}) {
  let source = options.first;
  let previousSummary = options.previousSummary;
  let summary: GeneratedSummary | undefined;
  let promotions: SummaryPromotions | undefined;
  while (true) {
    const final = source.watermark.throughSequence >= options.throughSequence;
    // Empty filtered pages still consume their bounded source range. A trailing
    // empty page completes the work without sending an invalid empty model input.
    if (source.messages.length) {
      const input = yield* options.buildInput(source, previousSummary, final && options.promote);
      yield* options.renewClaim;
      const output = yield* options.generate(input);
      if (!options.sameExecution(output.execution))
        return yield* new MemoryWorkerError({ code: "identity_mismatch" });
      const result = output.result;
      if (result !== null) {
        if (!M.validateMemoryGenerationResult(input, result))
          return yield* new MemoryWorkerError({ code: "invalid_output" });
        if (scanMemoryValue(result).kind !== "allowed")
          return yield* new MemoryWorkerError({ code: "secret_detected" });
        summary = { input, output: { execution: output.execution, result } };
        previousSummary = {
          text: result.text,
          evidence: result.evidence,
          derivedFromMemoryRevisions: options.dependencies,
        };
      }
      if (output.promotions && scanMemoryValue(output.promotions).kind === "allowed")
        promotions = { input, candidates: output.promotions, execution: output.execution };
    }
    if (final) return { summary, promotions };
    if (!source.messages.length) yield* options.renewClaim;
    source = yield* options.readFrom(source.watermark.throughSequence);
  }
});
