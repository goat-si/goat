import * as M from "@goat/contracts";
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
