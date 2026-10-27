import { EnvironmentId } from "@goat/contracts";
import {
  RelayInternalError,
  RelayManagedEndpoint,
  RelayManagedEndpointRuntimeConfig,
} from "@goat/contracts/relay";
import {
  isConnectAssuranceFresh,
  type ConnectSessionAssurance,
} from "@goat/contracts/connectAssurance";
import { and, eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import * as RelayDb from "../db.ts";
import * as WebCrypto from "../WebCrypto.ts";
import * as Config from "../Config.ts";
import * as ConnectAccounts from "../auth/ConnectAccounts.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import { strengthRequired } from "../auth/ConnectAuthentication.ts";
import { relayConnectLinkReservations } from "../persistence/schema.ts";

const Outcome = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
  environmentCredential: Schema.String,
});
type Outcome = typeof Outcome.Type;
interface Reservation {
  readonly userId: string;
  readonly challengeId: string;
  readonly proof: string;
  readonly attemptId: string;
  readonly environmentId: string;
  readonly assurance: ConnectSessionAssurance;
  readonly managedTunnelsEnabled: boolean;
}
const unavailable = () =>
  new RelayInternalError({
    code: "internal_error",
    reason: "persistence_failed",
    traceId: "connect-reservation",
  });
type ReservationError =
  | RelayInternalError
  | ReturnType<typeof strengthRequired>
  | DpopProofs.DpopProofReplayPersistenceError;

