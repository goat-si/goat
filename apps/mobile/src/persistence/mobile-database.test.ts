import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("./mobile-database-migration", () => ({ openMigratedMobileDatabase: openDatabaseAsync }));

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import * as MobileDatabase from "./mobile-database";

describe("mobile database legacy cache migration", () => {
  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(MobileDatabase.decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      MobileDatabase.decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});

describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@goat/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@goat/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );
});

describe("durable notes outbox migration", () => {
  const environmentId = "notes-hub" as import("@goat/contracts").EnvironmentId;
  async function versionOneDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec(`PRAGMA user_version = 1;
      CREATE TABLE client_preferences (singleton INTEGER PRIMARY KEY, payload TEXT NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO client_preferences VALUES (1, '{"theme":"dark"}', 123);`);
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }
  it.effect(
    "upgrades v1 without losing preferences and preserves drafts through every cache clear",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sqlite = yield* Effect.promise(versionOneDatabase);
          const database = yield* MobileDatabase.make;
          expect(sqlite.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
          expect(yield* database.loadPreferencesJson).toEqual(
            Option.some({ payload: '{"theme":"dark"}', updatedAt: 123 }),
          );
          const pending = JSON.stringify({
            body: "pending",
            baseRevision: null,
            localUpdatedAt: 100,
            state: "pending",
          });
          const conflict = JSON.stringify({
            body: "conflicted",
            baseRevision: "original",
            current: { body: "theirs" },
            localUpdatedAt: 101,
            state: "conflict",
          });
          yield* database.saveNoteOutbox(environmentId, "note.md", pending, 100);
          yield* database.saveNoteOutbox(environmentId, "project/note.md", conflict, 101);
          yield* database.saveCache(environmentId, "thread", "cached-thread", 1, "cached");
          yield* database.clearCacheKind(environmentId, "thread");
          yield* database.clearEnvironmentCache(environmentId);
          yield* database.clearAllCaches;
          expect(yield* database.loadNoteOutbox).toEqual([pending, conflict]);
          expect(yield* database.inspectCaches).toEqual([]);
        }),
      ),
  );
  it.effect(
    "coalesces only matching environment/path rows and removes only the acknowledged note",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.promise(versionOneDatabase);
          const database = yield* MobileDatabase.make;
          yield* database.saveNoteOutbox(environmentId, "note.md", "first", 1);
          yield* database.saveNoteOutbox("another-hub", "note.md", "other", 2);
          yield* database.saveNoteOutbox(environmentId, "note.md", "newer", 3);
          expect(yield* database.loadNoteOutbox).toEqual(["other", "newer"]);
          yield* database.removeNoteOutbox(environmentId, "note.md");
          expect(yield* database.loadNoteOutbox).toEqual(["other"]);
        }),
      ),
  );
});
