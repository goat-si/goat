// @effect-diagnostics nodeBuiltinImport:off - Read at build-config time, before any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { SOURCE_REPOSITORY_REFERENCE } from "./source-repository.ts";

const PUBLISHED_GUIDES = "https://trygoat.ai/docs/user/";
const urlChar = String.raw`[^\s()\[\]<>"'\`]`;
const sourceUrl = String.raw`${urlChar}*${SOURCE_REPOSITORY_REFERENCE}${urlChar}*`;
const sourceLink = new RegExp(String.raw`\[([^\]]*)\]\(${sourceUrl}\)`, "gi");
const bareSourceUrl = new RegExp(sourceUrl, "gi");

/**
 * D-10: shipped code never refers to the source repository, so a bundled guide's link to it keeps
 * only its text and a bare URL points at the same guide on the site, which keeps its links.
 */
export const withoutSourceRepositoryLinks = (text: string, page: string) =>
  text
    .replace(sourceLink, "$1")
    .replace(bareSourceUrl, `<GOAT repository URL: see ${PUBLISHED_GUIDES}${page}/>`);

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
      .map((file) => {
        const page = file.slice(0, -".md".length);
        const text = NodeFS.readFileSync(NodePath.join(directory, file), "utf8");
        return [page, withoutSourceRepositoryLinks(text, page)];
      }),
  );
  if (Object.keys(guides).length === 0) throw new Error(`No user guides in ${directory}.`);
  return guides;
}
