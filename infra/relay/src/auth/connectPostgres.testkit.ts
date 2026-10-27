// @effect-diagnostics nodeBuiltinImport:off -- CI database fixtures load the authored SQL migrations.
import * as NodeFSP from "node:fs/promises";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Crypto from "effect/Crypto";
import * as Redacted from "effect/Redacted";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as TestClock from "effect/testing/TestClock";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import * as WebCrypto from "../WebCrypto.ts";
import * as RelayDb from "../db.ts";

const databaseFixture = Layer.effect(
  RelayDb.RelayDb,
  Effect.gen(function* () {
    const url = process.env.CONNECT_TEST_DATABASE_URL;
    if (!url || new URL(url).pathname !== "/connect_test" || new URL(url).hostname !== "127.0.0.1")
      throw new Error("An isolated CONNECT_TEST_DATABASE_URL is required");
    const client = yield* PgClient.PgClient;
    const crypto = yield* Crypto.Crypto;
    const schema = `connect_${(yield* crypto.randomUUIDv4()).replaceAll("-", "")}`;
    yield* client.unsafe(`CREATE SCHEMA "${schema}"`);
    yield* Effect.addFinalizer(() =>
      client.unsafe(`DROP SCHEMA "${schema}" CASCADE`).pipe(Effect.orDie),
    );

    // Every connection in this pool uses the fixture schema, including concurrent transactions.
    const scoped = yield* PgClient.make({
      url: Redacted.make(url),
      startupOptions: `-c search_path=${schema}`,
    }).pipe(TestClock.withLive);
    const migrationsRoot = new URL("../../migrations/postgres/", import.meta.url);
    const migrations = (yield* Effect.promise(() => NodeFSP.readdir(migrationsRoot))).sort();
    for (const name of migrations) {
      const sql = yield* Effect.promise(() =>
        NodeFSP.readFile(new URL(`${name}/migration.sql`, migrationsRoot), "utf8"),
      );
      for (const statement of sql
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean))
        yield* scoped.unsafe(statement);
    }
    return yield* PgDrizzle.makeWithDefaults().pipe(
      Effect.provideService(PgClient.PgClient, scoped),
    );
  }),
).pipe(
  Layer.provide(Reactivity.layer),
  Layer.provide(NodeCrypto.layer),
  Layer.provideMerge(Layer.succeed(WebCrypto.WebCrypto, { subtle: globalThis.crypto.subtle })),
  Layer.provide(
    // Pool idle timers must not replay decades when auth tests advance their TestClock.
    Layer.effect(
      PgClient.PgClient,
      PgClient.make({
        url: Redacted.make(
          process.env.CONNECT_TEST_DATABASE_URL ?? "postgres://localhost/connect_test",
        ),
      }).pipe(TestClock.withLive),
    ).pipe(Layer.provide(Reactivity.layer)),
  ),
);

export const postgresFixture = Layer.mergeAll(
  ConnectAccounts.layer,
  RelayDb.RelayTransactions.layer,
).pipe(Layer.provideMerge(databaseFixture));

export const awaitPostgresMilestone = Effect.fn("test.awaitPostgresMilestone")(function* <A, E>(
  milestone: Deferred.Deferred<void>,
  worker: Fiber.Fiber<A, E>,
) {
  return yield* Effect.raceFirst(
    Deferred.await(milestone),
    Fiber.join(worker).pipe(
      Effect.andThen(Effect.die("PostgreSQL worker exited before reaching its milestone")),
    ),
  );
});
