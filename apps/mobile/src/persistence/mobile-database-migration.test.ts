import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LEGACY_MOBILE_DATABASE_NAME } from "@goat/contracts/legacyT3Names";

const native = vi.hoisted(() => {
  const files = new Set<string>();
  const events: string[] = [];
  const databases = new Map<
    string,
    { name: string; closeAsync: () => Promise<void>; execAsync: (sql: string) => Promise<void> }
  >();
  return {
    files,
    events,
    databases,
    backup: vi.fn(async () => {
      events.push("backup");
    }),
    open: vi.fn(async (name: string) => {
      events.push(`open:${name}`);
      files.add(name);
      const database = {
        name,
        closeAsync: async () => {
          events.push(`close:${name}`);
        },
        execAsync: async (sql: string) => {
          events.push(`exec:${sql}`);
        },
      };
      databases.set(name, database);
      return database;
    }),
  };
});

vi.mock("expo-sqlite", () => ({
  defaultDatabaseDirectory: "file:///sqlite",
  openDatabaseAsync: native.open,
  backupDatabaseAsync: native.backup,
}));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(
      _path: string,
      readonly name: string,
    ) {}
    get exists() {
      return native.files.has(this.name);
    }
    delete() {
      native.events.push(`delete:${this.name}`);
      native.files.delete(this.name);
    }
    move(target: { name: string }) {
      native.events.push(`move:${target.name}`);
      native.files.delete(this.name);
      native.files.add(target.name);
    }
  },
}));

import { openMigratedMobileDatabase } from "./mobile-database-migration";

beforeEach(() => {
  native.files.clear();
  native.events.length = 0;
  native.databases.clear();
  native.open.mockClear();
  native.backup.mockReset().mockImplementation(async () => {
    native.events.push("backup");
  });
});

describe("mobile SQLite namespace copy", () => {
  it("backs up before publishing, closes both databases, and keeps the source", async () => {
    native.files.add(LEGACY_MOBILE_DATABASE_NAME);
    await openMigratedMobileDatabase();
    expect(native.backup).toHaveBeenCalledWith({
      sourceDatabase: native.databases.get(LEGACY_MOBILE_DATABASE_NAME),
      destDatabase: native.databases.get("goat-client.db.migration"),
    });
    expect(native.events).toEqual([
      `open:${LEGACY_MOBILE_DATABASE_NAME}`,
      "open:goat-client.db.migration",
      "backup",
      "exec:PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;",
      "close:goat-client.db.migration",
      `close:${LEGACY_MOBILE_DATABASE_NAME}`,
      "move:goat-client.db",
      "open:goat-client.db",
    ]);
    expect(native.files.has(LEGACY_MOBILE_DATABASE_NAME)).toBe(true);
    native.events.length = 0;
    await openMigratedMobileDatabase();
    expect(native.events).toEqual(["open:goat-client.db"]);
    expect(native.backup).toHaveBeenCalledTimes(1);
  });

  it("retries a failed unpublished backup and closes both handles", async () => {
    native.files.add(LEGACY_MOBILE_DATABASE_NAME);
    native.backup.mockRejectedValueOnce(new Error("interrupted"));
    await expect(openMigratedMobileDatabase()).rejects.toThrow("interrupted");
    expect(native.files.has("goat-client.db")).toBe(false);
    expect(native.files.has(LEGACY_MOBILE_DATABASE_NAME)).toBe(true);
    expect(native.events).toContain("close:goat-client.db.migration");
    expect(native.events).toContain(`close:${LEGACY_MOBILE_DATABASE_NAME}`);
    native.files.add("goat-client.db.migration-wal");
    native.files.add("goat-client.db.migration-shm");
    await openMigratedMobileDatabase();
    expect(native.events).toContain("delete:goat-client.db.migration");
    expect(native.events).toContain("delete:goat-client.db.migration-wal");
    expect(native.events).toContain("delete:goat-client.db.migration-shm");
    expect(native.files.has("goat-client.db")).toBe(true);
    expect(native.backup).toHaveBeenCalledTimes(2);
  });

  it("opens an existing GOAT database without touching the legacy database", async () => {
    native.files.add("goat-client.db");
    native.files.add(LEGACY_MOBILE_DATABASE_NAME);
    await openMigratedMobileDatabase();
    expect(native.events).toEqual(["open:goat-client.db"]);
    expect(native.backup).not.toHaveBeenCalled();
  });

  it("creates only the GOAT database on a fresh install", async () => {
    await openMigratedMobileDatabase();
    expect([...native.files]).toEqual(["goat-client.db"]);
    expect(native.backup).not.toHaveBeenCalled();
  });
});
