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
