import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { FAKE_SESSION_FILE } from "./fakePi.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export const makeLegacySessionFixture = Effect.fnUntraced(function* (
  entries: ReadonlyArray<unknown>,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped();
  const aliasDirectory = FAKE_SESSION_FILE.slice(0, FAKE_SESSION_FILE.lastIndexOf("/"));
  const map = (path: string) =>
    path === aliasDirectory || path.startsWith(`${aliasDirectory}/`)
      ? `${directory}${path.slice(aliasDirectory.length)}`
      : path;
  const header = {
    type: "session",
    version: 3,
    id: "synthetic",
    timestamp: "1970-01-01T00:00:00.000Z",
    cwd: "/workspace",
  };
  yield* fs.writeFileString(
    map(FAKE_SESSION_FILE),
    [header, ...entries].map((entry) => encode(entry)).join("\n") + "\n",
  );
  return FileSystem.make({
    ...fs,
    readDirectoryEntries: (path) => fs.readDirectoryEntries(map(path)),
    stat: (path) => fs.stat(map(path)),
    realPath: (path) => fs.realPath(map(path)),
    readFile: (path) => fs.readFile(map(path)),
    open: (path, options) => fs.open(map(path), options),
  });
});
