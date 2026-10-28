import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Statement from "effect/sql/Statement";
import * as ClientKeys from "./ClientKeys.ts";
import * as RelayDb from "../db.ts";
import * as Configuration from "../Config.ts";
import { AccountLifecycle } from "../accounts/AccountLifecycle.ts";
import { subjectDigest } from "../accounts/SubjectDigest.ts";
import { testConfig } from "../accounts/test/PolicyPostgresLayers.ts";
import {
  allowAccount,
  awaitPostgresMilestone,
  postgresFixture,
  postgresPolicyFixture,
} from "./connectPostgres.testkit.ts";

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
  Layer.provideMerge(postgresPolicyFixture),
  Layer.provideMerge(postgresFixture),
  Layer.provideMerge(Configuration.layer(testConfig)),
  Layer.provide(NodeCrypto.layer),
);

it.effect("PostgreSQL admissions enforce the real per-account quota, uniqueness and rollback", () =>
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDb;
    const keys = yield* ClientKeys.ClientKeys;
    yield* allowAccount("account");
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
    yield* allowAccount("rollback");
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
      yield* allowAccount("account");
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
    yield* allowAccount("account");
    const keys = yield* ClientKeys.ClientKeys;
    const digest = yield* subjectDigest("account");
    const locked = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const suspension = yield* db.$client
      .withTransaction(
        Effect.gen(function* () {
          yield* db.$client`SELECT pg_advisory_xact_lock(hashtextextended(${`relay:account:${digest}`}, 0))`;
          yield* Deferred.succeed(locked, undefined);
          yield* Deferred.await(release);
          yield* db.$client`UPDATE relay_account_access SET status = 'suspended', account_epoch = 2 WHERE user_id = 'account'`;
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
    yield* allowAccount("account");
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
      yield* allowAccount("account");
      const keys = yield* ClientKeys.ClientKeys;
      const digest = yield* subjectDigest("account");
      const separateDigest = yield* subjectDigest("different-account");
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
          }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`relay:account:${digest}`}, 0)) AS acquired`;
          const separate = yield* db.$client<{
            acquired: boolean;
          }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`relay:account:${separateDigest}`}, 0)) AS acquired`;
          expect(held[0]?.acquired).toBe(false);
          expect(separate[0]?.acquired).toBe(true);
        }),
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transaction);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "account erasure cannot finish ahead of an authorized admission and leave a client key",
  () =>
    Effect.gen(function* () {
      const db = yield* RelayDb.RelayDb;
      const keys = yield* ClientKeys.ClientKeys;
      const lifecycle = yield* AccountLifecycle;
      yield* allowAccount("account");
      const digest = yield* subjectDigest("account");
      const inserting = yield* Deferred.make<void>();
      const releaseAdmission = yield* Deferred.make<void>();
      const admission = yield* keys.admit(request).pipe(
        Effect.provideService(Statement.CurrentTransformer, (statement) =>
          statement.compile()[0].startsWith('insert into "relay_client_keys"')
            ? Deferred.succeed(inserting, undefined).pipe(
                Effect.andThen(Deferred.await(releaseAdmission)),
                Effect.as(statement),
              )
            : Effect.succeed(statement),
        ),
        Effect.forkChild,
      );
      yield* awaitPostgresMilestone(inserting, admission);
      const deleting = yield* Deferred.make<void>();
      const releaseDeletion = yield* Deferred.make<void>();
      let paused = false;
      const deletion = yield* lifecycle
        .requestDelete({ userId: "account", idempotencyKey: "erase-during-admission" })
        .pipe(
          Effect.flatMap((result) =>
            result.status === "progress"
              ? lifecycle.resume(result.operationId)
              : Effect.die("Expected a new deletion operation"),
          ),
          Effect.provideService(Statement.CurrentTransformer, (statement) => {
            if (!paused && statement.compile()[0].includes("SELECT pg_advisory_xact_lock")) {
              paused = true;
              return Deferred.succeed(deleting, undefined).pipe(
                Effect.andThen(Deferred.await(releaseDeletion)),
                Effect.as(statement),
              );
            }
            return Effect.succeed(statement);
          }),
          Effect.forkChild,
        );
      yield* awaitPostgresMilestone(deleting, deletion);
      const [probe] = yield* db.$client.withTransaction(
        db.$client<{
          acquired: boolean;
        }>`SELECT pg_try_advisory_xact_lock(hashtextextended(${`relay:account:${digest}`}, 0)) AS acquired`,
      );
      // Let erasure finish first when the fence is missing, reproducing resurrection without a timeout.
      if (probe?.acquired === true) {
        yield* Deferred.succeed(releaseDeletion, undefined);
        yield* Fiber.join(deletion);
        yield* Deferred.succeed(releaseAdmission, undefined);
      } else {
        yield* Deferred.succeed(releaseDeletion, undefined);
        yield* Deferred.succeed(releaseAdmission, undefined);
      }
      yield* Fiber.join(admission);
      expect((yield* Fiber.join(deletion)).state).toBe("completed");
      expect(
        yield* db.$client`SELECT * FROM relay_client_keys WHERE user_id = 'account'`,
      ).toHaveLength(0);
      expect((yield* keys.admit(request).pipe(Effect.flip)).reason).toBe("session_not_active");
      const [erased] = yield* db.$client<{
        status: string;
        user_id: string | null;
      }>`SELECT status, user_id FROM relay_account_access WHERE subject_digest = ${digest}`;
      expect(erased).toMatchObject({ status: "deleted", user_id: null });
    }).pipe(Effect.provide(layer)),
);
