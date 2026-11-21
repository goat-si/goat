import { forkPiSessionOnce } from "./forkSession.ts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { piRecordString as recordString } from "./rpc.ts";

const decodeHeader = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const sessionHeaderNamesCwd = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  cwd: string,
  sessionFile: string,
) {
  const header = yield* fileSystem.stream(sessionFile).pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  if (header === undefined) return true;
  const sessionCwd = recordString(Option.getOrUndefined(decodeHeader(header)), "cwd");
  if (sessionCwd === undefined || sessionCwd === cwd) return true;
  const realCwd = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => cwd));
  return sessionCwd === realCwd;
});

export const initialPiSessionPath = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  cwd: string,
  sessionFile: string | undefined,
) {
  return sessionFile !== undefined && (yield* sessionHeaderNamesCwd(fileSystem, cwd, sessionFile))
    ? sessionFile
    : undefined;
});

export const sessionFileInCwd = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  input: Parameters<typeof forkPiSessionOnce>[0],
) {
  if (yield* sessionHeaderNamesCwd(fileSystem, input.cwd, input.sourceFile))
    return input.sourceFile;
  return yield* forkPiSessionOnce(input);
});
