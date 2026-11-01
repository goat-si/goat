/**
 * The driver attests a Windows executable by its final path, with links, junctions and short
 * names resolved, and the helper lists apps that way (#1379). GOAT's own path joins the host ids
 * in that form too, so a GOAT reached through a link is still never admitted.
 */
export async function withResolvedWindowsPaths(
  ids: ReadonlyArray<string>,
  platform: NodeJS.Platform,
): Promise<ReadonlyArray<string>> {
  if (platform !== "win32") return ids;
  const { realpath } = await import("node:fs/promises");
  const resolved = await Promise.all(
    ids.map((id) =>
      // Drive, UNC and \\?\ paths alike; the manifest compares their normalized forms.
      /^([A-Za-z]:[\\/]|[\\/]{2})/u.test(id)
        ? realpath(id).catch(() => undefined)
        : Promise.resolve(undefined),
    ),
  );
  return [...new Set([...ids, ...resolved.filter((path): path is string => path !== undefined)])];
}
