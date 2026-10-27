import { describe, expect, it } from "@effect/vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as RelayDb from "../db.ts";
import * as ConnectAccounts from "./ConnectAccounts.ts";
import { relayConnectAccounts } from "../persistence/schema.ts";

type Account = typeof relayConnectAccounts.$inferSelect;
const dialect = new PgDialect();
function database(rows: Map<string, Account>) {
  return {
    insert: () => ({
      values: (value: Account) => ({
        onConflictDoNothing: () =>
          Effect.sync(() => {
            if (!rows.has(value.userId)) rows.set(value.userId, value);
          }),
      }),
    }),
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
    "checks persisted generations and never resurrects suspended or deleted accounts",
    () => {
      const rows = new Map<string, Account>();
      return Effect.gen(function* () {
        const accounts = yield* ConnectAccounts.ConnectAccounts;
        expect(yield* accounts.authorize("user-1")).toBe(1);
        rows.set("user-1", { userId: "user-1", generation: 2, status: "active" });
        expect(yield* accounts.check("user-1", 1)).toBe(false);
        expect(yield* accounts.authorize("user-1")).toBe(2);
        for (const status of ["suspended", "deleted"] as const) {
          rows.set("user-1", { userId: "user-1", generation: 3, status });
          expect((yield* accounts.authorize("user-1").pipe(Effect.result))._tag).toBe("Failure");
          expect(yield* accounts.check("user-1", 3)).toBe(false);
          expect(rows.get("user-1")?.status).toBe(status);
        }
        expect(yield* accounts.check("missing-user", 1)).toBe(false);
      }).pipe(
        Effect.provide(ConnectAccounts.layer),
        Effect.provideService(RelayDb.RelayDb, database(rows)),
      );
    },
  );
});
