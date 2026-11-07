// @effect-diagnostics nodeBuiltinImport:off -- Windows path parsing must be platform independent.
import * as NodePath from "node:path";

export const GIT_FOR_WINDOWS_BUILDS = ["ucrt64", "clangarm64", "mingw64", "mingw32"] as const;

// `*` is one argument that is not an option. These forms read refs or config
// only, so git starts no hook, helper, pager, editor or lazy fetch for them.
const CONSOLE_FREE_GIT_READS = [
  "rev-parse --git-path index",
  "rev-parse --git-common-dir",
  "rev-parse --show-toplevel",
  "rev-parse --symbolic-full-name HEAD",
  "rev-parse --abbrev-ref --symbolic-full-name @{upstream}",
  "symbolic-ref --quiet HEAD",
  "symbolic-ref *",
  "remote",
  "remote get-url *",
  "remote get-url -- *",
  "config --get *",
].map((form) => form.split(" "));

export function runsGitWithoutConsole(
  platform: NodeJS.Platform,
  executable: string,
  args: ReadonlyArray<string>,
): boolean {
  if (platform !== "win32") return false;
  const { basename, dirname } = NodePath.win32;
  const bin = dirname(executable);
  const build = basename(dirname(bin)).toLowerCase();
  if (basename(executable).toLowerCase() !== "git.exe" || basename(bin).toLowerCase() !== "bin") {
    return false;
  }
  if (!GIT_FOR_WINDOWS_BUILDS.some((candidate) => candidate === build)) return false;
  const rest =
    args[0] === "--git-dir" && args[1] !== undefined && !args[1].startsWith("-")
      ? args.slice(2)
      : args;
  return CONSOLE_FREE_GIT_READS.some(
    (form) =>
      form.length === rest.length &&
      form.every((part, i) => {
        const arg = rest[i];
        return part === arg || (part === "*" && arg !== undefined && !arg.startsWith("-"));
      }),
  );
}
