import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import type { Connection } from "effect/sql/SqlConnection";
import { classifySqliteError, type SqlError } from "effect/sql/SqlError";

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

// As Effect's own pool: SQLite rolls back by itself on errors such as SQLITE_FULL.
const isNoTransactionError = (error: SqlError) => {
  const cause = error.reason.cause;
  const message = Predicate.hasProperty(cause, "message") ? String(cause.message) : String(cause);
  return /no transaction is active/i.test(message);
};

/**
 * A ROLLBACK that finds no transaction succeeds. Effect 4.1 turns a failed transaction cleanup into
 * a defect that typed catch no longer recovers, so the write's own SqlError would be lost.
 */
export const toleratingFinishedRollback = (connection: Connection): Connection => ({
  ...connection,
  executeUnprepared: (sql, params, rowTransform) =>
    /^\s*ROLLBACK\s*$/i.test(sql)
      ? connection
          .executeUnprepared(sql, params, rowTransform)
          .pipe(Effect.catchIf(isNoTransactionError, () => Effect.succeed([])))
      : connection.executeUnprepared(sql, params, rowTransform),
});
