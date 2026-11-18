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

const failedRollbacks = new WeakSet<Connection>();
// Identify SqlClient's cleanup command separately from statements issued inside the transaction.
const TRANSACTION_ROLLBACK = "ROLLBACK /* GOAT transaction cleanup */";

const rollback = (connection: Connection) =>
  connection
    .executeUnprepared("ROLLBACK", [], undefined)
    .pipe(Effect.catchIf(isNoTransactionError, () => Effect.succeed([])));

/** The borrower or transaction acquirer must hold the connection lease. */
const recoverConnection = (connection: Connection) =>
  Effect.suspend(() =>
    failedRollbacks.has(connection)
      ? rollback(connection).pipe(
          Effect.map(() => {
            failedRollbacks.delete(connection);
            return connection;
          }),
        )
      : Effect.succeed(connection),
  );

const withRollbackCleanup = (connection: Connection): Connection => ({
  ...connection,
  executeUnprepared: (sql, params, rowTransform) =>
    sql === TRANSACTION_ROLLBACK
      ? rollback(connection).pipe(
          // Effect turns cleanup failure into a defect, masking the body's typed failure.
          Effect.catch((cause) => {
            failedRollbacks.add(connection);
            return Effect.logWarning("SQLite rollback failed; connection requires cleanup", {
              cause,
            }).pipe(Effect.as([]));
          }),
        )
      : connection.executeUnprepared(sql, params, rowTransform),
});

const transactionControls = <R>(acquire: Effect.Effect<Connection, SqlError, R>) => {
  const acquirer = Effect.flatMap(acquire, recoverConnection);
  return {
    acquirer,
    transactionAcquirer: Effect.map(acquirer, withRollbackCleanup),
    rollback: TRANSACTION_ROLLBACK,
  };
};

export const sqliteRollback = { recoverConnection, transactionControls };
