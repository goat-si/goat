// @effect-diagnostics nodeBuiltinImport:off -- Launcher fixtures use SQLite without starting a server.
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeSqlite from "node:sqlite";

export function seedDatabase(path: string, label: string): void {
  using db = new NodeSqlite.DatabaseSync(path);
  db.exec("CREATE TABLE fixture (label TEXT)");
  db.prepare("INSERT INTO fixture VALUES (?)").run(label);
}

export function readDatabaseLabel(path: string): string {
  using db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  return String(db.prepare("SELECT label FROM fixture").get()?.label);
}

export const writeFakeRuntime = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  versionDir: string,
  childSource: string,
) =>
  Effect.gen(function* () {
    const entryPath = path.join(versionDir, "goat");
    yield* fs.makeDirectory(versionDir, { recursive: true });
    // Fixtures import TypeScript, which Node 22 runs only behind this flag.
    yield* fs.writeFileString(
      entryPath,
      `#!${process.execPath} --experimental-strip-types\n${childSource}`,
    );
    yield* fs.chmod(entryPath, 0o755);
    yield* fs.writeFileString(
      path.join(versionDir, ".install-complete"),
      `${path.basename(versionDir)}\n`,
    );
    return entryPath;
  });
