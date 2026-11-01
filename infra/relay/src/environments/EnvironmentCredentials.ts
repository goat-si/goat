import { assertEnabled } from "../auth/MintControl.ts";
import { RelayConfiguration } from "../Config.ts";
import * as EnvironmentOwnership from "./EnvironmentOwnership.ts";
import * as AccountTransactions from "../accounts/AccountTransactions.ts";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { and, eq, exists, isNull, ne, or } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import * as RelayDb from "../db.ts";
import { relayEnvironmentCredentials, relayEnvironmentLinks } from "../persistence/schema.ts";

export class EnvironmentCredentialCreatePersistenceError extends Schema.TaggedError<EnvironmentCredentialCreatePersistenceError>()(
  "EnvironmentCredentialCreatePersistenceError",
  {
    stage: Schema.Literals([
      "generate-credential",
      "hash-token",
      "insert-credential",
      "revoke-previous-credentials",
    ]),
    environmentId: Schema.String,
    credentialId: Schema.optionalKey(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential creation failed during '${this.stage}' for environment '${this.environmentId}'${this.credentialId === undefined ? "" : `, credential '${this.credentialId}'`}`;
  }
}

export class EnvironmentCredentialAuthenticatePersistenceError extends Schema.TaggedError<EnvironmentCredentialAuthenticatePersistenceError>()(
  "EnvironmentCredentialAuthenticatePersistenceError",
  {
    stage: Schema.Literals(["hash-token", "lookup-credential"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Environment credential authentication failed during '${this.stage}'`;
  }
}

export class EnvironmentCredentialRevokePersistenceError extends Schema.TaggedError<EnvironmentCredentialRevokePersistenceError>()(
  "EnvironmentCredentialRevokePersistenceError",
  {
    environmentId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to revoke credentials for environment '${this.environmentId}'`;
  }
}

export interface EnvironmentCredentialPrincipal {
  readonly userId: string;
  readonly accountEpoch: number;
  readonly credentialId: string;
  readonly environmentId: string;
  readonly environmentPublicKey: string;
}

export class EnvironmentCredentials extends Context.Service<
  EnvironmentCredentials,
  {
    readonly create: (input: {
      readonly userId: string;
      readonly accountEpoch: number;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<
      string,
      EnvironmentCredentialCreatePersistenceError | EnvironmentOwnership.OwnershipError
    >;
    readonly authenticate: (
      token: string,
    ) => Effect.Effect<
      Option.Option<EnvironmentCredentialPrincipal>,
      EnvironmentCredentialAuthenticatePersistenceError | EnvironmentOwnership.OwnershipError
    >;
    readonly revokeForEnvironmentPublicKey: (input: {
      readonly userId: string;
      readonly environmentId: string;
      readonly environmentPublicKey: string;
    }) => Effect.Effect<boolean, EnvironmentCredentialRevokePersistenceError>;
  }
>()("goat-relay/environments/EnvironmentCredentials") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const config = yield* RelayConfiguration;
  const ownership = yield* EnvironmentOwnership.EnvironmentOwnership;
  const transactions = yield* AccountTransactions.AccountTransactions;
  const crypto = yield* Crypto.Crypto;
  const hashToken = (token: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(token)).pipe(Effect.map(Base64Url.encode));
  const randomTokenPart = (segments: number) =>
    Effect.map(
      Effect.all(Array.from({ length: segments }, () => crypto.randomUUIDv4())),
      (values) => values.join("").replaceAll("-", ""),
    );
  const makeCredential = Effect.fnUntraced(function* () {
    const credentialId = yield* randomTokenPart(2);
    const secret = yield* randomTokenPart(3);
    return {
      credentialId,
      token: `goatenv_${credentialId}_${secret}`,
    };
  });

  return EnvironmentCredentials.of({
    create: Effect.fn("relay.environment_credentials.create")(function* (input) {
      yield* assertEnabled(config);
      return yield* transactions
        .run(
          { userIds: [input.userId] },
          Effect.gen(function* () {
            yield* ownership.assertActive(input);
            yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
            const credential = yield* makeCredential().pipe(
              Effect.mapError(
                (cause) =>
                  new EnvironmentCredentialCreatePersistenceError({
                    stage: "generate-credential",
                    environmentId: input.environmentId,
                    cause,
                  }),
              ),
            );
            const credentialHash = yield* hashToken(credential.token).pipe(
              Effect.mapError(
                (cause) =>
                  new EnvironmentCredentialCreatePersistenceError({
                    stage: "hash-token",
                    environmentId: input.environmentId,
                    credentialId: credential.credentialId,
                    cause,
                  }),
              ),
            );
            const now = DateTime.formatIso(yield* DateTime.now);
            yield* db
              .insert(relayEnvironmentCredentials)
              .values({
                userId: input.userId,
                accountEpoch: input.accountEpoch,
                credentialId: credential.credentialId,
                environmentId: input.environmentId,
                environmentPublicKey: input.environmentPublicKey,
                credentialHash,
                revokedAt: null,
                createdAt: now,
                updatedAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new EnvironmentCredentialCreatePersistenceError({
                      stage: "insert-credential",
                      environmentId: input.environmentId,
                      credentialId: credential.credentialId,
                      cause,
                    }),
                ),
              );
            yield* db
              .update(relayEnvironmentCredentials)
              .set({
                revokedAt: now,
                updatedAt: now,
              })
              .where(
                and(
                  eq(relayEnvironmentCredentials.environmentId, input.environmentId),
                  eq(relayEnvironmentCredentials.environmentPublicKey, input.environmentPublicKey),
                  or(
                    eq(relayEnvironmentCredentials.userId, input.userId),
                    isNull(relayEnvironmentCredentials.userId),
                  ),
                  ne(relayEnvironmentCredentials.credentialId, credential.credentialId),
                  isNull(relayEnvironmentCredentials.revokedAt),
                ),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new EnvironmentCredentialCreatePersistenceError({
                      stage: "revoke-previous-credentials",
                      environmentId: input.environmentId,
                      credentialId: credential.credentialId,
                      cause,
                    }),
                ),
              );
            return credential.token;
          }),
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "SqlError"
              ? new RelayAuthorizationUnavailableError({
                  code: "authorization_unavailable",
                  traceId: "relay",
                })
              : error,
          ),
        );
    }),

    authenticate: Effect.fn("relay.environment_credentials.authenticate")(function* (token) {
      const credentialHash = yield* hashToken(token).pipe(
        Effect.mapError(
          (cause) =>
            new EnvironmentCredentialAuthenticatePersistenceError({
              stage: "hash-token",
              cause,
            }),
        ),
      );
      const rows = yield* db
        .select({
          userId: relayEnvironmentCredentials.userId,
          accountEpoch: relayEnvironmentCredentials.accountEpoch,
          credentialId: relayEnvironmentCredentials.credentialId,
          environmentId: relayEnvironmentCredentials.environmentId,
          environmentPublicKey: relayEnvironmentCredentials.environmentPublicKey,
        })
        .from(relayEnvironmentCredentials)
        .where(
          and(
            eq(relayEnvironmentCredentials.credentialHash, credentialHash),
            isNull(relayEnvironmentCredentials.revokedAt),
            exists(
              new QueryBuilder()
                .select({ userId: relayEnvironmentLinks.userId })
                .from(relayEnvironmentLinks)
                .where(
                  and(
                    eq(
                      relayEnvironmentLinks.environmentId,
                      relayEnvironmentCredentials.environmentId,
                    ),
                    eq(
                      relayEnvironmentLinks.environmentPublicKey,
                      relayEnvironmentCredentials.environmentPublicKey,
                    ),
                    eq(relayEnvironmentLinks.userId, relayEnvironmentCredentials.userId),
                    eq(
                      relayEnvironmentLinks.accountEpoch,
                      relayEnvironmentCredentials.accountEpoch,
                    ),
                    isNull(relayEnvironmentLinks.revokedAt),
                  ),
                ),
            ),
          ),
        )
        .limit(1)
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialAuthenticatePersistenceError({
                stage: "lookup-credential",
                cause,
              }),
          ),
        );
      const row = rows[0];
      if (row && row.userId !== null && row.accountEpoch !== null)
        yield* ownership.assertActive({
          userId: row.userId,
          accountEpoch: row.accountEpoch,
          environmentId: row.environmentId,
          environmentPublicKey: row.environmentPublicKey,
        });
      if (row) {
        yield* Effect.annotateCurrentSpan({ "relay.environment_id": row.environmentId });
      }
      return row && row.userId !== null && row.accountEpoch !== null
        ? Option.some({
            userId: row.userId,
            accountEpoch: row.accountEpoch,
            credentialId: row.credentialId,
            environmentId: row.environmentId,
            environmentPublicKey: row.environmentPublicKey,
          })
        : Option.none();
    }),

    revokeForEnvironmentPublicKey: Effect.fn(
      "relay.environment_credentials.revoke_for_environment_public_key",
    )(function* (input) {
      yield* Effect.annotateCurrentSpan({ "relay.environment_id": input.environmentId });
      const revokedAt = DateTime.formatIso(yield* DateTime.now);
      const rows = yield* db
        .update(relayEnvironmentCredentials)
        .set({
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(
          and(
            eq(relayEnvironmentCredentials.environmentId, input.environmentId),
            eq(relayEnvironmentCredentials.environmentPublicKey, input.environmentPublicKey),
            isNull(relayEnvironmentCredentials.revokedAt),
            eq(relayEnvironmentCredentials.userId, input.userId),
          ),
        )
        .returning({
          credentialId: relayEnvironmentCredentials.credentialId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new EnvironmentCredentialRevokePersistenceError({
                environmentId: input.environmentId,
                cause,
              }),
          ),
        );
      return rows.length > 0;
    }),
  });
});

export const layer = Layer.effect(EnvironmentCredentials, make);
