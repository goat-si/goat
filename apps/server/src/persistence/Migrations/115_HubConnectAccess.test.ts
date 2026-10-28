import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "upgrades populated pre-generation credentials without blessing or deleting legacy rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 114 });
      for (const [id, subject, scopes] of [
        ["privileged", "cloud-connect", '["hub:proxy"]'],
        ["ordinary", "paired", '["orchestration:read"]'],
      ]) {
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, client_device_type) VALUES (${id}, ${subject}, ${scopes}, 'bearer-access-token', '2026-10-28T00:00:00.000Z', '2027-10-28T00:00:00.000Z', 'unknown')`;
        yield* sql`INSERT INTO auth_pairing_links (id, credential, method, scopes, subject, created_at, expires_at) VALUES (${id}, ${id}, 'one-time-token', ${scopes}, ${subject}, '2026-10-28T00:00:00.000Z', '2027-10-28T00:00:00.000Z')`;
      }
      expect(yield* runMigrations({ toMigrationInclusive: 115 })).toEqual([
        [115, "HubConnectAccess"],
      ]);
      expect(yield* sql`SELECT * FROM hub_connect_access`).toEqual([
        { id: 1, generation: 0, allowed: 0 },
      ]);
      for (const table of ["auth_sessions", "auth_pairing_links"]) {
        const rows = yield* sql.unsafe(
          `SELECT subject, connect_access_generation FROM ${table} ORDER BY subject`,
        );
        expect(rows).toEqual([
          { subject: "cloud-connect", connect_access_generation: null },
          { subject: "paired", connect_access_generation: null },
        ]);
      }
      expect(yield* runMigrations()).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
