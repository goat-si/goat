import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ClientKeys from "./ClientKeys.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as RelayDb from "../db.ts";
import { postgresFixture } from "./connectPostgres.testkit.ts";

const now = 1800000000;
const assurance = {
  policyVersion: 1 as const,
  source: "clerk-session" as const,
  userId: "account",
  sessionId: "session",
  firstVerifiedAtFloor: now - 60,
  secondVerifiedAtFloor: now - 60,
  checkedAt: now,
  authGeneration: 1,
};
const request = {
  assurance,
  clientId: "goat-mobile",
  thumbprint: "retained-secure-store-key",
  now,
};
const layer = ClientKeys.layer.pipe(
  Layer.provideMerge(ConnectAccounts.layer),
  Layer.provideMerge(postgresFixture),
  Layer.provide(NodeCrypto.layer),
);

it.effect("PostgreSQL admissions enforce the real per-account quota, uniqueness and rollback", () =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const accounts = yield* ConnectAccounts.ConnectAccounts;
    const keys = yield* ClientKeys.ClientKeys;
    yield* accounts.authorize("account");
    const results = yield* Effect.all(
      Array.from({ length: 21 }, (_, i) =>
        keys.admit({ ...request, thumbprint: `key-${i}` }).pipe(Effect.result),
      ),
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result._tag === "Success")).toHaveLength(20);
    expect((yield* db.$client`SELECT * FROM relay_client_keys`).length).toBe(20);
    expect(
      (yield* db.$client`INSERT INTO relay_client_keys SELECT * FROM relay_client_keys LIMIT 1`.pipe(
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    yield* accounts.authorize("rollback");
    yield* db.$client
      .withTransaction(
        keys
          .admit({ ...request, assurance: { ...assurance, userId: "rollback" } })
          .pipe(Effect.andThen(Effect.fail("rollback"))),
      )
      .pipe(Effect.result);
    expect(
      (yield* db.$client`SELECT * FROM relay_client_keys WHERE user_id = 'rollback'`).length,
    ).toBe(0);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "retained native key requires explicit fresh readmission and old admissions remain revoked",
  () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* (yield* ConnectAccounts.ConnectAccounts).authorize("account");
      const keys = yield* ClientKeys.ClientKeys;
      const first = yield* keys.admit(request);
      yield* db.$client`UPDATE relay_client_keys SET revoked_at = ${now}`;
      expect((yield* keys.admit(request).pipe(Effect.result))._tag).toBe("Failure");
      expect(
        (yield* keys.admit({ ...request, readmit: true, now: now + 600 }).pipe(Effect.result))._tag,
      ).toBe("Failure");
      const next = yield* keys.admit({ ...request, readmit: true });
      expect(next.admissionId).not.toBe(first.admissionId);
      expect(
        yield* keys.check({
          userId: "account",
          clientId: request.clientId,
          thumbprint: request.thumbprint,
          authGeneration: 1,
          admittedAt: first.authorizedAt,
          admissionId: first.admissionId,
        }),
      ).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect("account suspension serialized by PostgreSQL prevents an overlapping admission", () =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* (yield* ConnectAccounts.ConnectAccounts).authorize("account");
    const keys = yield* ClientKeys.ClientKeys;
    const locked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const suspension = yield* db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended('account', 0))`;
          yield* Deferred.succeed(locked, undefined);
          yield* Deferred.await(release);
          yield* db.$client`UPDATE relay_connect_accounts SET status = 'suspended', generation = 2 WHERE user_id = 'account'`;
        }),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(locked);
    const admission = yield* keys.admit(request).pipe(Effect.result, Effect.forkChild);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(suspension);
    expect((yield* Fiber.join(admission))._tag).toBe("Failure");
    expect((yield* db.$client`SELECT * FROM relay_client_keys`).length).toBe(0);
  }).pipe(Effect.provide(layer)),
);

it.effect("database failure cannot become successful key admission", () =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    yield* (yield* ConnectAccounts.ConnectAccounts).authorize("account");
    yield* db.$client`ALTER TABLE relay_client_keys RENAME TO unavailable_client_keys`;
    expect((yield* (yield* ClientKeys.ClientKeys).admit(request).pipe(Effect.flip))._tag).toBe(
      "RelayInternalError",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "admission itself takes the PostgreSQL account lock without locking unrelated accounts",
  () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      yield* (yield* ConnectAccounts.ConnectAccounts).authorize("account");
      const keys = yield* ClientKeys.ClientKeys;
      const admitted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const transaction = yield* db.$client
        .withTransaction(
          Effect.gen(function* () {
            yield* keys.admit(request);
            yield* Deferred.succeed(admitted, undefined);
            yield* Deferred.await(release);
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(admitted);
      yield* db.$client.withTransaction(
        Effect.gen(function* () {
          const held = yield* db.$client<{
            acquired: boolean;
          }>`SELECT pg_try_advisory_xact_lock(hashtextextended('account', 0)) AS acquired`;
          const separate = yield* db.$client<{
            acquired: boolean;
          }>`SELECT pg_try_advisory_xact_lock(hashtextextended('different-account', 0)) AS acquired`;
          expect(held[0]?.acquired).toBe(false);
          expect(separate[0]?.acquired).toBe(true);
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transaction);
    }).pipe(Effect.provide(layer)),
);
