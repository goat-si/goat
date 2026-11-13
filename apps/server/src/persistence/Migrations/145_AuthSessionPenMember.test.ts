import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("preserves existing sessions and prevents changing a member marker", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 144 });
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, client_device_type) VALUES ('ordinary', 'browser', '[]', 'bearer-access-token', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'unknown')`;
    expect(yield* runMigrations({ toMigrationInclusive: 145 })).toEqual([
      [145, "AuthSessionPenMember"],
    ]);
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at, client_device_type, pen_member_node) VALUES ('member', 'pen-member:aaaaaaaaaaaaaaaaaaaaaaaaaa', '[]', 'bearer-access-token', '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'unknown', 'aaaaaaaaaaaaaaaaaaaaaaaaaa')`;
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          sql`UPDATE auth_sessions SET pen_member_node = 'aaaaaaaaaaaaaaaaaaaaaaaaaa' WHERE session_id = 'ordinary'`,
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          sql`UPDATE auth_sessions SET pen_member_node = NULL WHERE session_id = 'member'`,
        ),
      ),
    ).toBe(true);
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          sql`UPDATE auth_sessions SET pen_member_node = 'bbbbbbbbbbbbbbbbbbbbbbbbbb' WHERE session_id = 'member'`,
        ),
      ),
    ).toBe(true);
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-02-01T00:00:00.000Z' WHERE session_id = 'ordinary'`;
    expect(
      yield* sql`SELECT pen_member_node FROM auth_sessions WHERE session_id = 'ordinary'`,
    ).toEqual([{ pen_member_node: null }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