export class ConnectLinkReservations extends Context.Service<
  ConnectLinkReservations,
  {
    readonly exclusive: <A, E, R>(
      userId: string,
      use: (assertOwner: Effect.Effect<void, RelayInternalError>) => Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RelayInternalError, R>;
    readonly recover: <E, R>(
      userId: string,
      assertOwner: Effect.Effect<void, RelayInternalError>,
      cleanup: (environmentId: string) => Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, E | RelayInternalError, R>;
    readonly reserve: <E, R>(
      input: Reservation,
      consume: Effect.Effect<void, E, R>,
    ) => Effect.Effect<Outcome | null, E | ReservationError, R>;
    readonly complete: <E, R>(
      input: Reservation,
      commit: Effect.Effect<Outcome, E, R>,
    ) => Effect.Effect<Outcome, E | ReservationError, R>;
    readonly withdraw: <A, E, R>(
      input: {
        readonly userId: string;
        readonly environmentId: string;
      },
      revoke: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | RelayInternalError, R>;
    readonly failed: (input: Reservation) => Effect.Effect<void, RelayInternalError>;
  }
>()("goat-relay/environments/ConnectLinkReservations") {}

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;
  const { subtle } = yield* WebCrypto.WebCrypto;
  const accounts = yield* ConnectAccounts.ConnectAccounts;
  const crypto = yield* Crypto.Crypto;
  const config = yield* Config.RelayConfiguration;
  const key = yield* Effect.tryPromise({
    try: async () => {
      const digest = await subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          `connect-link-outcome-v1:${Redacted.value(config.cloudMintPrivateKey)}`,
        ),
      );
      return subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
    },
    catch: unavailable,
  });
  const binding = (input: Reservation) =>
    and(
      eq(relayConnectLinkReservations.userId, input.userId),
      eq(relayConnectLinkReservations.challengeId, input.challengeId),
    );
  const lock = (userId: string) =>
    db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${userId}, 0))`.pipe(
      Effect.mapError(unavailable),
    );
  const authorize = Effect.fn("ConnectLinkReservations.authorize")(function* (input: Reservation) {
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    if (!isConnectAssuranceFresh(input.assurance, now))
      return yield* strengthRequired("reauthentication_required");
    if (!(yield* accounts.check(input.userId, input.assurance.authGeneration)))
      return yield* strengthRequired("session_not_active");
  });
  const seal = Effect.fn("ConnectLinkReservations.seal")(function* (
    input: Reservation,
    outcome: Outcome,
  ) {
    const iv = yield* crypto.randomBytes(12).pipe(Effect.mapError(unavailable));
    const encrypted = yield* Effect.tryPromise({
      try: () =>
        subtle.encrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(iv),
            additionalData: new TextEncoder().encode(`${input.userId}:${input.challengeId}`),
          },
          key,
          new TextEncoder().encode(JSON.stringify(outcome)),
        ),
      catch: unavailable,
    });
    return `${Base64Url.encode(iv)}.${Base64Url.encode(new Uint8Array(encrypted))}`;
  });
  const open = Effect.fn("ConnectLinkReservations.open")((input: Reservation, sealed: string) =>
    Effect.tryPromise({
      try: async () => {
        const [iv, ciphertext] = sealed.split(".");
        if (!iv || !ciphertext) throw new Error("Invalid reservation outcome");
        const plaintext = await subtle.decrypt(
          {
            name: "AES-GCM",
            iv: new Uint8Array(Result.getOrThrow(Base64Url.decode(iv))),
            additionalData: new TextEncoder().encode(`${input.userId}:${input.challengeId}`),
          },
          key,
          new Uint8Array(Result.getOrThrow(Base64Url.decode(ciphertext))),
        );
        return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
      },
      catch: unavailable,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Outcome)), Effect.mapError(unavailable)),
  );
  const reserve: ConnectLinkReservations["Service"]["reserve"] = Effect.fn(
    "ConnectLinkReservations.reserve",
  )(function* (input, consume) {
    return yield* db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* lock(input.userId);
          yield* authorize(input);
          const rows = yield* db
            .select()
            .from(relayConnectLinkReservations)
            .where(binding(input))
            .pipe(Effect.mapError(unavailable));
          const row = rows[0];
          if (row) {
            if (row.proof !== input.proof || row.environmentId !== input.environmentId)
              return yield* strengthRequired("unsupported_authentication_flow");
            if (row.status === "complete" && row.outcome) return yield* open(input, row.outcome);
            if (row.status !== "failed")
              return yield* strengthRequired("unsupported_authentication_flow");
          }
          const busy = yield* db.$client`SELECT 1 FROM relay_connect_link_reservations
        WHERE user_id = ${input.userId} AND environment_id = ${input.environmentId} AND status IN ('running', 'recovering', 'withdrawn')`.pipe(
            Effect.mapError(unavailable),
          );
          if (busy.length > 0) return yield* strengthRequired("unsupported_authentication_flow");
          if (input.managedTunnelsEnabled) {
            const quota = yield* db.$client<{ total: number; maximum: number }>`SELECT
          (SELECT count(DISTINCT environment_id)::int FROM (
            SELECT environment_id FROM relay_environment_links WHERE user_id = ${input.userId}
              AND revoked_at IS NULL AND managed_tunnels_enabled = true
            UNION SELECT environment_id FROM relay_connect_link_reservations WHERE user_id = ${input.userId}
              AND status IN ('running', 'recovering', 'withdrawn')
          ) AS occupied WHERE environment_id <> ${input.environmentId}) AS total,
          COALESCE((SELECT max_tunnels FROM relay_managed_tunnel_limits WHERE user_id = ${input.userId}), 3) AS maximum`.pipe(
              Effect.mapError(unavailable),
            );
            if (!quota[0] || quota[0].total >= quota[0].maximum)
              return yield* strengthRequired("unsupported_authentication_flow");
          }
          if (row) {
            yield* db
              .update(relayConnectLinkReservations)
              .set({ status: "running", attemptId: input.attemptId })
              .where(binding(input))
              .pipe(Effect.mapError(unavailable));
            return null;
          }
          yield* consume;
          yield* db
            .insert(relayConnectLinkReservations)
            .values({
              userId: input.userId,
              challengeId: input.challengeId,
              environmentId: input.environmentId,
              proof: input.proof,
              attemptId: input.attemptId,
              status: "running",
            })
            .pipe(Effect.mapError(unavailable));
          return null;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: () => Effect.fail(unavailable()) }));
  });
  const complete: ConnectLinkReservations["Service"]["complete"] = Effect.fn(
    "ConnectLinkReservations.complete",
  )(function* (input, commit) {
    return yield* db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* lock(input.userId);
          yield* authorize(input);
          const rows = yield* db
            .select()
            .from(relayConnectLinkReservations)
            .where(binding(input))
            .pipe(Effect.mapError(unavailable));
          if (
            rows[0]?.status !== "running" ||
            rows[0].proof !== input.proof ||
            rows[0].attemptId !== input.attemptId
          )
            return yield* strengthRequired("unsupported_authentication_flow");
          const result = yield* commit;
          const outcome = yield* seal(input, result);
          yield* db
            .update(relayConnectLinkReservations)
            .set({ status: "complete", outcome })
            .where(binding(input))
            .pipe(Effect.mapError(unavailable));
          return result;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: () => Effect.fail(unavailable()) }));
  });
  // A separate transaction pins the execution lock without rolling back durable provisioning milestones.
  const exclusive: ConnectLinkReservations["Service"]["exclusive"] = Effect.fn(
    "ConnectLinkReservations.exclusive",
  )(function* (userId, use) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* db.$client.reserve.pipe(Effect.mapError(unavailable));
        return yield* Effect.acquireUseRelease(
          connection.executeRaw("BEGIN", []).pipe(Effect.mapError(unavailable)),
          () =>
            Effect.gen(function* () {
              const rows = yield* connection
                .executeValues(
                  "SELECT pg_try_advisory_xact_lock(hashtextextended(current_schema() || ':' || $1, 0)), txid_current()::text",
                  [`connect-link-execution:${userId}`],
                )
                .pipe(Effect.mapError(unavailable));
              if (rows[0]?.[0] !== true) return yield* unavailable();
              const transactionId = rows[0][1];
              const assertOwner = connection.executeValues("SELECT txid_current()::text", []).pipe(
                Effect.mapError(unavailable),
                Effect.flatMap((current) =>
                  current[0]?.[0] === transactionId ? Effect.void : Effect.fail(unavailable()),
                ),
              );
              return yield* use(assertOwner);
            }),
          () => connection.executeRaw("ROLLBACK", []).pipe(Effect.orDie),
        );
      }),
    );
  });
  const recover: ConnectLinkReservations["Service"]["recover"] = Effect.fn(
    "ConnectLinkReservations.recover",
  )(function* (userId, assertOwner, cleanup) {
    const candidates = yield* db.$client<{
      challenge_id: string;
      environment_id: string;
      attempt_id: string | null;
    }>`SELECT challenge_id, environment_id, attempt_id FROM relay_connect_link_reservations
      WHERE user_id = ${userId} AND status IN ('running', 'recovering', 'withdrawn')`.pipe(
      Effect.mapError(unavailable),
    );
    // Only recover identities captured while this execution still owns the account.
    yield* assertOwner;
    // Fence completion durably before touching resources; failed cleanup continues to hold capacity.
    const rows = yield* db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* lock(userId);
          const claimed = yield* Effect.forEach(candidates, (row) =>
            db.$client<typeof row>`UPDATE relay_connect_link_reservations
              SET status = CASE WHEN status = 'running' THEN 'recovering' ELSE status END
              WHERE user_id = ${userId} AND challenge_id = ${row.challenge_id}
                AND attempt_id IS NOT DISTINCT FROM ${row.attempt_id}
                AND status IN ('running', 'recovering', 'withdrawn')
              RETURNING challenge_id, environment_id, attempt_id`.pipe(
              Effect.mapError(unavailable),
            ),
          );
          return claimed.flat();
        }),
      )
      .pipe(Effect.catchTags({ SqlError: () => Effect.fail(unavailable()) }));
    for (const row of rows) {
      yield* cleanup(row.environment_id);
      yield* db.$client`UPDATE relay_connect_link_reservations
          SET status = CASE WHEN status = 'withdrawn' THEN 'cancelled' ELSE 'failed' END
          WHERE user_id = ${userId} AND challenge_id = ${row.challenge_id}
            AND attempt_id IS NOT DISTINCT FROM ${row.attempt_id} AND status IN ('recovering', 'withdrawn')`.pipe(
        Effect.mapError(unavailable),
      );
    }
  });
  const withdraw: ConnectLinkReservations["Service"]["withdraw"] = Effect.fn(
    "ConnectLinkReservations.withdraw",
  )((input, revoke) =>
    db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* lock(input.userId);
          yield* db
            .update(relayConnectLinkReservations)
            .set({
              status: sql`CASE WHEN status IN ('running', 'recovering', 'withdrawn') THEN 'withdrawn' ELSE 'cancelled' END`,
              outcome: null,
            })
            .where(
              and(
                eq(relayConnectLinkReservations.userId, input.userId),
                eq(relayConnectLinkReservations.environmentId, input.environmentId),
              ),
            )
            .pipe(Effect.mapError(unavailable));
          return yield* revoke;
        }),
      )
      .pipe(Effect.catchTags({ SqlError: () => Effect.fail(unavailable()) })),
  );
  return ConnectLinkReservations.of({
    exclusive,
    recover,
    reserve,
    complete,
    withdraw,
    failed: Effect.fn("ConnectLinkReservations.failed")((input) =>
      db
        .update(relayConnectLinkReservations)
        .set({ status: "failed" })
        .where(
          and(
            binding(input),
            eq(relayConnectLinkReservations.attemptId, input.attemptId),
            eq(relayConnectLinkReservations.status, "running"),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(unavailable)),
    ),
  });
});
export const layer = Layer.effect(ConnectLinkReservations, make);
