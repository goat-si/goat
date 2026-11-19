import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

const MERGE_REQUEST_DESCRIPTION_MAX_BYTES = 4_000_000;

export class GitLabDescriptionError extends Data.TaggedError("GitLabDescriptionError")<{
  readonly tooLarge: boolean;
}> {
  override get message() {
    return this.tooLarge
      ? "The merge request description is too large."
      : "The merge request description could not be read.";
  }
}

export const readGitLabDescription = Effect.fn("GitLabCli.readDescription")(function* (
  fileSystem: FileSystem.FileSystem,
  bodyFile: string,
) {
  const chunks = yield* fileSystem
    .stream(bodyFile, { bytesToRead: MERGE_REQUEST_DESCRIPTION_MAX_BYTES + 1 })
    .pipe(
      Stream.runCollect,
      Effect.mapError(() => new GitLabDescriptionError({ tooLarge: false })),
    );
  if (
    chunks.reduce((size, chunk) => size + chunk.length, 0) > MERGE_REQUEST_DESCRIPTION_MAX_BYTES
  ) {
    return yield* new GitLabDescriptionError({ tooLarge: true });
  }
  const decoder = new TextDecoder();
  return chunks.map((chunk) => decoder.decode(chunk, { stream: true })).join("") + decoder.decode();
});
