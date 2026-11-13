import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as AuthSessions from "./AuthSessions.ts";
import { runMigrations } from "./Migrations.ts";

it.effect("member rows stay revoked to old readers while new readers can revoke them", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const repository = yield* AuthSessions.make;
    const issuedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const expiresAt = DateTime.makeUnsafe("2027-01-01T00:00:00.000Z");
    const sessionId = AuthSessionId.make("member");
    yield* repository.create({
      sessionId,
      subject: `pen-member:${"a".repeat(26)}`,
      penMemberNode: "a".repeat(26),
      scopes: ["orchestration:read"],
      method: "bearer-access-token",
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "bot",
        os: null,
        browser: null,
      },
      issuedAt,
      expiresAt,
      principalKind: "person",
    });
    const ordinary = AuthSessionId.make("ordinary");
    yield* repository.create({
      sessionId: ordinary,
      subject: "browser",
      scopes: ["orchestration:read"],
      method: "bearer-access-token",
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "bot",
        os: null,
        browser: null,
      },
      issuedAt,
      expiresAt,
      principalKind: "person",
    });
    expect(yield* sql`SELECT session_id FROM auth_sessions WHERE revoked_at IS NULL`).toEqual([
      { session_id: ordinary },
    ]);
    const old = yield* sql<{
      readonly revokedAt: string | null;
    }>`SELECT revoked_at AS "revokedAt" FROM auth_sessions WHERE session_id = ${sessionId}`;
    expect(old[0]?.revokedAt).not.toBeNull();
    expect(
      new Set((yield* repository.listActive({ now: issuedAt })).map((row) => row.sessionId)),
    ).toEqual(new Set([sessionId, ordinary]));
    const active = yield* repository.getById({ sessionId });
    expect(Option.isSome(active) && active.value.revokedAt).toBeNull();
    expect(yield* repository.revoke({ sessionId, revokedAt: expiresAt })).toBe(true);
    const stored = yield* sql<{
      readonly revokedAt: string;
      readonly memberRevokedAt: string | null;
    }>`SELECT revoked_at AS "revokedAt", pen_member_revoked_at AS "memberRevokedAt" FROM auth_sessions WHERE session_id = ${sessionId}`;
    expect(stored[0]?.revokedAt).toBe(old[0]?.revokedAt);
    expect(stored[0]?.memberRevokedAt).not.toBeNull();
    expect((yield* repository.listActive({ now: issuedAt })).map((row) => row.sessionId)).toEqual([
      ordinary,
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("replacement, bulk revocation and Pen cleanup use the effective revocation", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const repository = yield* AuthSessions.make;
    const issuedAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
    const revokedAt = DateTime.makeUnsafe("2026-02-01T00:00:00.000Z");
    const expiresAt = DateTime.makeUnsafe("2027-01-01T00:00:00.000Z");
    const input = (id: string) => ({
      sessionId: AuthSessionId.make(id),
      subject: `pen-member:${"a".repeat(26)}`,
      penMemberNode: "a".repeat(26),
      scopes: ["orchestration:read"] as const,
      method: "bearer-access-token" as const,
      client: {
        label: null,
        ipAddress: null,
        userAgent: null,
        deviceType: "bot" as const,
        os: null,
        browser: null,
      },
      issuedAt,
      expiresAt,
      principalKind: "outside_client" as const,
      penBinding: { meshId: "mesh", nodeId: "node", signPub: "sign", noisePub: "noise" },
    });
    yield* repository.create(input("old"));
    expect(yield* repository.deleteInactivePenBound({ now: revokedAt })).toBe(0);
    expect(yield* repository.createReplacingActive({ session: input("new"), revokedAt })).toEqual([
      AuthSessionId.make("old"),
    ]);
    expect(
      yield* repository.revokeAllExcept({
        currentSessionId: AuthSessionId.make("other"),
        revokedAt,
      }),
    ).toEqual([AuthSessionId.make("new")]);
    const rows = yield* sql<{
      readonly revokedAt: string;
      readonly memberRevokedAt: string | null;
    }>`SELECT revoked_at AS "revokedAt", pen_member_revoked_at AS "memberRevokedAt" FROM auth_sessions`;
    expect(
      rows.every((row) => row.revokedAt !== row.memberRevokedAt && row.memberRevokedAt !== null),
    ).toBe(true);
    expect(yield* repository.deleteInactivePenBound({ now: revokedAt })).toBe(2);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
