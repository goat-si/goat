import { LEGACY_MOBILE_DATABASE_NAME } from "@goat/contracts/legacyT3Names";

const DATABASE_NAME = "goat-client.db";

/** Publish the new file only after SQLite's WAL-aware backup has completed and closed. */
export async function openMigratedMobileDatabase() {
  const SQLite = await import("expo-sqlite");
  const { File } = await import("expo-file-system");
  const target = new File(SQLite.defaultDatabaseDirectory, DATABASE_NAME);
  if (!target.exists) {
    const legacy = new File(SQLite.defaultDatabaseDirectory, LEGACY_MOBILE_DATABASE_NAME);
    if (legacy.exists) {
      const temporaryName = `${DATABASE_NAME}.migration`;
      const temporary = new File(SQLite.defaultDatabaseDirectory, temporaryName);
      // A crash leaves only this unpublished copy; the legacy database stays intact.
      for (const name of [temporaryName, `${temporaryName}-wal`, `${temporaryName}-shm`]) {
        const unfinished = new File(SQLite.defaultDatabaseDirectory, name);
        if (unfinished.exists) unfinished.delete();
      }
      const source = await SQLite.openDatabaseAsync(LEGACY_MOBILE_DATABASE_NAME);
      try {
        const destination = await SQLite.openDatabaseAsync(temporaryName);
        try {
          await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
          await destination.execAsync(
            "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE;",
          );
        } finally {
          await destination.closeAsync();
        }
      } finally {
        await source.closeAsync();
      }
      temporary.move(target);
    }
  }
  return SQLite.openDatabaseAsync(DATABASE_NAME);
}
