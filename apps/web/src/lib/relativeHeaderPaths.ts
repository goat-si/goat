// Claude records absolute paths; name files under the workspace relative to it, as other diffs do.
// Only header lines, from the start or a `diff --git` line up to the first hunk, are rewritten.
export function relativeHeaderPaths(patch: string | undefined, workspaceRoot: string | undefined) {
  const windows = /^(?:[A-Za-z]:[\\/]|\\\\)/.test(workspaceRoot ?? "");
  const segments = workspaceRoot?.split(windows ? /[\\/]+/ : /\/+/);
  while (segments?.at(-1) === "") segments.pop();
  if (!patch || !segments?.some(Boolean)) return patch;
  // Windows separates with / or \ (\\ in a quoted header); POSIX only with /, where a \ is part of
  // a name and a quoted header doubles it.
  const separator = windows ? String.raw`[\\/]+` : "/+";
  const root = segments
    .map((segment) =>
      segment
        .split("\\")
        .map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(String.raw`\\\\?`),
    )
    .join(separator);
  const prefix = new RegExp(String.raw`^("?(?:[ab]/)?)${root}${separator}`, windows ? "i" : "");
  const relative = (name: string) => name.replace(prefix, "$1");
  let inHeader = true;
  return patch
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        inHeader = true;
        // Split the names as Pierre's parser does, so a name containing a space stays whole.
        const names =
          /^diff --git ("a\/(?:[^"\\]|\\.)*"|a\/.+?) ("b\/(?:[^"\\]|\\.)*"|b\/.+?)$/.exec(line);
        return names && names[1] !== undefined && names[2] !== undefined
          ? `diff --git ${relative(names[1])} ${relative(names[2])}`
          : line;
      }
      if (line.startsWith("@@")) inHeader = false;
      const name = inHeader ? /^(---|\+\+\+)(\s+)(.*)$/.exec(line) : null;
      return name && name[3] !== undefined ? `${name[1]}${name[2]}${relative(name[3])}` : line;
    })
    .join("\n");
}
