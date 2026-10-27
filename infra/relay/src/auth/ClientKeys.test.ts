import * as ConnectAccounts from "./ConnectAccounts.ts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as RelayDb from "../db.ts";
import * as ClientKeys from "./ClientKeys.ts";
import { relayClientKeys } from "../persistence/schema.ts";

type Row = typeof relayClientKeys.$inferSelect;
const NOW = 1800000000;
const assurance = {
  policyVersion: 1 as const,
  source: "clerk-session" as const,
  userId: "user-1",
  sessionId: "session-1",
  firstVerifiedAtFloor: NOW - 60,
  secondVerifiedAtFloor: NOW - 60,
  checkedAt: NOW,
  authGeneration: 1,
};
const request = { assurance, clientId: "goat-web", thumbprint: "new-key", now: NOW };
const dialect = new PgDialect();

const memoryDatabase = Effect.fn("test.clientKeys.database")(function* (rows: Row[]) {
  const lock = yield* Semaphore.make(1);
  const client = Object.assign(() => Effect.void, {
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) => lock.withPermits(1)(effect),
  });
  const db = {
    $client: client,
    select: (columns?: object) => ({
      from: () => ({
        where: (condition: SQL) =>
          Effect.sync(() => {
            const params = dialect.sqlToQuery(condition).params;
            const matches = rows.filter(
              (row) =>
                row.userId === params[0] &&
                (params.length < 3
                  ? row.revokedAt === null
                  : row.clientId === params[1] && row.thumbprint === params[2]),
            );
            return columns ? [{ total: matches.length }] : matches.map((row) => ({ ...row }));
          }),
      }),
    }),
    insert: () => ({
      values: (value: Row) => ({
        onConflictDoUpdate: () =>
          Effect.sync(() => {
            const existing = rows.find(
              (row) =>
                row.userId === value.userId &&
                row.clientId === value.clientId &&
                row.thumbprint === value.thumbprint,
            );
            if (existing) Object.assign(existing, value, { revokedAt: null });
            else rows.push({ ...value, revokedAt: null });
          }),
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
  return db;
});

function run<A, E>(rows: Row[], program: Effect.Effect<A, E, ClientKeys.ClientKeys>) {
  return Effect.gen(function* () {
    const db = yield* memoryDatabase(rows);
    return yield* program.pipe(
      Effect.provide(ClientKeys.layer),
      Effect.provideService(ConnectAccounts.ConnectAccounts, {
        authorize: () => Effect.succeed(1),
        check: () => Effect.succeed(true),
      }),
      Effect.provideService(RelayDb.RelayDb, db),
      Effect.provide(NodeCryptoLayer.layer),
    );
  });
}

describe("Connect client-key admission", () => {
  it.effect("concurrent first admissions cannot exceed the account quota", () => {
    const rows: Row[] = Array.from({ length: 19 }, (_, index) => ({
      userId: "user-1",
      clientId: "goat-web",
      thumbprint: `key-${index}`,
      admittedAt: NOW,
      admissionId: `admission-${index}`,
      policyVersion: 1,
      authGeneration: 1,
      revokedAt: null,
    }));
    return run(
      rows,
      Effect.gen(function* () {
        const keys = yield* ClientKeys.ClientKeys;
        const results = yield* Effect.all(
          [
            keys.admit(request).pipe(Effect.result),
            keys.admit({ ...request, thumbprint: "second-key" }).pipe(Effect.result),
          ],
          { concurrency: "unbounded" },
        );
        expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
        expect(rows).toHaveLength(20);
      }),
    );
  });
  it.effect(
    "revoked keys need explicit fresh readmission and old tokens stay revoked in the same second",
    () => {
      const rows: Row[] = [
        {
          userId: "user-1",
          clientId: "goat-web",
          thumbprint: "new-key",
          admittedAt: NOW,
          admissionId: "old-admission",
          policyVersion: 1,
          authGeneration: 1,
          revokedAt: NOW,
        },
      ];
      return run(
        rows,
        Effect.gen(function* () {
          const keys = yield* ClientKeys.ClientKeys;
          expect((yield* keys.admit(request).pipe(Effect.result))._tag).toBe("Failure");
          const admission = yield* keys.admit({ ...request, readmit: true });
          expect(admission.admissionId).not.toBe("old-admission");
          expect(
            yield* keys.check({
              userId: "user-1",
              clientId: "goat-web",
              thumbprint: "new-key",
              admittedAt: NOW,
              admissionId: "old-admission",
              authGeneration: 1,
            }),
          ).toBe(false);
        }),
      );
    },
  );
  it.effect("a stale strong session cannot admit an unfamiliar key", () =>
    run(
      [],
      Effect.gen(function* () {
        const keys = yield* ClientKeys.ClientKeys;
        expect((yield* keys.admit({ ...request, now: NOW + 600 }).pipe(Effect.flip)).reason).toBe(
          "reauthentication_required",
        );
      }),
    ),
  );
});
