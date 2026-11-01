import type { APIRoute } from "astro";

import { withBase } from "../lib/paths";

export const GET: APIRoute = () =>
  new Response(
    `${JSON.stringify(
      {
        name: "GOAT",
        short_name: "GOAT",
        description: "Your coding agents, on every machine you own.",
        start_url: withBase(""),
        scope: withBase(""),
        display: "browser",
        background_color: "#171717",
        theme_color: "#18181b",
        icons: [
          { src: withBase("icon-192.png"), sizes: "192x192", type: "image/png" },
          { src: withBase("icon-512.png"), sizes: "512x512", type: "image/png" },
          { src: withBase("favicon.svg"), sizes: "any", type: "image/svg+xml" },
        ],
      },
      null,
      2,
    )}\n`,
    { headers: { "Content-Type": "application/manifest+json" } },
  );
