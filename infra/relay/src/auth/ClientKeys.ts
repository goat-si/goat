import {
  isConnectAssuranceFresh,
  RelayAuthenticationStrengthError,
  type ConnectSessionAssurance,
} from "@goat/contracts/connectAssurance";
import { RelayInternalError } from "@goat/contracts/relay";
import { and, count, eq, isNull } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import * as RelayDb from "../db.ts";
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
    }) => Effect.Effect<number, ReturnType<typeof strengthRequired> | RelayInternalError>;
    readonly check: (input: {
      readonly userId: string;
      readonly clientId: string;
      readonly thumbprint: string;
      readonly authGeneration: number;
      readonly admittedAt: number;
    }) => Effect.Effect<boolean, RelayInternalError>;
  }
>()("goat-relay/auth/ClientKeys") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const check = Effect.fn("ClientKeys.check")(function* (
    input: Parameters<ClientKeys["Service"]["check"]>[0],
  ) {
    const rows = yield* db
      .select()
      .from(relayClientKeys)
      .where(binding(input))
      .pipe(Effect.mapError(unavailable));
    const row = rows[0];
    return (
      row !== undefined &&
      row.revokedAt === null &&
      row.policyVersion === 1 &&
      row.authGeneration === input.authGeneration &&
      row.admittedAt === input.admittedAt
    );
  });
  const admit = Effect.fn("ClientKeys.admit")(function* (
    input: Parameters<ClientKeys["Service"]["admit"]>[0],
  ) {
    const userId = input.assurance.userId;
    return yield* db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`.pipe(
            Effect.mapError(unavailable),
          );
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
            existing.authGeneration === input.assurance.authGeneration
          )
            return existing.admittedAt;
          if (!isConnectAssuranceFresh(input.assurance, input.now))
            return yield* strengthRequired("reauthentication_required");
          const totals = yield* db
            .select({ total: count() })
            .from(relayClientKeys)
            .where(and(eq(relayClientKeys.userId, userId), isNull(relayClientKeys.revokedAt)))
            .pipe(Effect.mapError(unavailable));
          if ((totals[0]?.total ?? MAX_CLIENT_KEYS) >= MAX_CLIENT_KEYS)
            return yield* strengthRequired("unsupported_authentication_flow");
          yield* db
            .insert(relayClientKeys)
            .values({
              ...key,
              admittedAt: input.now,
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
                policyVersion: 1,
                authGeneration: input.assurance.authGeneration,
                revokedAt: null,
              },
            })
            .pipe(Effect.mapError(unavailable));
          return input.now;
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
