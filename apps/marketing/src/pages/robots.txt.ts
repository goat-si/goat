import type { APIRoute } from "astro";

import { absoluteUrl, withBase } from "../lib/paths";

export const GET: APIRoute = ({ site }) => {
  const body =
    import.meta.env.MARKETING_NOINDEX === "1"
      ? "User-agent: *\nDisallow: /\n"
      : `User-agent: *\nAllow: /\n\nSitemap: ${absoluteUrl(withBase("sitemap.xml"), site)}\n`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
