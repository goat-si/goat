// @effect-diagnostics globalFetch:off - A plain Cloudflare Worker with no Effect runtime.
import { base64url, fromBase64url } from "@goat/pen-protocol/login";
import { sha256 } from "@goat/pen-protocol/identity";
import type { Env } from "./env.ts";
import { isLocalHost } from "./http.ts";

const GOOGLE_DISCOVERY = "https://accounts.google.com/.well-known/openid-configuration";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const DISCOVERY_TTL_MS = 3_600_000;

export interface Provider {
  readonly discovery: string;
  readonly issuers: ReadonlyArray<string>;
  readonly clientId: string;
  readonly clientSecret: string;
}

/** Google, unless a test issuer is configured and both it and this request are on localhost. */
export function provider(env: Env, requestUrl: URL): Provider {
  const credentials = { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET };
  const discovery = env.GOOGLE_DISCOVERY;
  if (discovery && env.GOOGLE_ISSUER && isLocalHost(requestUrl.hostname)) {
    const parsed = URL.canParse(discovery) ? new URL(discovery) : null;
    if (parsed && isLocalHost(parsed.hostname))
      return { discovery, issuers: [env.GOOGLE_ISSUER], ...credentials };
  }
  return { discovery: GOOGLE_DISCOVERY, issuers: GOOGLE_ISSUERS, ...credentials };
}

export interface Endpoints {
  readonly authorization: string;
  readonly token: string;
  readonly jwks: string;
}

export class OidcError extends Error {}

function endpointUrl(value: unknown, discovery: URL): string {
  if (typeof value !== "string" || !URL.canParse(value)) throw new OidcError("discovery");
  const url = new URL(value);
  const local =
    discovery.protocol === "http:" && isLocalHost(discovery.hostname) && isLocalHost(url.hostname);
  if (url.protocol !== "https:" && !local) throw new OidcError("discovery");
  return url.toString();
}

const discoveries = new Map<string, { endpoints: Endpoints; at: number }>();

export async function endpoints(target: Provider, now: number): Promise<Endpoints> {
  const cached = discoveries.get(target.discovery);
  if (cached && now - cached.at < DISCOVERY_TTL_MS) return cached.endpoints;
  const response = await fetch(target.discovery);
  if (!response.ok) throw new OidcError("discovery");
  const document = (await response.json()) as Record<string, unknown>;
  const base = new URL(target.discovery);
  const found = {
    authorization: endpointUrl(document.authorization_endpoint, base),
    token: endpointUrl(document.token_endpoint, base),
    jwks: endpointUrl(document.jwks_uri, base),
  };
  discoveries.set(target.discovery, { endpoints: found, at: now });
  return found;
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(await sha256(new TextEncoder().encode(verifier)));
}

export function authorizationUrl(
  found: Endpoints,
  target: Provider,
  params: { redirectUri: string; state: string; nonce: string; challenge: string },
): string {
  const url = new URL(found.authorization);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", target.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** Exchanges the authorization code; returns the raw id_token. */
export async function exchangeCode(
  found: Endpoints,
  target: Provider,
  params: { code: string; redirectUri: string; verifier: string },
): Promise<string> {
  const response = await fetch(found.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: target.clientId,
      client_secret: target.clientSecret,
      code_verifier: params.verifier,
    }).toString(),
  });
  if (!response.ok) throw new OidcError("token");
  const body = (await response.json()) as Record<string, unknown>;
  if (typeof body.id_token !== "string") throw new OidcError("token");
  return body.id_token;
}

interface Jwk {
  readonly kid?: string;
  readonly kty?: string;
  readonly n?: string;
  readonly e?: string;
}

/** Where verified keys are cached between requests. */
export interface JwksCache {
  jwks(url: string): { body: string; fetched_at: number } | null;
  saveJwks(url: string, body: string, at: number): void;
}

export interface JwksTiming {
  /** How long a fetched key set is used before it is fetched again. */
  readonly ttlMs: number;
  /** Least time between fetches made for an unknown kid. */
  readonly refetchMs: number;
}

