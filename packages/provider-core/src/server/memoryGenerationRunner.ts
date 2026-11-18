import * as M from "@goat/contracts";
import {
  declareMemoryGeneration,
  NO_MEMORY_GENERATION,
} from "@goat/shared/memoryGenerationCapabilities";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Request } from "./textGenerationOperations.ts";

export type MemoryOperationName = "resolveMemoryConflict" | "generateMemorySummary";
export type MemoryRunner = <S extends Schema.Top>(
  request: Request<S> & { readonly operation: MemoryOperationName },
) => Effect.Effect<
  { readonly result: S["Type"]; readonly execution: M.MemoryGenerationExecution },
  M.TextGenerationError,
  S["DecodingServices"]
>;
export const MemoryGenerationRunnerContext = Schema.Struct({
  providerInstanceId: M.ProviderInstanceId,
  environmentId: Schema.optionalKey(M.EnvironmentId),
});
export type MemoryGenerationRunnerContext = typeof MemoryGenerationRunnerContext.Type;
export type MemorySelectedRunner = <S extends Schema.Top>(
  request: Request<S> & { readonly operation: MemoryOperationName },
) => Effect.Effect<
  { readonly result: S["Type"]; readonly effectiveModel: string },
  M.TextGenerationError,
  S["DecodingServices"]
>;
const decodeSelection = Schema.decodeUnknownEffect(M.MemoryModelSelection);
const decodeExecution = Schema.decodeUnknownEffect(M.MemoryGenerationExecution);
const decodeContext = Schema.decodeUnknownEffect(MemoryGenerationRunnerContext);
export class MemoryGenerationRunnerError extends Schema.TaggedError<MemoryGenerationRunnerError>()(
  "MemoryGenerationRunnerError",
  {
    code: Schema.Literals([
      "unavailable",
      "identity_mismatch",
      "unsupported_operation",
      "invalid_output",
    ]),
  },
) {
  override get message() {
    return "Memory runner cannot execute this request.";
  }
}
export const unsupportedMemoryOperation = (operation: MemoryOperationName) =>
  Effect.fail(
    new M.TextGenerationError({
      operation,
      detail: "unsupported_operation",
      cause: new MemoryGenerationRunnerError({ code: "unsupported_operation" }),
    }),
  );

export const noMemoryGeneration = {
  memoryCapabilities: Effect.succeed(NO_MEMORY_GENERATION),
  resolveMemoryConflict: () => unsupportedMemoryOperation("resolveMemoryConflict"),
  generateMemorySummary: () => unsupportedMemoryOperation("generateMemorySummary"),
};

export const memoryRunnerCapabilities = (
  driver: string,
  context: MemoryGenerationRunnerContext | undefined,
  options: {
    readonly config?: Parameters<typeof declareMemoryGeneration>[1];
    readonly available?: Effect.Effect<boolean>;
  } = {},
) =>
  context?.environmentId === undefined
    ? noMemoryGeneration.memoryCapabilities
    : Effect.map(options.available ?? Effect.succeed(true), (allowed) =>
        allowed ? declareMemoryGeneration(driver, options.config) : NO_MEMORY_GENERATION,
      );

/** The provider passes metadata from its successful selection, never from generated JSON. */
export function withMemoryExecution(
  context: MemoryGenerationRunnerContext | undefined,
  effectiveProvider: M.ProviderDriverKind,
  runSelected: MemorySelectedRunner,
): MemoryRunner {
  const bound = context === undefined ? undefined : Object.freeze({ ...context });
  return (request) =>
    Effect.gen(function* () {
      const failure = (code: typeof MemoryGenerationRunnerError.Type.code) =>
        new M.TextGenerationError({
          operation: request.operation,
          detail: "Memory runner identity or output is invalid.",
          cause: new MemoryGenerationRunnerError({ code }),
        });
      if (bound?.environmentId === undefined) return yield* failure("unavailable");
      const identity = yield* decodeContext(bound, { onExcessProperty: "error" }).pipe(
        Effect.mapError(() => failure("identity_mismatch")),
      );
      const selection = yield* decodeSelection(request.modelSelection, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => failure("identity_mismatch")));
      if (selection.instanceId !== identity.providerInstanceId)
        return yield* failure("identity_mismatch");
      if (request.investigate !== undefined || request.attachments !== undefined)
        return yield* failure("unsupported_operation");
      const selected = yield* runSelected(request);
      // Decode result-only output; authority fields cannot survive even a custom runner.
      const result = yield* Schema.decodeUnknownEffect(request.outputSchema)(selected.result, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => failure("invalid_output")));
      const execution = yield* decodeExecution(
        {
          requestedModelSelection: selection,
          effectiveProvider,
          effectiveModel: selected.effectiveModel,
          providerInstanceId: identity.providerInstanceId,
          environmentId: identity.environmentId,
        },
        { onExcessProperty: "error" },
      ).pipe(Effect.mapError(() => failure("identity_mismatch")));
      return { result, execution };
    });
}
