import { normalizeProjectPathForComparison } from "@goat/shared/path";

/** Git prints `C:/Users/...` where Node joins `C:\Users\...`, and NTFS folds case. */
export function isSameWorktreePath(left: string, right: string, platform: NodeJS.Platform) {
  const trim = (value: string) => value.replace(/(?<=[^\\/:])[\\/]+$/u, "");
  return platform === "win32"
    ? normalizeProjectPathForComparison(trim(left)) ===
        normalizeProjectPathForComparison(trim(right))
    : trim(left) === trim(right);
}
