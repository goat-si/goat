import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

/** Resolve only the base so symlink/.. segments keep filesystem semantics. */
export function resolveAbsoluteLocalCommand(path: Path.Path, command: string): string {
  if (path.isAbsolute(command)) return command;
  const root = path.parse(command).root;
  return `${path.resolve(root)}${path.sep}${command.slice(root.length)}`;
}

export const isSameResolvedPath = Effect.fn("AcpRegistryCatalog.isSamePath")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  platform: NodeJS.Platform,
  left: string,
  right: string,
) {
  const normalize = (value: string) =>
    platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  if (normalize(left) === normalize(right)) return true;
  const leftReal = yield* fileSystem.realPath(left).pipe(Effect.option);
  const rightReal = yield* fileSystem.realPath(right).pipe(Effect.option);
  return (
    Option.isSome(leftReal) &&
    Option.isSome(rightReal) &&
    normalize(leftReal.value) === normalize(rightReal.value)
  );
});
