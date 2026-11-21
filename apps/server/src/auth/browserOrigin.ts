import type * as HttpServerRequest from "effect/http/HttpServerRequest";

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first && first.length > 0 ? first : undefined;
}

// Missing Origin allows same-origin reads and non-browser clients; otherwise require
// same-origin Sec-Fetch-Site, this server's host (including X-Forwarded-Host), or a trusted app origin.
export function isBrowserOriginAllowed(
  request: HttpServerRequest.HttpServerRequest,
  trustedOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  if (trustedOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === "") return false;
  return (
    originHost === firstHeaderValue(request.headers.host) ||
    originHost === firstHeaderValue(request.headers["x-forwarded-host"])
  );
}