const DEFAULT_TIMING: JwksTiming = { ttlMs: 3_600_000, refetchMs: 300_000 };

/** A key set, or null when the body is not one. */
function parseJwks(body: string): Array<Jwk> | null {
  try {
    const value = JSON.parse(body) as { keys?: unknown };
    return Array.isArray(value.keys) ? (value.keys as Array<Jwk>) : null;
  } catch {
    return null;
  }
}

/** Last fetch attempt per JWKS URL, kept in memory: a failing endpoint is not retried on every request. */
const attempts = new Map<string, number>();

/** Fetches and parses the key set and saves it only when it parsed; null on any failure. */
async function refresh(cache: JwksCache, url: string, now: number): Promise<Array<Jwk> | null> {
  attempts.set(url, now);
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const body = await response.text();
    const keys = parseJwks(body);
    if (keys) cache.saveJwks(url, body, now);
    return keys;
  } catch {
    return null;
  }
}

/** The key for kid: a stale or missing set is refreshed, an unknown kid refetches at most once per refetch window. */
async function jwkFor(
  cache: JwksCache,
  url: string,
  kid: string,
  now: number,
  timing: JwksTiming,
): Promise<Jwk | null> {
  const cached = cache.jwks(url);
  let keys = cached ? parseJwks(cached.body) : null;
  const lastTry = Math.max(cached?.fetched_at ?? 0, attempts.get(url) ?? 0);
  if (!keys || !cached || now - cached.fetched_at >= timing.ttlMs)
    keys = (await refresh(cache, url, now)) ?? keys;
  let key = keys?.find((candidate) => candidate.kid === kid) ?? null;
  const triedNow = attempts.get(url) === now;
  if (!key && !triedNow && now - lastTry >= timing.refetchMs) {
    keys = (await refresh(cache, url, now)) ?? keys;
    key = keys?.find((candidate) => candidate.kid === kid) ?? null;
  }
  return key;
}

export interface Identity {
  readonly sub: string;
  readonly email: string;
}

function decodeJson(part: string): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(fromBase64url(part)),
  );
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new OidcError("token");
  return value as Record<string, unknown>;
}

/** Verifies an RS256 id_token and returns the account it names. */
export async function verifyIdToken(
  cache: JwksCache,
  found: Endpoints,
  target: Provider,
  idToken: string,
  expected: { nonce: string; now: number },
  timing: JwksTiming = DEFAULT_TIMING,
): Promise<Identity> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new OidcError("token");
  const [headerPart = "", payloadPart = "", signaturePart = ""] = parts;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    header = decodeJson(headerPart);
    claims = decodeJson(payloadPart);
    signature = fromBase64url(signaturePart);
  } catch {
    throw new OidcError("token");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new OidcError("token");
  const jwk = await jwkFor(cache, found.jwks, header.kid, expected.now, timing);
  if (!jwk || jwk.kty !== "RSA" || !jwk.n || !jwk.e) throw new OidcError("signature");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signed)))
    throw new OidcError("signature");

  const audience = claims.aud;
  const audienceOk =
    audience === target.clientId ||
    (Array.isArray(audience) &&
      audience.includes(target.clientId) &&
      claims.azp === target.clientId);
  const nowSeconds = Math.floor(expected.now / 1000);
  if (typeof claims.iss !== "string" || !target.issuers.includes(claims.iss))
    throw new OidcError("issuer");
  if (!audienceOk) throw new OidcError("audience");
  if (typeof claims.exp !== "number" || claims.exp <= nowSeconds) throw new OidcError("expired");
  if (typeof claims.nonce !== "string" || claims.nonce !== expected.nonce)
    throw new OidcError("nonce");
  if (claims.email_verified !== true && claims.email_verified !== "true")
    throw new OidcError("email");
  if (typeof claims.sub !== "string" || claims.sub === "" || claims.sub.length > 255)
    throw new OidcError("token");
  if (typeof claims.email !== "string" || claims.email === "" || claims.email.length > 254)
    throw new OidcError("email");
  return { sub: claims.sub, email: claims.email };
}
