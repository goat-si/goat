import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

// Prepared server bytecode from prepare-server-compile-cache.cjs is one file per loaded server
// chunk plus its manifest. It has its own budget so the payload budget keeps catching loose files.
const PREPARED_SERVER_CACHE_DIR = "server-compile-cache";
export const PREPARED_SERVER_CACHE_FILE_LIMIT = 64;

const PreparedServerCacheManifest = Schema.fromJsonString(
  Schema.Struct({ entries: Schema.Array(Schema.Struct({ file: Schema.String })) }),
);

export class PreparedServerCacheValidationError extends Schema.TaggedError<PreparedServerCacheValidationError>()(
  "PreparedServerCacheValidationError",
  { cacheDir: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Windows prepared server cache at ${this.cacheDir} ${this.detail}.`;
  }
}

const countFiles = Effect.fn("desktopArtifact.countPayloadFiles")(function* (
  root: string,
  excludedDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const pendingDirectories = [root];
  let count = 0;

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();
    if (directory === undefined) break;
    for (const entry of yield* fs.readDirectory(directory)) {
      const entryPath = path.join(directory, entry);
      const stat = yield* fs.stat(entryPath);
      if (stat.type === "Directory" && entryPath !== excludedDirectory) {
        pendingDirectories.push(entryPath);
      } else if (stat.type === "File") {
        count += 1;
      }
    }
  }

  return count;
});

/** Counts the files that the Windows payload budget covers, after checking the prepared cache. */
export const countWindowsPayloadFiles = Effect.fn("desktopArtifact.countWindowsPayloadFiles")(
  function* (packagedAppDir: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cacheDir = path.join(packagedAppDir, "resources", PREPARED_SERVER_CACHE_DIR);
    if (yield* fs.exists(cacheDir)) {
      const fail = (detail: string) => new PreparedServerCacheValidationError({ cacheDir, detail });
      const manifest = yield* fs.readFileString(path.join(cacheDir, "manifest.json")).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(PreparedServerCacheManifest)),
        Effect.mapError(() => fail("has no readable manifest.json")),
      );
      const expected = new Set(["manifest.json", ...manifest.entries.map((entry) => entry.file)]);
      const actual = yield* fs.readDirectory(cacheDir);
      const unexpected = actual.filter((file) => !expected.has(file));
      const missing = [...expected].filter((file) => !actual.includes(file));
      if (unexpected.length > 0 || missing.length > 0) {
        return yield* fail(
          `does not match its manifest (unexpected: ${unexpected.join(", ") || "none"}; missing: ${missing.join(", ") || "none"})`,
        );
      }
      if (actual.length > PREPARED_SERVER_CACHE_FILE_LIMIT) {
        return yield* fail(
          `contains ${String(actual.length)} files; expected at most ${String(PREPARED_SERVER_CACHE_FILE_LIMIT)}`,
        );
      }
    }
    return yield* countFiles(packagedAppDir, cacheDir);
  },
);
