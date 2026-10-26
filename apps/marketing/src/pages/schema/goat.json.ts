import type { APIRoute } from "astro";

import { buildGoatProjectFileJsonSchema } from "@goat/shared/goatProjectFile";

export const GET: APIRoute = () =>
  new Response(`${JSON.stringify(buildGoatProjectFileJsonSchema(), null, 2)}\n`, {
    headers: { "Content-Type": "application/json" },
  });
