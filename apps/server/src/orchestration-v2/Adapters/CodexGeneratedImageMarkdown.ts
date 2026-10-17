import { markdownImageHrefs } from "@goat/shared/markdownImages";
import { parseMarkdownFileLink } from "@goat/shared/markdownLinks";
import type * as Path from "effect/Path";

/** Append saved images only when the answer does not already render that file. */
export function appendGeneratedImageMarkdown(
  text: string,
  paths: ReadonlySet<string>,
  cwd: string,
  path: Path.Path,
): string {
  const embeddedPaths = new Set(
    markdownImageHrefs(text).flatMap((href) => {
      const target = parseMarkdownFileLink(href);
      return target === null ? [] : [path.resolve(cwd, target.path)];
    }),
  );
  const missing = [...paths].filter(
    (savedPath) => !embeddedPaths.has(path.resolve(cwd, savedPath)),
  );
  if (missing.length === 0) return text;
  const markdown = missing.map(
    (savedPath) =>
      `![Generated image](<${encodeURI(savedPath).replaceAll("#", "%23").replaceAll("?", "%3F")}>)`,
  );
  return [text.trimEnd(), ...markdown].filter(Boolean).join("\n\n");
}
