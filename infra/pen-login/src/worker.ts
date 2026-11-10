import {
  CITY_HEADER,
  COUNTRY_HEADER,
  json,
  SOURCE_HEADER,
  sourceKey,
  TRUSTED_HEADERS,
} from "./http.ts";
import type { Env } from "./env.ts";

export { Login } from "./login.ts";

const ROUTES = new Set([
  "GET /v1/keys",
  "POST /v1/device/start",
  "POST /v1/device/token",
  "POST /v1/mesh/register",
  "POST /v1/mesh/forget",
  "GET /device",
  "POST /device",
  "POST /device/confirm",
  "GET /reset",
  "POST /reset",
  "POST /reset/confirm",
  "GET /v1/auth/google/callback",
]);

/** Every response: never cached, never framed, never sniffed; pages bring their own CSP. */
function secured(response: Response, https: boolean): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  if (!headers.has("content-security-policy")) {
    headers.set(
      "content-security-policy",
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
  }
  if (https) headers.set("strict-transport-security", "max-age=31536000");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const https = url.protocol === "https:";
    if (request.method === "GET" && url.pathname === "/") {
      return secured(new Response(null, { status: 303, headers: { location: "/device" } }), https);
    }
    if (!ROUTES.has(`${request.method} ${url.pathname}`))
      return secured(json({ error: "not_found" }, 404), https);
    const headers = new Headers(request.headers);
    for (const name of TRUSTED_HEADERS) headers.delete(name);
    headers.set(SOURCE_HEADER, sourceKey(request.headers.get("cf-connecting-ip")));
    headers.set(COUNTRY_HEADER, String(request.cf?.country ?? ""));
    headers.set(CITY_HEADER, encodeURIComponent(String(request.cf?.city ?? "")));
    const forwarded = new Request(request, { headers });
    return secured(await env.LOGIN.get(env.LOGIN.idFromName("global")).fetch(forwarded), https);
  },
} satisfies ExportedHandler<Env>;
