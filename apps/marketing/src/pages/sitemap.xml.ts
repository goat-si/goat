import type { APIRoute } from "astro";

import { LOCALES, messages } from "../i18n";
import { absoluteUrl, localePath } from "../lib/paths";
import { INDEXED_PATHS } from "../lib/sitePages";

export const GET: APIRoute = ({ site }) => {
  const urls = INDEXED_PATHS.flatMap((path) =>
    LOCALES.map((locale) => {
      const alternates = LOCALES.map(
        (alternate) =>
          `    <xhtml:link rel="alternate" hreflang="${messages(alternate).htmlLang}" href="${absoluteUrl(localePath(alternate, path), site)}" />`,
      ).join("\n");
      return `  <url>\n    <loc>${absoluteUrl(localePath(locale, path), site)}</loc>\n${alternates}\n  </url>`;
    }),
  );
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join("\n")}\n</urlset>\n`;
  return new Response(body, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
