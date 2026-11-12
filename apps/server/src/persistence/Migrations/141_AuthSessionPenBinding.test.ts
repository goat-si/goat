import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect(
  "keeps every existing session's kind: mcp-client is an outside client, all else a person",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 140 });
      for (const [id, subject] of [
        ["bootstrap", "desktop-bootstrap"],
        ["browser", "browser"],
        ["hub", "hub-proxy"],
        ["mcp", "mcp-client"],
      ]) {
        yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, client_device_type) VALUES (${id}, ${subject}, '["orchestration:read"]', 'bearer-access-token', '2026-10-28T00:00:00.000Z', '2027-10-28T00:00:00.000Z', 'unknown')`;
      }
      expect(yield* runMigrations({ toMigrationInclusive: 141 })).toEqual([
        [141, "AuthSessionPenBinding"],
      ]);
      expect(
        yield* sql`SELECT subject, principal_kind, pen_node_id FROM auth_sessions ORDER BY subject`,
      ).toEqual([
        { subject: "browser", principal_kind: "person", pen_node_id: null },
        { subject: "desktop-bootstrap", principal_kind: "person", pen_node_id: null },
        { subject: "hub-proxy", principal_kind: "person", pen_node_id: null },
        { subject: "mcp-client", principal_kind: "outside_client", pen_node_id: null },
      ]);
      // A session's principal and binding are never rewritten after issue.
      const rewrite = yield* Effect.exit(
        sql`UPDATE auth_sessions SET principal_kind = 'person' WHERE session_id = 'mcp'`,
      );
      expect(Exit.isFailure(rewrite)).toBe(true);
      // Revocation and other columns stay writable.
      yield* sql`UPDATE auth_sessions SET revoked_at = '2026-11-01T00:00:00.000Z' WHERE session_id = 'mcp'`;
      expect(yield* runMigrations({ toMigrationInclusive: 141 })).toEqual([]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
