import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlError from "effect/sql/SqlError";
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
    ) => Effect.Effect<A, E | SqlError.SqlError, R>;
  }
>()("goat-relay/accounts/AccountTransactions") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb;
  const sql = db.$client;
  return AccountTransactions.of({
    run: Effect.fn("AccountTransactions.run")(function* (input, effect) {
      if (yield* HeldAccountTransaction) return yield* effect;
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`;
          for (const key of [
            ...new Set([
              ...(input.environmentPublicKey === undefined ? [] : [input.environmentPublicKey]),
              ...(input.environmentPublicKeys ?? []),
            ]),
          ].sort())
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relay:key:${key}`},0))`;
          for (const userId of [...new Set(input.userIds)].sort()) {
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relay:account:${userId}`},0))`;
          }
          return yield* effect.pipe(Effect.provideService(HeldAccountTransaction, true));
        }),
      );
    }),
  });
});
export const layer = Layer.effect(AccountTransactions, make);
