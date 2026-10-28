import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "upgrading legacy pairing links does not grant Connect trust and rerunning preserves them",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 111 });
      yield* sql`INSERT INTO auth_pairing_links
      (id, credential, method, scopes, subject, created_at, expires_at)
      VALUES ('legacy', 'synthetic-credential', 'link', '["memory:read"]', 'cloud-connect', '2026-10-15', '2026-10-16')`;
      const legacy = yield* sql`SELECT * FROM auth_pairing_links`;

      assert.deepStrictEqual(yield* runMigrations(), [[112, "ConnectLinkTrust"]]);
      assert.deepStrictEqual(yield* sql`SELECT * FROM connect_link_trust`, [
        { singleton: 1, generation: 0, policy_version: null, user_id: null },
      ]);
      const upgraded = yield* sql`SELECT * FROM auth_pairing_links`;
      assert.deepStrictEqual(
        upgraded,
        legacy.map((row) => ({
          ...row,
          connect_policy_version: null,
          connect_link_generation: null,
        })),
      );
      yield* sql`UPDATE connect_link_trust SET generation = 1, policy_version = 1, user_id = 'account'`;
      const trust = yield* sql`SELECT * FROM connect_link_trust`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* sql`SELECT * FROM auth_pairing_links`, upgraded);
      assert.deepStrictEqual(yield* sql`SELECT * FROM connect_link_trust`, trust);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
