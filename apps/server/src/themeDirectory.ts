// @effect-diagnostics nodeBuiltinImport:off -- bounded directory iteration avoids an unbounded listing.
import * as NodeFS from "node:fs";

export const MAX_THEME_DIRECTORY_ENTRIES = 256;

export function readThemeDirectory(directory: string): string[] {
  const entries: string[] = [];
  let handle: NodeFS.Dir;
  try {
    handle = NodeFS.opendirSync(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return entries;
    throw cause;
  }
  try {
    while (true) {
      const entry = handle.readSync();
      if (entry === null) return entries;
      if (entries.length >= MAX_THEME_DIRECTORY_ENTRIES)
        throw new Error("Theme directory exceeds its scan limit.");
      entries.push(entry.name);
    }
  } finally {
    handle.closeSync();
  }
}
