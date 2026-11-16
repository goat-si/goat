/**
 * A successfully read zstd archive replaces its original transcript's saved records and
 * diagnostics, unless the original is still on disk. Returns whether the cache changed.
 */
export function dropArchivedOriginals(
  cache: Map<string, unknown>,
  livePaths: ReadonlyArray<string>,
  read: ReadonlyArray<{ readonly path: string; readonly failed?: boolean | undefined }>,
): boolean {
  const live = new Set(livePaths);
  let dropped = false;
  for (const file of read) {
    if (file.failed || !file.path.endsWith(".jsonl.zst")) continue;
    if (!live.has(file.path.slice(0, -4)) && cache.delete(file.path.slice(0, -4))) dropped = true;
  }
  return dropped;
}
