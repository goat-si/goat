import { RelayInternalError } from "@goat/contracts/relay";
import { eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import { relayConnectAccounts } from "../persistence/schema.ts";
import { RelayAuthenticationStrengthError } from "@goat/contracts/connectAssurance";

export class ConnectAccounts extends Context.Service<
  ConnectAccounts,
  {
    readonly authorize: (
      userId: string,
    ) => Effect.Effect<number, RelayAuthenticationStrengthError | RelayInternalError>;
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
      .select()
      .from(relayConnectAccounts)
      .where(eq(relayConnectAccounts.userId, userId))
      .pipe(Effect.mapError(unavailable));
    return rows[0];
  });
  const authorize = Effect.fn("ConnectAccounts.authorize")(function* (userId: string) {
    yield* db
      .insert(relayConnectAccounts)
      .values({ userId, generation: 1, status: "active" })
      .onConflictDoNothing()
      .pipe(Effect.mapError(unavailable));
    const account = yield* read(userId);
    if (!account || account.status !== "active")
      return yield* new RelayAuthenticationStrengthError({
        code: "authentication_strength_required",
        reason: "session_not_active",
        requiredLevel: "multi_factor",
        maxAgeSeconds: 600,
        traceId: "connect-account",
      });
    return account.generation;
  });
  const check = Effect.fn("ConnectAccounts.check")(function* (userId: string, generation: number) {
    const account = yield* read(userId);
    return account?.status === "active" && account.generation === generation;
  });
  return ConnectAccounts.of({ authorize, check });
});
export const layer = Layer.effect(ConnectAccounts, make);
