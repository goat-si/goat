// @effect-diagnostics nodeBuiltinImport:off -- Node provides constant-time capability comparison.
import * as NodeCrypto from "node:crypto";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts";
import { LEGACY_ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts/legacyT3Names";

export interface GatewayRoute {
  readonly capability: string;
}
export interface GatewayRequest<T extends GatewayRoute> {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawHeaders: readonly string[];
  readonly port: number;
  readonly appOrigins: readonly string[];
  readonly routes: readonly T[];
  readonly upgrade?: boolean;
}
export type GatewayDecision<T> =
  | { readonly kind: "refuse"; readonly status: number; readonly headers: Record<string, string> }
  | { readonly kind: "preflight"; readonly headers: Record<string, string> }
  | {
      readonly kind: "forward" | "upgrade";
      readonly route: T;
      readonly path: string;
      readonly headers: Record<string, string>;
      readonly responseHeaders: Record<string, string>;
    };

const allowed = new Set([
  "accept",
  "content-type",
  "range",
  "if-none-match",
  "if-modified-since",
  ORCHESTRATION_PROTOCOL_HEADER,
  LEGACY_ORCHESTRATION_PROTOCOL_HEADER,
  "traceparent",
  "b3",
]);
const wsAllowed = new Set(["sec-websocket-key", "sec-websocket-version", "sec-websocket-protocol"]);
const forbidden = new Set(["authorization", "cookie", "dpop"]);
const one = (value: string | string[] | undefined) =>
  typeof value === "string" ? value : undefined;

export function isPublicPenDescriptor(method: string, path: string): boolean {
  return (
    (method === "GET" || method === "HEAD") &&
    (path === "/.well-known/goat/environment" || path === "/.well-known/t3/environment")
  );
}

export function filterPenResponseHeaders(
  upstream: ReadonlyArray<readonly [string, string]>,
  local: Readonly<Record<string, string>>,
): Record<string, string> {
  const connectionFields = upstream
    .filter(([name]) => name === "connection")
    .flatMap(([, value]) => value.split(",").map((name) => name.trim().toLowerCase()));
  const excluded = new Set([
    "set-cookie",
    "connection",
    "transfer-encoding",
    "keep-alive",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "referrer-policy",
    "vary",
    ...connectionFields,
  ]);
  const headers = { ...local };
  for (const [name, value] of upstream)
    if (!name.startsWith("access-control-") && !excluded.has(name)) headers[name] = value;
  return headers;
}

export function decidePenGatewayRequest<T extends GatewayRoute>(
  input: GatewayRequest<T>,
): GatewayDecision<T> {
  const empty = { "referrer-policy": "no-referrer" };
  const refuse = (status: number, headers: Record<string, string> = empty): GatewayDecision<T> => ({
    kind: "refuse",
    status,
    headers,
  });
  const match = /^\/pen-route\/([A-Za-z0-9_-]{43})(\/[^#]*)?$/.exec(input.url);
  if (!match) return refuse(404);
  const candidate = Buffer.from(match[1] ?? "", "ascii");
  const route = input.routes.find((entry) => {
    const capability = Buffer.from(entry.capability, "ascii");
    return (
      capability.length === candidate.length && NodeCrypto.timingSafeEqual(capability, candidate)
    );
  });
  if (!route) return refuse(404);
  const origin = one(input.headers.origin);
  const cors: Record<string, string> = { "referrer-policy": "no-referrer", vary: "Origin" };
  if (origin && input.appOrigins.includes(origin)) {
    cors["access-control-allow-origin"] = origin;
    cors["access-control-allow-credentials"] = "true";
    cors.vary = "Origin";
  }
  if (
    one(input.headers.host) !== `127.0.0.1:${input.port}` ||
    (input.headers.origin !== undefined && origin === undefined)
  )
    return refuse(403, cors);
  const path = match[2] ?? "/";
  let decoded: string;
  try {
    decoded = decodeURIComponent(path.split("?", 1)[0] ?? "");
  } catch {
    return refuse(400, cors);
  }
  if (
    decoded.includes("\\") ||
    decoded.split("/").some((segment) => segment === "." || segment === "..") ||
    decoded.includes("\0")
  )
    return refuse(400, cors);
  // The target admits only the exact path; this side refuses every spelling that could become it.
  if (/^\/api\/pen\/session(?:[/;]|$)/.test(decoded.replace(/\/+/g, "/").toLowerCase()))
    return refuse(403, cors);
  const validOrigin = origin !== undefined && input.appOrigins.includes(origin);
  const originlessAsset =
    origin === undefined &&
    (input.method === "GET" || input.method === "HEAD") &&
    decoded.startsWith("/api/assets/") &&
    !input.upgrade;
  if (!validOrigin && !originlessAsset) return refuse(403, cors);
  const counts = new Map<string, number>();
  for (let i = 0; i < input.rawHeaders.length; i += 2) {
    const name = (input.rawHeaders[i] ?? "").toLowerCase();
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  if (
    ["host", "origin", "content-length", "authorization", "dpop"].some(
      (name) => (counts.get(name) ?? 0) > 1,
    )
  )
    return refuse(400, cors);
  if (input.headers.authorization !== undefined || input.headers.dpop !== undefined)
    return refuse(400, cors);
  if (!["GET", "HEAD", "POST", "OPTIONS"].includes(input.method)) return refuse(405, cors);
  if (
    input.headers["transfer-encoding"] !== undefined ||
    (input.method === "POST" && input.headers["content-length"] === undefined)
  )
    return refuse(411, cors);
  if (input.method === "OPTIONS") {
    const requested = one(input.headers["access-control-request-headers"]) ?? "";
    const names = requested
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => /^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) && !forbidden.has(name));
    return {
      kind: "preflight",
      headers: {
        ...cors,
        "access-control-allow-methods": "GET, HEAD, POST",
        "access-control-allow-headers": names.join(", "),
        "access-control-max-age": "600",
        ...(one(input.headers["access-control-request-private-network"]) === "true"
          ? { "access-control-allow-private-network": "true" }
          : {}),
      },
    };
  }
  if (
    input.upgrade &&
    (input.method !== "GET" || one(input.headers.upgrade)?.toLowerCase() !== "websocket")
  )
    return refuse(400, cors);
  const headers: Record<string, string> = {};
  const connectionFields = new Set(
    (one(input.headers.connection) ?? "").split(",").map((name) => name.trim().toLowerCase()),
  );
  for (const [name, value] of Object.entries(input.headers)) {
    if (
      !connectionFields.has(name) &&
      (allowed.has(name) || (input.upgrade && wsAllowed.has(name))) &&
      typeof value === "string"
    )
      headers[name] = value;
  }
  return {
    kind: input.upgrade ? "upgrade" : "forward",
    route,
    path,
    headers,
    responseHeaders: cors,
  };
}
