import { LEGACY_MOBILE_DATABASE_NAME } from "@goat/contracts/legacyT3Names";

import { localFileUri } from "../lib/fileUri";

const DATABASE_NAME = "goat-client.db";
const PUBLISHING_NAME = `${DATABASE_NAME}.publishing`;

/**
 * Publish the new file only after SQLite's WAL-aware backup has completed and closed. The move may
 * fall back to copying (Android), so a record marks a publication until it has finished.
 */
export async function openMigratedMobileDatabase() {
  const SQLite = await import("expo-sqlite");
  const { Directory, File } = await import("expo-file-system");
  const directory = new Directory(localFileUri(SQLite.defaultDatabaseDirectory));
  const target = new File(directory, DATABASE_NAME);
  const legacy = new File(directory, LEGACY_MOBILE_DATABASE_NAME);
  const publishing = new File(directory, PUBLISHING_NAME);
  if (publishing.exists) {
    // A target beside the record may be partial; it is rebuilt from the kept legacy database.
    if (legacy.exists) {
      for (const name of [DATABASE_NAME, `${DATABASE_NAME}-wal`, `${DATABASE_NAME}-shm`]) {
        const partial = new File(directory, name);
        if (partial.exists) partial.delete();
      }
    }
    publishing.delete();
  }
  if (!target.exists && legacy.exists) {
    const temporaryName = `${DATABASE_NAME}.migration`;
    const temporary = new File(directory, temporaryName);
    // A crash leaves only this unpublished copy; the legacy database stays intact.
    for (const name of [temporaryName, `${temporaryName}-wal`, `${temporaryName}-shm`]) {
      const unfinished = new File(directory, name);
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
    publishing.create();
    await temporary.move(target);
    publishing.delete();
  }
  return SQLite.openDatabaseAsync(DATABASE_NAME);
}
