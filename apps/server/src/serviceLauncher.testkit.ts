import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

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
