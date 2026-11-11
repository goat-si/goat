import type { AuthEnvironmentScope } from "@goat/contracts";

/**
 * The Pen listener's whole HTTP surface, default deny (mesh link design §5). The raw parser gate
 * and the credential gate both read this table; anything it does not admit is refused before any
 * handler or upgrade runs.
 */
export type PenCredential = "none" | "agent" | "proxy";
type QueryPolicy = "none" | "proxy-read" | "websocket";

export interface PenRouteGrant {
  readonly credential: PenCredential;
  readonly scope?: AuthEnvironmentScope;
}
interface PenRoute {
  readonly methods: ReadonlySet<string>;
  readonly path: RegExp;
  readonly grants: ReadonlyArray<PenRouteGrant>;
  readonly query: QueryPolicy;
  readonly upgrade: boolean;
}

// A variable segment: unreserved and sub-delim characters or percent escapes (asset names are
// encodeURIComponent output), never an encoded slash, backslash, dot or NUL, so the router cannot
// resolve a different route than this table.
const VAR = String.raw`(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|%(?![2][Ff]|[5][Cc]|[2][Ee]|00)[0-9A-Fa-f]{2})+`;
const path = (pattern: string) => new RegExp(`^${pattern.replaceAll("<v>", VAR)}$`, "u");
const READ = new Set(["GET", "HEAD"]);
const proxyRead: ReadonlyArray<PenRouteGrant> = [
  { credential: "proxy", scope: "orchestration:read" },
];

const ROUTES: ReadonlyArray<PenRoute> = [
  {
    methods: READ,
    path: path(String.raw`/\.well-known/goat/environment`),
    grants: [{ credential: "none" }],
    query: "none",
    upgrade: false,
  },
  {
    methods: READ,
    path: path(String.raw`/\.well-known/t3/environment`), // goat-rename: legacy
    grants: [{ credential: "none" }],
    query: "none",
    upgrade: false,
  },
  {
    methods: new Set(["POST"]),
    path: path("/api/pen/session"),
    grants: [{ credential: "none" }],
    query: "none",
    upgrade: false,
  },
  {
    methods: new Set(["GET", "POST"]),
    path: path("/mcp"),
    grants: [{ credential: "agent" }],
    query: "none",
    upgrade: false,
  },
  {
    methods: new Set(["POST"]),
    path: path("/api/attachments/upload/<v>"),
    grants: [{ credential: "agent" }, { credential: "proxy", scope: "orchestration:operate" }],
    query: "none",
    upgrade: false,
  },
  {
    methods: READ,
    path: path("/api/orchestration/shell"),
    grants: proxyRead,
    query: "proxy-read",
    upgrade: false,
  },
  {
    methods: READ,
    path: path("/api/orchestration/threads/<v>(/(bounded|history|transcript))?"),
    grants: proxyRead,
    query: "proxy-read",
    upgrade: false,
  },
  {
    methods: READ,
    path: path("/api/projects"),
    grants: proxyRead,
    query: "proxy-read",
    upgrade: false,
  },
  {
    methods: READ,
    path: path("/api/assets/<v>/<v>"),
    grants: proxyRead,
    query: "proxy-read",
    upgrade: false,
  },
  {
    methods: new Set(["GET"]),
    path: path("/ws"),
    grants: [{ credential: "proxy" }],
    query: "websocket",
    upgrade: true,
  },
];

/** Query names that carry a credential anywhere in GOAT; never accepted in a Pen request. */
const CREDENTIAL_QUERY_NAMES: ReadonlySet<string> = new Set([
  "token",
  "wsTicket",
  "dpop",
  "access_token",
  "pairingToken",
]);
/** What the hub proxy forwards on an upstream socket (hubProxy/http.ts FORWARDED_WEBSOCKET_QUERY_PARAMS). */
const WEBSOCKET_QUERY_NAMES: ReadonlySet<string> = new Set([
  "orchestrationProtocol",
  "clientSurface",
  "clientAppVersion",
  "clientDeviceType",
  "clientOs",
  "clientWebDeployment",
  "clientBrowser",
  "clientOsMajorVersion",
  "clientDeviceModel",
  "connectionMethod",
]);

const queryAdmits = (policy: QueryPolicy, query: string | undefined) => {
  if (query === undefined) return true;
  if (policy === "none") return false;
  // Names are judged after the one decode URLSearchParams applies, as the router will see them.
  for (const name of new URLSearchParams(query).keys()) {
    if (CREDENTIAL_QUERY_NAMES.has(name)) return false;
    if (policy === "websocket" && !WEBSOCKET_QUERY_NAMES.has(name)) return false;
  }
  return true;
};

const hasDotSegment = (rawPath: string) =>
  rawPath.split("/").some((segment) => segment === "." || segment === "..");

export type PenAdmission =
  | { readonly kind: "admit"; readonly grants: ReadonlyArray<PenRouteGrant> }
  | { readonly kind: "refuse"; readonly status: 401 | 404 };

const REFUSED: PenAdmission = { kind: "refuse", status: 404 };

/**
 * Decides a Pen request from its raw request target and headers. Credentials are judged later by
 * the credential gate; here a credentialed row needs exactly one Bearer authorization, and no row
 * accepts a cookie or a DPoP proof, so no other credential source can be selected downstream.
 */
export const admitPenRequest = (input: {
  readonly method: string;
  readonly url: string;
  readonly upgrade: boolean;
  readonly headers: { readonly [name: string]: string | ReadonlyArray<string> | undefined };
}): PenAdmission => {
  const queryAt = input.url.indexOf("?");
  const rawPath = queryAt === -1 ? input.url : input.url.slice(0, queryAt);
  const query = queryAt === -1 ? undefined : input.url.slice(queryAt + 1);
  if (!rawPath.startsWith("/") || hasDotSegment(rawPath)) return REFUSED;
  const route = ROUTES.find(
    (candidate) =>
      candidate.methods.has(input.method) &&
      candidate.upgrade === input.upgrade &&
      candidate.path.test(rawPath),
  );
  if (route === undefined || !queryAdmits(route.query, query)) return REFUSED;
  if (input.headers["cookie"] !== undefined || input.headers["dpop"] !== undefined) return REFUSED;
  const authorization = input.headers["authorization"];
  if (route.grants.every((grant) => grant.credential === "none"))
    return authorization === undefined ? { kind: "admit", grants: route.grants } : REFUSED;
  if (typeof authorization !== "string" || !/^Bearer [^\s,]+$/u.test(authorization))
    return { kind: "refuse", status: 401 };
  return { kind: "admit", grants: route.grants };
};

/** The bearer token of a request the table admitted on a credentialed row. */
export const bearerOf = (authorization: string | ReadonlyArray<string> | undefined) =>
  typeof authorization === "string" && authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : undefined;
