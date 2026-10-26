import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export const makeTempDir = Effect.fn("test.makeTempDir")(function* (prefix: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({ prefix });
});

export const removePath = Effect.fn("test.removePath")(function* (targetPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(targetPath, { recursive: true, force: true });
});

export const makeDirectory = Effect.fn("test.makeDirectory")(function* (dirPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(dirPath, { recursive: true });
});
