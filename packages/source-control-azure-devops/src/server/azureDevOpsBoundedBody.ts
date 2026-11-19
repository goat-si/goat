import { CHANGE_REQUEST_BODY_MAX_BYTES } from "@goat/source-control-core/server/SourceControlHost";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

export class AzureBodyReadError extends Data.TaggedError("AzureBodyReadError")<{
  readonly tooLarge: boolean;
}> {
  override get message() {
    return this.tooLarge
      ? "The pull request description is too large."
      : "The pull request description could not be read.";
  }
}

export const prepareAzureBody = Effect.fn("AzureDevOpsCli.prepareBody")(function* (
  fs: FileSystem.FileSystem,
  input: string,
) {
  const fail = () => new AzureBodyReadError({ tooLarge: false });
  const chunks = yield* fs
    .stream(input, { bytesToRead: CHANGE_REQUEST_BODY_MAX_BYTES + 1 })
    .pipe(Stream.runCollect, Effect.mapError(fail));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  if (size > CHANGE_REQUEST_BODY_MAX_BYTES)
    return yield* new AzureBodyReadError({ tooLarge: true });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const bodyFile = yield* fs
    .makeTempFileScoped({ prefix: "goat-azure-pr-body-" })
    .pipe(Effect.mapError(fail));
  yield* fs.writeFile(bodyFile, bytes).pipe(Effect.mapError(fail));
  return bodyFile;
});
