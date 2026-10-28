// @effect-diagnostics nodeBuiltinImport:off - Reads the repository's guides to check their own links.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { expect, it } from "@effect/vitest";
import { parseUserGuide } from "./userGuides.ts";

const directory = NodeURL.fileURLToPath(new URL("../../../../docs/user/", import.meta.url));
const pages = NodeFS.readdirSync(directory)
  .filter((file) => file.endsWith(".md"))
  .map((file) =>
    parseUserGuide(file.slice(0, -".md".length), NodeFS.readFileSync(directory + file, "utf8")),
  );

// The site checks these links against its rendered anchors (apps/marketing userDocs.test.ts), so
// every one resolving here means the anchors agents cite match the site's.
it("resolves every in-guide anchor link to a section the parser emits", () => {
  const anchors = new Map(
    pages.map((page) => [page.page, new Set(page.sections.map((s) => s.anchor))]),
  );
  const links = pages.flatMap((page) =>
    [...page.markdown.matchAll(/\]\((?:([a-z0-9-]+)\.md)?#([^)\s]+)\)/g)].map((match) => ({
      from: page.page,
      to: match[1] ?? page.page,
      anchor: match[2] ?? "",
    })),
  );
  expect(links.length).toBeGreaterThan(10);
  expect(links.filter((link) => !anchors.get(link.to)?.has(link.anchor))).toEqual([]);
});

it("finds a title for every guide", () => {
  expect(pages.filter((page) => page.title === page.page).map((page) => page.page)).toEqual([]);
});
