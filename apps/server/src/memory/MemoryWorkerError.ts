import * as M from "@goat/contracts";
import { classifyTextGenerationFailure } from "@goat/provider-core/server/textGenerationUtils";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class MemoryWorkerError extends Schema.TaggedError<MemoryWorkerError>()(
  "MemoryWorkerError",
  {
    code: M.MemoryFailureCode,
    stage: Schema.optionalKey(
      Schema.Literals([
        "catch-up",
        "deferred",
        "due-work",
        "claim-work",
        "read-work",
        "execute",
        "maintenance",
      ]),
    ),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message() {
    return "Memory work failed.";
  }
}

const isFailureCode = Schema.is(M.MemoryFailureCode);
const isTextGenerationError = Schema.is(M.TextGenerationError);
export const safeCode = (error: unknown): M.MemoryFailureCode => {
  if (typeof error === "object" && error !== null) {
    if ("code" in error && isFailureCode(error.code)) return error.code;
    if ("_tag" in error && error._tag === "TextGenerationError") {
      // Only exact public enum codes may cross the provider's diagnostic boundary.
      if ("detail" in error && isFailureCode(error.detail)) return error.detail;
      return "generation_failed";
    }
  }
  return "storage_failed";
};

/**
 * One warning per failed summary attempt, so failures can be traced later. It names the failure
 * class only: provider detail can echo raw CLI output, and memory content never belongs in logs.
 */
export const logGenerationFailure = (input: {
  readonly work: { readonly id: string; readonly kind: string; readonly attempt: number };
  readonly code: M.MemoryFailureCode;
  readonly retrying: boolean;
  readonly error: unknown;
}) => {
  let failure: string | undefined;
  for (let current = input.error, depth = 0; current !== undefined && depth < 4; depth += 1) {
    if (isTextGenerationError(current)) {
      failure = classifyTextGenerationFailure(current);
      break;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? current.cause
        : undefined;
  }
  return Effect.logWarning("Memory summary attempt failed", {
    work: input.work.id,
    kind: input.work.kind,
    attempt: input.work.attempt,
    code: input.code,
    retrying: input.retrying,
    ...(failure ? { failure } : {}),
  });
};
