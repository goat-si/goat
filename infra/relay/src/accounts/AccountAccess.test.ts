import { testConfig } from "./test/PolicyPostgresLayers.ts";
import * as RelayConfiguration from "../Config.ts";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AccountAccess from "./AccountAccess.ts";
import { RelayDb } from "../db.ts";
import { createPostgresFixture } from "./test/PostgresFixture.ts";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Drizzle from "drizzle-orm/effect-postgres";

it.live("denies absent users and stale epochs across suspend and allow without a cache", () =>
  Effect.gen(function* () {
    using pg = createPostgresFixture();
    pg.migrate();
    const layer = PgClient.layer({
      host: pg.socket,
      username: "relay_test",
      database: "postgres",
      prepare: false,
    }).pipe(Layer.provideMerge(Layer.empty));
    const dbLayer = Layer.effect(RelayDb, Drizzle.makeWithDefaults()).pipe(Layer.provide(layer));
    yield* Effect.gen(function* () {
      const access = yield* AccountAccess.AccountAccess;
      expect((yield* Effect.flip(access.capture("fixture")))._tag).toBe(
        "RelayAccountAccessDeniedError",
      );
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('fixture','allowed',1)",
      );
      expect((yield* access.capture("fixture")).accountEpoch).toBe(1);
      pg.query("UPDATE relay_account_access SET status='suspended',account_epoch=2");
      expect(
        (yield* Effect.flip(access.requireAllowed({ userId: "fixture", accountEpoch: 1 })))._tag,
      ).toBe("RelayAccountAccessDeniedError");
      pg.query("UPDATE relay_account_access SET status='allowed',account_epoch=3");
      expect(
        (yield* Effect.flip(access.requireAllowed({ userId: "fixture", accountEpoch: 1 })))._tag,
      ).toBe("RelayAccountEpochStaleError");
    }).pipe(
      Effect.provide(
        AccountAccess.layer.pipe(
          Layer.provide(dbLayer),
          Layer.provide(RelayConfiguration.layer(testConfig)),
        ),
      ),
    );
  }),
);
