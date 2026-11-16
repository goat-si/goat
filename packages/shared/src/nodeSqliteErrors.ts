import * as Predicate from "effect/Predicate";
import { classifySqliteError } from "effect/sql/SqlError";

// node:sqlite supplies errcode; classifySqliteError expects errno.
export const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};
