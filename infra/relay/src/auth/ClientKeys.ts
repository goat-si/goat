import * as ConnectAccounts from "./ConnectAccounts.ts";
import {
  isConnectAssuranceFresh,
  RelayAuthenticationStrengthError,
  type ConnectSessionAssurance,
} from "@goat/contracts/connectAssurance";
import { RelayInternalError } from "@goat/contracts/relay";
import { and, count, eq, isNull } from "drizzle-orm";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
import { AccountTransactions } from "../accounts/AccountTransactions.ts";
import { relayClientKeys } from "../persistence/schema.ts";
import { strengthRequired } from "./ConnectAuthentication.ts";

const MAX_CLIENT_KEYS = 20;
const unavailable = () =>
  new RelayInternalError({
    code: "internal_error",
    reason: "persistence_failed",
    traceId: "connect-keys",
  });
const binding = (input: {
  readonly userId: string;
  readonly clientId: string;
  readonly thumbprint: string;
}) =>
  and(
    eq(relayClientKeys.userId, input.userId),
    eq(relayClientKeys.clientId, input.clientId),
    eq(relayClientKeys.thumbprint, input.thumbprint),
  );

const isInternalError = Schema.is(RelayInternalError);

const isStrengthError = Schema.is(RelayAuthenticationStrengthError);

export class ClientKeys extends Context.Service<
  ClientKeys,
  {
    readonly admit: (input: {
      readonly assurance: ConnectSessionAssurance;
      readonly clientId: string;
      readonly thumbprint: string;
      readonly now: number;
      readonly readmit?: boolean;
    }) => Effect.Effect<
      { readonly authorizedAt: number; readonly admissionId: string },
      ReturnType<typeof strengthRequired> | RelayInternalError
    >;
    readonly check: (input: {
      readonly userId: string;
      readonly clientId: string;
      readonly thumbprint: string;
      readonly authGeneration: number;
      readonly admittedAt: number;
      readonly admissionId: string;
    }) => Effect.Effect<boolean, RelayInternalError>;
  }
>()("goat-relay/auth/ClientKeys") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const crypto = yield* Crypto.Crypto;
  const accounts = yield* ConnectAccounts.ConnectAccounts;
  const transactions = yield* AccountTransactions;
  const check = Effect.fn("ClientKeys.check")(function* (
    input: Parameters<ClientKeys["Service"]["check"]>[0],
  ) {
    const rows = yield* db
      .select()
      .from(relayClientKeys)
      .where(binding(input))
      .pipe(Effect.mapError(unavailable));
    const row = rows[0];
    if (!(yield* accounts.check(input.userId, input.authGeneration))) return false;
    return (
      row !== undefined &&
      row.revokedAt === null &&
      row.policyVersion === 1 &&
      row.authGeneration === input.authGeneration &&
      row.admittedAt === input.admittedAt &&
      row.admissionId === input.admissionId
    );
  });
  const admit = Effect.fn("ClientKeys.admit")(function* (
    input: Parameters<ClientKeys["Service"]["admit"]>[0],
  ) {
    const userId = input.assurance.userId;
    return yield* transactions
      .run(
        { userIds: [userId] },
        Effect.gen(function* () {
          if (!(yield* accounts.check(userId, input.assurance.authGeneration)))
            return yield* strengthRequired("session_not_active");
          const key = { userId, clientId: input.clientId, thumbprint: input.thumbprint };
          const rows = yield* db
            .select()
            .from(relayClientKeys)
            .where(binding(key))
            .pipe(Effect.mapError(unavailable));
          const existing = rows[0];
          if (
            existing &&
            existing.revokedAt === null &&
            existing.policyVersion === 1 &&
            existing.authGeneration === input.assurance.authGeneration &&
            existing.admissionId !== null
          )
            return { authorizedAt: existing.admittedAt, admissionId: existing.admissionId };
          if (
            existing?.revokedAt !== undefined &&
            existing.revokedAt !== null &&
            input.readmit !== true
          )
            return yield* strengthRequired("reauthentication_required");
          if (!isConnectAssuranceFresh(input.assurance, input.now))
            return yield* strengthRequired("reauthentication_required");
          const totals = yield* db
            .select({ total: count() })
            .from(relayClientKeys)
            .where(and(eq(relayClientKeys.userId, userId), isNull(relayClientKeys.revokedAt)))
            .pipe(Effect.mapError(unavailable));
          if ((totals[0]?.total ?? MAX_CLIENT_KEYS) >= MAX_CLIENT_KEYS)
            return yield* strengthRequired("unsupported_authentication_flow");
          const admissionId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable));
          yield* db
            .insert(relayClientKeys)
            .values({
              ...key,
              admittedAt: input.now,
              admissionId,
              policyVersion: 1,
              authGeneration: input.assurance.authGeneration,
            })
            .onConflictDoUpdate({
              target: [
                relayClientKeys.userId,
                relayClientKeys.clientId,
                relayClientKeys.thumbprint,
              ],
              set: {
                admittedAt: input.now,
                admissionId,
                policyVersion: 1,
                authGeneration: input.assurance.authGeneration,
                revokedAt: null,
              },
            })
            .pipe(Effect.mapError(unavailable));
          return { authorizedAt: input.now, admissionId };
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          isInternalError(error) || isStrengthError(error) ? error : unavailable(),
        ),
      );
  });
  return ClientKeys.of({ admit, check });
});
export const layer = Layer.effect(ClientKeys, make);
