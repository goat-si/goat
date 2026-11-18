import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { LEGACY_MOBILE_DATABASE_NAME } from "@goat/contracts/legacyT3Names";

// Files by decoded absolute path, with their contents. Android's File rejects a path with no
// scheme ("URI is not absolute") as soon as it touches the disk; moving runs natively after JS
// continues, and fails if the target exists by then.
const native = vi.hoisted(() => {
  const files = new Map<string, string>();
  const events: string[] = [];
  const directory = { value: "file:///sqlite" };
  // How the next publishing move ends: done, copied partly then interrupted, or refused untouched.
  const nextMove = { value: "done" as "done" | "partial" | "refused" };
  // Files whose next delete fails, as a native delete that reports it could not remove the file.
  const failDelete = new Set<string>();
  const pathOf = (name: string) =>
    `${decodeURIComponent(directory.value.replace(/^file:\/\//, ""))}/${name}`;
  const databases = new Map<
    string,
    { name: string; closeAsync: () => Promise<void>; execAsync: (sql: string) => Promise<void> }
  >();
  return {
    files,
    events,
    directory,
    nextMove,
    failDelete,
    pathOf,
    databases,
    backup: vi.fn(
      async (_databases: { sourceDatabase: { name: string }; destDatabase: { name: string } }) => {
        events.push("backup");
      },
    ),
    open: vi.fn(async (name: string) => {
      events.push(`open:${name}`);
      if (!files.has(pathOf(name))) files.set(pathOf(name), "");
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

const copyBackup = async (databases: {
  sourceDatabase: { name: string };
  destDatabase: { name: string };
}) => {
  native.events.push("backup");
  native.files.set(
    native.pathOf(databases.destDatabase.name),
    native.files.get(native.pathOf(databases.sourceDatabase.name)) ?? "",
  );
};

vi.mock("expo-sqlite", () => ({
  get defaultDatabaseDirectory() {
    return native.directory.value;
  },
  openDatabaseAsync: native.open,
  backupDatabaseAsync: native.backup,
}));
vi.mock("expo-file-system", () => {
  const join = (parent: string | { uri: string }, name: string) =>
    `${(typeof parent === "string" ? parent : parent.uri).replace(/\/$/, "")}/${name}`;
  const diskPath = (uri: string) => {
    if (!/^file:/.test(uri)) throw new Error("URI is not absolute");
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  };
  return {
    Directory: class {
      constructor(readonly uri: string) {}
    },
    File: class {
      readonly uri: string;
      constructor(
        parent: string | { uri: string },
        readonly name: string,
      ) {
        this.uri = join(parent, name);
      }
      get exists() {
        return native.files.has(diskPath(this.uri));
      }
      create() {
        native.events.push(`create:${this.name}`);
        native.files.set(diskPath(this.uri), "");
      }
      delete() {
        const path = diskPath(this.uri);
        if (native.failDelete.delete(this.name)) throw new Error(`failed to delete '${path}'`);
        native.events.push(`delete:${this.name}`);
        native.files.delete(path);
      }
      async move(target: { uri: string; name: string }) {
        const from = diskPath(this.uri);
        const to = diskPath(target.uri);
        native.events.push(`move:${target.name}`);
        await Promise.resolve();
        if (native.files.has(to)) throw new Error(`Destination '${to}' already exists`);
        const outcome = native.nextMove.value;
        native.nextMove.value = "done";
        if (outcome === "refused") throw new Error("No space left on device");
        if (outcome === "partial") {
          native.files.set(to, (native.files.get(from) ?? "").slice(0, 4));
          throw new Error("No space left on device");
        }
        native.files.set(to, native.files.get(from) ?? "");
        native.files.delete(from);
      }
    },
  };
});

import { openMigratedMobileDatabase } from "./mobile-database-migration";

const has = (name: string) => native.files.has(native.pathOf(name));
const put = (name: string, contents = "") => native.files.set(native.pathOf(name), contents);
const ANDROID_SQLITE_DIRECTORY = "/data/data/si.goat.mobile.dev/files/SQLite";

beforeEach(() => {
  native.files.clear();
  native.events.length = 0;
  native.databases.clear();
  native.directory.value = "file:///sqlite";
  native.nextMove.value = "done";
  native.failDelete.clear();
  native.open.mockClear();
  native.backup.mockReset().mockImplementation(copyBackup);
});

describe("mobile SQLite namespace copy", () => {
  it("backs up before publishing, closes both databases, and keeps the source", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME);
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
      "create:goat-client.db.publishing",
      "move:goat-client.db",
      "delete:goat-client.db.publishing",
      "open:goat-client.db",
    ]);
    expect(has(LEGACY_MOBILE_DATABASE_NAME)).toBe(true);
    native.events.length = 0;
    await openMigratedMobileDatabase();
    expect(native.events).toEqual(["open:goat-client.db"]);
    expect(native.backup).toHaveBeenCalledTimes(1);
  });

  it("retries a failed unpublished backup and closes both handles", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME);
    native.backup.mockRejectedValueOnce(new Error("interrupted"));
    await expect(openMigratedMobileDatabase()).rejects.toThrow("interrupted");
    expect(has("goat-client.db")).toBe(false);
    expect(has(LEGACY_MOBILE_DATABASE_NAME)).toBe(true);
    expect(native.events).toContain("close:goat-client.db.migration");
    expect(native.events).toContain(`close:${LEGACY_MOBILE_DATABASE_NAME}`);
    put("goat-client.db.migration-wal");
    put("goat-client.db.migration-shm");
    await openMigratedMobileDatabase();
    expect(native.events).toContain("delete:goat-client.db.migration");
    expect(native.events).toContain("delete:goat-client.db.migration-wal");
    expect(native.events).toContain("delete:goat-client.db.migration-shm");
    expect(has("goat-client.db")).toBe(true);
    expect(native.backup).toHaveBeenCalledTimes(2);
  });

  it("opens an existing GOAT database without touching the legacy database", async () => {
    put("goat-client.db");
    put(LEGACY_MOBILE_DATABASE_NAME);
    await openMigratedMobileDatabase();
    expect(native.events).toEqual(["open:goat-client.db"]);
    expect(native.backup).not.toHaveBeenCalled();
  });

  it("creates only the GOAT database on a fresh install", async () => {
    await openMigratedMobileDatabase();
    expect([...native.files.keys()]).toEqual([native.pathOf("goat-client.db")]);
    expect(native.backup).not.toHaveBeenCalled();
  });

  it("opens the database from Android's plain SQLite folder (#3549)", async () => {
    native.directory.value = ANDROID_SQLITE_DIRECTORY;
    const database = await openMigratedMobileDatabase();
    expect(database).toBe(native.databases.get("goat-client.db"));
    expect(has("goat-client.db")).toBe(true);
  });

  it.each([
    ["Android's plain SQLite folder", ANDROID_SQLITE_DIRECTORY],
    ["a file: SQLite folder", "file:///sqlite"],
  ])(
    "an old-name database in %s is in goat-client.db when the app opens it (#3549)",
    async (_where, directory) => {
      native.directory.value = directory;
      put(LEGACY_MOBILE_DATABASE_NAME, "rows kept from the old name");
      await openMigratedMobileDatabase();
      expect(native.files.get(native.pathOf("goat-client.db"))).toBe("rows kept from the old name");
      expect(has(LEGACY_MOBILE_DATABASE_NAME)).toBe(true);
    },
  );

  it("a publication interrupted after writing part of goat-client.db is redone from the old database on the next launch (#3549)", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME, "rows kept from the old name");
    native.nextMove.value = "partial";
    await expect(openMigratedMobileDatabase()).rejects.toThrow("No space left on device");
    await openMigratedMobileDatabase();
    expect(native.files.get(native.pathOf("goat-client.db"))).toBe("rows kept from the old name");
    expect(native.files.get(native.pathOf(LEGACY_MOBILE_DATABASE_NAME))).toBe(
      "rows kept from the old name",
    );
  });

  it("guard: a publication refused before writing leaves no goat-client.db and the open fails (#3549)", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME, "rows kept from the old name");
    native.nextMove.value = "refused";
    await expect(openMigratedMobileDatabase()).rejects.toThrow("No space left on device");
    expect(has("goat-client.db")).toBe(false);
    expect(native.events).not.toContain("open:goat-client.db");
    expect(has(LEGACY_MOBILE_DATABASE_NAME)).toBe(true);
  });

  it("guard: a completed migration is kept and not redone on later launches (#3549)", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME, "rows kept from the old name");
    await openMigratedMobileDatabase();
    put("goat-client.db", "rows written after the migration");
    await openMigratedMobileDatabase();
    expect(native.files.get(native.pathOf("goat-client.db"))).toBe(
      "rows written after the migration",
    );
    expect(native.backup).toHaveBeenCalledTimes(1);
  });

  it("guard: when the publishing record can't be removed, the open fails and the next launch rebuilds before opening (#3549)", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME, "rows kept from the old name");
    native.failDelete.add("goat-client.db.publishing");
    await expect(openMigratedMobileDatabase()).rejects.toThrow("failed to delete");
    expect(native.events).not.toContain("open:goat-client.db");
    native.events.length = 0;
    await openMigratedMobileDatabase();
    expect(native.events.indexOf("open:goat-client.db")).toBe(native.events.length - 1);
    expect(native.files.get(native.pathOf("goat-client.db"))).toBe("rows kept from the old name");
    expect(native.backup).toHaveBeenCalledTimes(2);
  });

  it("guard: a launch that finds the publishing record removes goat-client.db and rebuilds it before opening it (#3549)", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME, "rows kept from the old name");
    put("goat-client.db", "rows");
    put("goat-client.db-wal");
    put("goat-client.db.publishing");
    await openMigratedMobileDatabase();
    const firstOpen = native.events.indexOf("open:goat-client.db");
    expect(native.events.slice(0, firstOpen)).toEqual(
      expect.arrayContaining([
        "delete:goat-client.db",
        "delete:goat-client.db-wal",
        "backup",
        "move:goat-client.db",
      ]),
    );
    expect(native.events.lastIndexOf("delete:goat-client.db.publishing")).toBeLessThan(firstOpen);
    expect(native.files.get(native.pathOf("goat-client.db"))).toBe("rows kept from the old name");
    expect(has("goat-client.db-wal")).toBe(false);
  });

  it("guard: a rebuild whose cleanup fails halfway opens nothing and finishes on the next launch (#3549)", async () => {
    put(LEGACY_MOBILE_DATABASE_NAME, "rows kept from the old name");
    put("goat-client.db", "rows");
    put("goat-client.db-wal");
    put("goat-client.db.publishing");
    native.failDelete.add("goat-client.db-wal");
    await expect(openMigratedMobileDatabase()).rejects.toThrow("failed to delete");
    expect(native.events).not.toContain("open:goat-client.db");
    expect(has("goat-client.db.publishing")).toBe(true);
    await openMigratedMobileDatabase();
    expect(native.files.get(native.pathOf("goat-client.db"))).toBe("rows kept from the old name");
    expect(has("goat-client.db-wal")).toBe(false);
    expect(has("goat-client.db.publishing")).toBe(false);
  });

  it("guard: a publishing record with no old database is dropped and goat-client.db is kept (#3549)", async () => {
    put("goat-client.db", "rows the app wrote");
    put("goat-client.db.publishing");
    await openMigratedMobileDatabase();
    expect(native.files.get(native.pathOf("goat-client.db"))).toBe("rows the app wrote");
    expect(has("goat-client.db.publishing")).toBe(false);
    expect(native.backup).not.toHaveBeenCalled();
  });
});
