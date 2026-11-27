import type * as Path from "effect/Path";

/** Resolve only the base so symlink/.. segments keep filesystem semantics. */
export function resolveAbsoluteLocalCommand(path: Path.Path, command: string): string {
  if (path.isAbsolute(command)) return command;
  const root = path.parse(command).root;
  return `${path.resolve(root)}${path.sep}${command.slice(root.length)}`;
}
