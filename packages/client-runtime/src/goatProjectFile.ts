import { GOAT_PROJECT_FILE_NAME, ProjectReadFileError } from "@goat/contracts";
import { LEGACY_PROJECT_FILE_NAME } from "@goat/contracts/legacyT3Names";
import * as Schema from "effect/Schema";

const isReadError = Schema.is(ProjectReadFileError);

/** Older servers expose missing files through the read error's serialized cause. */
export function goatProjectFileReadPath(data: unknown, error: unknown, isPending = false): string {
  if (data !== null || isPending || !isReadError(error)) return GOAT_PROJECT_FILE_NAME;
  if (error.failure !== undefined && error.failure !== "operation_failed") {
    return GOAT_PROJECT_FILE_NAME;
  }
  if (error.operation === "realpath-workspace-root") return GOAT_PROJECT_FILE_NAME;
  let cause: unknown = error.cause;
  for (let depth = 0; depth < 4 && typeof cause === "object" && cause !== null; depth++) {
    if (
      ("code" in cause && cause.code === "ENOENT") ||
      ("message" in cause && typeof cause.message === "string" && /\bENOENT\b/.test(cause.message))
    ) {
      return LEGACY_PROJECT_FILE_NAME;
    }
    cause = "cause" in cause ? cause.cause : null;
  }
  return GOAT_PROJECT_FILE_NAME;
}
