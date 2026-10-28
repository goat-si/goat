import { RelayInternalError } from "@goat/contracts/relay";
import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import { relayAccountAccess } from "../persistence/schema.ts";

/**
 * Connect session generations come from relay_account_access, the single account-status record.
 * Sessions still authenticate suspended or uninvited users so owner-only cleanup stays reachable;
 * AccountAccess denies everything else, and `check` only accepts the current allowed epoch.
 */
export class ConnectAccounts extends Context.Service<
  ConnectAccounts,
  {
    readonly authorize: (userId: string) => Effect.Effect<number, RelayInternalError>;
    readonly check: (
      userId: string,
      generation: number,
    ) => Effect.Effect<boolean, RelayInternalError>;
  }
>()("goat-relay/auth/ConnectAccounts") {}
const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const unavailable = () =>
    new RelayInternalError({
      code: "internal_error",
      reason: "persistence_failed",
      traceId: "connect-account",
    });
  const read = Effect.fn("ConnectAccounts.read")(function* (userId: string) {
    const rows = yield* db
      .select({ status: relayAccountAccess.status, accountEpoch: relayAccountAccess.accountEpoch })
      .from(relayAccountAccess)
      .where(eq(relayAccountAccess.userId, userId))
      .pipe(Effect.mapError(unavailable));
    return rows[0];
  });
  const authorize = Effect.fn("ConnectAccounts.authorize")(function* (userId: string) {
    return (yield* read(userId))?.accountEpoch ?? 0;
  });
  const check = Effect.fn("ConnectAccounts.check")(function* (userId: string, generation: number) {
    const account = yield* read(userId);
    return account?.status === "allowed" && account.accountEpoch === generation;
  });
  return ConnectAccounts.of({ authorize, check });
});
export const layer = Layer.effect(ConnectAccounts, make);
