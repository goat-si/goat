import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as RelayDb from "../db.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";

interface Account {
  readonly status: "allowed" | "suspended";
  readonly accountEpoch: number;
}
const dialect = new PgDialect();
function database(rows: Map<string, Account>) {
  return {
    insert: () => {
      throw new Error("Connect sessions must not create account access rows");
    },
    select: () => ({
      from: () => ({
        where: (condition: SQL) =>
          Effect.sync(() => {
            const userId = dialect.sqlToQuery(condition).params[0];
            const row = typeof userId === "string" ? rows.get(userId) : undefined;
            return row ? [{ ...row }] : [];
          }),
      }),
    }),
  } as unknown as RelayDb.RelayDb["Service"];
}
describe("Connect account authorization generation", () => {
  it.effect(
    "uses the relay access epoch, admits only the current allowed epoch, and never invites or resurrects accounts",
    () => {
      const rows = new Map<string, Account>();
      return Effect.gen(function* () {
        const accounts = yield* ConnectAccounts.ConnectAccounts;
        expect(yield* accounts.authorize("user-1")).toBe(0);
        expect(yield* accounts.check("user-1", 0)).toBe(false);
        expect(rows.has("user-1")).toBe(false);
        rows.set("user-1", { status: "allowed", accountEpoch: 2 });
        expect(yield* accounts.authorize("user-1")).toBe(2);
        expect(yield* accounts.check("user-1", 1)).toBe(false);
        expect(yield* accounts.check("user-1", 2)).toBe(true);
        rows.set("user-1", { status: "suspended", accountEpoch: 3 });
        expect(yield* accounts.authorize("user-1")).toBe(3);
        expect(yield* accounts.check("user-1", 3)).toBe(false);
        expect(rows.get("user-1")?.status).toBe("suspended");
        expect(yield* accounts.check("missing-user", 1)).toBe(false);
      }).pipe(
        Effect.provide(ConnectAccounts.layer),
        Effect.provideService(RelayDb.RelayDb, database(rows)),
      );
    },
  );
});
