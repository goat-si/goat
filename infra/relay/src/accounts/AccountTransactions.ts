import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlError from "effect/sql/SqlError";
import { subjectDigest } from "./SubjectDigest.ts";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import { RelayConfiguration } from "../Config.ts";
import { RelayDb } from "../db.ts";

const HeldAccountTransaction = Context.Reference<boolean>(
  "goat-relay/accounts/HeldAccountTransaction",
  { defaultValue: () => false },
);

export class AccountTransactions extends Context.Service<
  AccountTransactions,
  {
    readonly run: <A, E, R>(
      input: {
        readonly userIds: ReadonlyArray<string>;
        readonly environmentPublicKey?: string;
        readonly environmentPublicKeys?: ReadonlyArray<string>;
      },
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | SqlError.SqlError | RelayAuthorizationUnavailableError, R>;
  }
>()("goat-relay/accounts/AccountTransactions") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const config = yield* RelayConfiguration;
  const sql = db.$client;
  return AccountTransactions.of({
    run: Effect.fn("AccountTransactions.run")(function* (input, effect) {
      if (yield* HeldAccountTransaction) return yield* effect;
      const enclosing = yield* Effect.serviceOption(sql.transactionService);
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          // Only the outermost transaction may set isolation; Connect link completion encloses this one.
          if (Option.isNone(enclosing)) yield* sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
          for (const key of [
            ...new Set([
              ...(input.environmentPublicKey === undefined ? [] : [input.environmentPublicKey]),
              ...(input.environmentPublicKeys ?? []),
            ]),
          ].sort())
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relay:key:${key}`},0))`;
          for (const userId of [...new Set(input.userIds)].sort()) {
            const digest = yield* subjectDigest(userId).pipe(
              Effect.provideService(RelayConfiguration, config),
            );
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relay:account:${digest}`},0))`;
            yield* sql`UPDATE relay_account_access SET subject_digest=${digest} WHERE user_id=${userId} AND subject_digest IS NULL`;
            yield* sql`UPDATE relay_account_operations SET subject_digest=${digest} WHERE user_id=${userId} AND subject_digest IS NULL`;
            yield* sql`UPDATE relay_account_operation_requests SET subject_digest=${digest} WHERE user_id=${userId} AND subject_digest IS NULL`;
            yield* sql`UPDATE relay_retired_endpoints SET subject_digest=${digest} WHERE user_id=${userId} AND subject_digest IS NULL`;
          }
          return yield* effect.pipe(Effect.provideService(HeldAccountTransaction, true));
        }),
      );
    }),
  });
});
export const layer = Layer.effect(AccountTransactions, make);
