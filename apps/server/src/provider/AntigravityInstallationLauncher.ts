import type * as Path from "effect/Path";

const LAUNCHER_SETUP =
  /^[\s@]*(?:|::[^&|<>]*|rem(?:\s[^&|<>]*|$)|set\s+"[^"=&|<>]+=[^"&|<>]*"\s*|(?:echo|set|setlocal|endlocal)(?:\s[^&|<>()]*)?)$/iu;
const LAUNCHER_COMMAND =
  /^[\s@]*(?:"([^"]*agy_acp_server\.exe)"|([^\s"&|<>()@]*agy_acp_server\.exe))(?:\s[^&|<>()]*)?$/iu;

export const launcherTargetPath = (path: Path.Path, launcher: string, written: string) => {
  const target = written.replace(/%~dp0/giu, () => `${path.dirname(launcher)}${path.sep}`);
  if (/[%!]/u.test(target)) return null;
  const resolved = path.resolve(target);
  return path.parse(path.normalize(target)).root === path.parse(resolved).root ? resolved : null;
};

export const launcherTargetFromContents = (path: Path.Path, launcher: string, contents: string) => {
  const targets = new Set<string>();
  for (const line of contents.split(/\r?\n/u)) {
    if (line.includes("^")) return null;
    if (/^[\s@]*exit(?:\s+\/b)?(?:\s+-?\d+)?\s*$/iu.test(line)) break;
    if (LAUNCHER_SETUP.test(line)) continue;
    const match = LAUNCHER_COMMAND.exec(line);
    if (!match) return null;
    const target = launcherTargetPath(path, launcher, match[1] ?? match[2] ?? "");
    if (target === null) return null;
    targets.add(target);
  }
  return targets.size === 1 ? ([...targets][0] ?? null) : null;
};
