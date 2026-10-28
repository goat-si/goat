import { getCollection, render, type CollectionEntry } from "astro:content";
import { guide } from "./links";

export function userGuideHtml(entry: CollectionEntry<"userGuides">) {
  if (!entry.rendered) throw new Error(`User guide ${entry.id} has not been rendered.`);
  return entry.rendered.html.replace(
    /(<a\b[^>]*\bhref=")([^"]+)(")/g,
    (link, start: string, href: string, end: string) => {
      const localGuide = /^(?:\.\/)?([^/#?]+)\.md([#?].*)?$/.exec(href);
      if (localGuide?.[1]) return `${start}${guide(localGuide[1])}${localGuide[2] ?? ""}${end}`;
      if (href.startsWith("../")) {
        return `${start}${new URL(href, "https://github.com/goat-si/goat/blob/dev/docs/user/").href}${end}`;
      }
      return link;
    },
  );
}

export async function userGuides() {
  const guides = await Promise.all(
    (await getCollection("userGuides")).map(async (entry) => {
      const { headings } = await render(entry);
      const title = headings.find((heading) => heading.depth === 1)?.text;
      if (!title) throw new Error(`User guide ${entry.id} needs a title.`);
      return { entry, title };
    }),
  );
  return guides.sort((a, b) => a.title.localeCompare(b.title, "en"));
}
