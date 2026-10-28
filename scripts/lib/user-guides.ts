// @effect-diagnostics nodeBuiltinImport:off - Read at build-config time, before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// D-10: shipped code never links to the source repository. A guide's link to it keeps its text,
// and a bare URL is named; the published guides on the site keep their links.
const SOURCE_REPO = String.raw`(?:https?:\/\/)?github\.com\/goat-si\/goat(?!-releases|_)`;
const sourceLink = new RegExp(String.raw`\[([^\]]*)\]\(${SOURCE_REPO}[^)]*\)`, "gi");
const sourceUrl = new RegExp(String.raw`${SOURCE_REPO}[^\s)\]>"'\`]*`, "gi");
const withoutSourceLinks = (text: string) =>
  text.replace(sourceLink, "$1").replace(sourceUrl, "the GOAT source repository");

/**
 * GOAT's user guides (docs/user/*.md) keyed by page id, for the server pack build to inline as
 * __GOAT_USER_DOCS__ (apps/server/src/userDocs/UserDocs.ts). Every packaged runtime runs that one
 * bundle, so no install layout needs a docs directory.
 */
export function readUserGuides(repoRoot: string): Record<string, string> {
  const directory = NodePath.join(repoRoot, "docs/user");
  const guides = Object.fromEntries(
    NodeFS.readdirSync(directory)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => [
        file.slice(0, -".md".length),
        withoutSourceLinks(NodeFS.readFileSync(NodePath.join(directory, file), "utf8")),
      ]),
  );
  if (Object.keys(guides).length === 0) throw new Error(`No user guides in ${directory}.`);
  return guides;
}
