// @effect-diagnostics globalDate:off - A plain Cloudflare Worker with no Effect runtime.
import { fingerprint, sha256 } from "@goat/pen-protocol/identity";
import { base64url, fromBase64url } from "@goat/pen-protocol/login";
import { formatUserCode, normalizeUserCode } from "./api.ts";
import { type Context, limited } from "./context.ts";
import { cookie, readForm, sameText } from "./http.ts";
import {
  authorizationUrl,
  endpoints,
  exchangeCode,
  type Identity,
  OidcError,
  pkceChallenge,
  provider,
  randomToken,
  verifyIdToken,
} from "./oidc.ts";
import { page, type View } from "./pages.ts";
import { Caps, type SessionRow } from "./store.ts";

const COOKIE = "__Host-pen";
const SESSION_TTL_MS = 15 * 60_000;
const CALLBACK = "/v1/auth/google/callback";
const encoder = new TextEncoder();

/** A browser known by its signed cookie; it has a database row only once it set off to sign in. */
interface Visitor {
  readonly nonce: string;
  readonly idHash: string;
  readonly setCookie: string | null;
}

interface Session extends Visitor {
  readonly row: SessionRow;
}

async function mac(ctx: Context, text: string): Promise<string> {
  return base64url(
    new Uint8Array(await crypto.subtle.sign("HMAC", await ctx.sessionKey(), encoder.encode(text))),
  );
}

async function macMatches(ctx: Context, text: string, tag: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await ctx.sessionKey(),
      fromBase64url(tag),
      encoder.encode(text),
    );
  } catch {
    return false;
  }
}

async function hashNonce(nonce: string): Promise<string> {
  return base64url(await sha256(encoder.encode(nonce)));
}

/** The visitor named by a valid, unexpired cookie; with mint, a new one when there is none. Writes nothing. */
async function visitor(ctx: Context, request: Request, mint: boolean): Promise<Visitor | null> {
  const [nonce = "", expText = "", tag = ""] = (cookie(request, COOKIE) ?? "").split(".");
  const exp = Number(expText);
  if (
    nonce &&
    Number.isSafeInteger(exp) &&
    exp > ctx.now &&
    (await macMatches(ctx, `pen-login/1 cookie|${nonce}|${exp}`, tag))
  ) {
    return { nonce, idHash: await hashNonce(nonce), setCookie: null };
  }
  if (!mint) return null;
  const fresh = randomToken();
  const expires = ctx.now + SESSION_TTL_MS;
  const value = `${fresh}.${expires}.${await mac(ctx, `pen-login/1 cookie|${fresh}|${expires}`)}`;
  return {
    nonce: fresh,
    idHash: await hashNonce(fresh),
    setCookie: `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
  };
}

/** The CSRF token of the code and reset pages, derived from the cookie so showing them stores nothing. */
function pageCsrf(ctx: Context, current: Visitor): Promise<string> {
  return mac(ctx, `pen-login/1 csrf|${current.nonce}`);
}

async function session(ctx: Context, request: Request): Promise<Session | null> {
  const current = await visitor(ctx, request, false);
  const row = current ? ctx.store.session(current.idHash, ctx.now) : null;
  return current && row ? { ...current, row } : null;
}

/** Origins a form on these pages may land on: this site and the identity provider. */
function formOrigins(ctx: Context): Array<string> {
  return [new URL(provider(ctx.env, ctx.url).discovery).origin];
}

async function show(
  ctx: Context,
  view: View,
  status: number,
  current: Visitor | null = null,
): Promise<Response> {
  const response = await page(view, status, formOrigins(ctx));
  if (current?.setCookie) response.headers.append("set-cookie", current.setCookie);
  return response;
}

const REASONS = {
  session: {
    ko: "로그인 세션이 없거나 만료되었습니다.",
    en: "This sign-in session is missing or has expired.",
  },
  csrf: { ko: "이 양식은 더 이상 유효하지 않습니다.", en: "This form is no longer valid." },
  google: {
    ko: "Google 로그인을 확인하지 못했습니다.",
    en: "The Google sign-in could not be verified.",
  },
  unavailable: { ko: "Google 에 연결하지 못했습니다.", en: "Google could not be reached." },
  busy: { ko: "지금은 요청을 받을 수 없습니다.", en: "The service is too busy right now." },
} as const;

function error(
  ctx: Context,
  reason: keyof typeof REASONS,
  status: number,
  current: Visitor | null = null,
) {
  return show(ctx, { kind: "error", reason: REASONS[reason] }, status, current);
}

export async function enterPage(ctx: Context, request: Request): Promise<Response> {
  if (limited(ctx, "page")) return show(ctx, { kind: "limited" }, 429);
  const current = await visitor(ctx, request, true);
  if (!current) return error(ctx, "session", 400);
  return show(ctx, { kind: "enter", csrf: await pageCsrf(ctx, current) }, 200, current);
}

export async function resetPage(ctx: Context, request: Request): Promise<Response> {
  if (limited(ctx, "page")) return show(ctx, { kind: "limited" }, 429);
  const current = await visitor(ctx, request, true);
  if (!current) return error(ctx, "session", 400);
  return show(ctx, { kind: "resetStart", csrf: await pageCsrf(ctx, current) }, 200, current);
}

/** A form posted from the code or reset page by the browser that was shown it. */
async function pagePost(
  ctx: Context,
  request: Request,
): Promise<{ current: Visitor; form: URLSearchParams } | Response> {
  if (limited(ctx, "page")) return show(ctx, { kind: "limited" }, 429);
  const current = await visitor(ctx, request, false);
  if (!current) return error(ctx, "session", 403);
  const form = await readForm(request);
  if (!form || !sameText(form.get("csrf") ?? "", await pageCsrf(ctx, current)))
    return error(ctx, "csrf", 403);
  return { current, form };
}

/** A form posted from a page this session's row issued the CSRF token for (confirm, reset confirm). */
async function sessionPost(
  ctx: Context,
  request: Request,
): Promise<{ current: Session; form: URLSearchParams } | Response> {
  if (limited(ctx, "page")) return show(ctx, { kind: "limited" }, 429);
  const current = await session(ctx, request);
  if (!current) return error(ctx, "session", 403);
  const form = await readForm(request);
  if (!form || !sameText(form.get("csrf") ?? "", current.row.csrf)) return error(ctx, "csrf", 403);
  return { current, form };
}

/** The visitor's row, created now within the per-source and global caps; a Response when refused. */
function claimRow(ctx: Context, current: Visitor): Promise<Response> | null {
  if (ctx.store.session(current.idHash, ctx.now)) return null;
  if (ctx.store.liveSessionsFrom(ctx.source, ctx.now) >= ctx.limits.sourceSessions) {
    return show(ctx, { kind: "limited" }, 429);
  }
  if (ctx.store.liveSessions(ctx.now) >= Caps.SESSIONS) return error(ctx, "busy", 503);
  ctx.store.createSession(current.idHash, ctx.now + SESSION_TTL_MS, ctx.source);
  return null;
}

async function toGoogle(
  ctx: Context,
  current: Visitor,
  purpose: "device" | "reset",
  userCode = "",
): Promise<Response> {
  const target = provider(ctx.env, ctx.url);
  let found;
  try {
    found = await endpoints(target, ctx.now);
  } catch {
    return error(ctx, "unavailable", 502);
  }
  const refused = claimRow(ctx, current);
  if (refused) return refused;
  const state = randomToken();
  const verifier = randomToken(48);
  const nonce = randomToken();
  ctx.store.updateSession(current.idHash, {
    purpose,
    user_code: userCode,
    state,
    verifier,
    nonce,
    csrf: "",
    sub: "",
    email: "",
    started_at: ctx.store.stamp(ctx.now),
  });
  const location = authorizationUrl(found, target, {
    redirectUri: `${ctx.origin}${CALLBACK}`,
    state,
    nonce,
    challenge: await pkceChallenge(verifier),
  });
  return new Response(null, { status: 303, headers: { location } });
}

export async function submitCode(ctx: Context, request: Request): Promise<Response> {
  const posted = await pagePost(ctx, request);
  if (posted instanceof Response) return posted;
  const { current, form } = posted;
  if (ctx.store.lockedUntil(ctx.source) > ctx.now) return show(ctx, { kind: "locked" }, 429);
  const code = normalizeUserCode(form.get("code") ?? "");
  const device = code ? ctx.store.deviceByUserCode(code) : null;
  if (!code || !device) {
    const triesLeft = ctx.store.recordWrongCode(ctx.source, ctx.now);
    return show(ctx, { kind: "enter", csrf: await pageCsrf(ctx, current), triesLeft }, 400);
  }
  if (ctx.now >= device.expires_at) return show(ctx, { kind: "expired" }, 410);
  if (device.status !== "pending") return show(ctx, { kind: "used" }, 410);
  return toGoogle(ctx, current, "device", code);
}

export async function startReset(ctx: Context, request: Request): Promise<Response> {
  const posted = await pagePost(ctx, request);
  if (posted instanceof Response) return posted;
  return toGoogle(ctx, posted.current, "reset");
}

function place(city: string, country: string): string {
  let decoded = city;
  try {
    decoded = decodeURIComponent(city);
  } catch {
    decoded = "";
  }
  return [decoded, country].filter(Boolean).join(", ") || "알 수 없음 · Unknown";
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

async function signedIn(ctx: Context, current: Session, url: URL): Promise<Identity | null> {
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code") ?? "";
  const { state: expected, verifier, nonce } = current.row;
  // A callback is good once: forget the state before anything else can happen.
  ctx.store.updateSession(current.idHash, { state: "", verifier: "", nonce: "", csrf: "" });
  if (!code || !expected || !sameText(state, expected)) return null;
  const target = provider(ctx.env, ctx.url);
  try {
    const found = await endpoints(target, ctx.now);
    const idToken = await exchangeCode(found, target, {
      code,
      redirectUri: `${ctx.origin}${CALLBACK}`,
      verifier,
    });
    const timing = { ttlMs: ctx.limits.jwksTtlMs, refetchMs: ctx.limits.jwksRefetchMs };
    return await verifyIdToken(ctx.store, found, target, idToken, { nonce, now: ctx.now }, timing);
  } catch (cause) {
    // Unreachable endpoints, bad JSON and keys WebCrypto refuses all mean: not signed in.
    if (cause instanceof OidcError || cause instanceof TypeError || cause instanceof SyntaxError)
      return null;
    if (cause instanceof DOMException) return null;
    throw cause;
  }
}

export async function callback(ctx: Context, request: Request): Promise<Response> {
  if (limited(ctx, "page")) return show(ctx, { kind: "limited" }, 429);
  const current = await session(ctx, request);
  if (!current) return error(ctx, "session", 400);
  const identity = await signedIn(ctx, current, ctx.url);
  if (!identity) return error(ctx, "google", 400);
  // The account was reset after this sign-in went to Google: it predates the reset, so it ends here.
  if (current.row.started_at <= ctx.store.resetAt(identity.sub)) return error(ctx, "session", 403);
  if (current.row.purpose === "reset") {
    const csrf = randomToken();
    ctx.store.updateSession(current.idHash, { sub: identity.sub, email: identity.email, csrf });
    const meshId = ctx.store.meshOf(identity.sub);
    const nodes = ctx.store.nodesOf(identity.sub).length;
    return show(ctx, { kind: "resetConfirm", csrf, email: identity.email, meshId, nodes }, 200);
  }
  if (current.row.purpose !== "device") return error(ctx, "session", 400);
  const device = ctx.store.deviceByUserCode(current.row.user_code);
  if (!device || ctx.now >= device.expires_at) return show(ctx, { kind: "expired" }, 410);
  if (device.status !== "pending") return show(ctx, { kind: "used" }, 410);
  const csrf = randomToken();
  ctx.store.updateSession(current.idHash, { sub: identity.sub, email: identity.email, csrf });
  return show(
    ctx,
    {
      kind: "confirm",
      csrf,
      userCode: formatUserCode(device.user_code),
      name: device.name,
      fingerprint: await fingerprint(fromBase64url(device.noise_pub)),
      email: identity.email,
      place: place(device.city, device.country),
      time: utc(device.created_at),
    },
    200,
  );
}

const SIGNED_OUT = { purpose: "", user_code: "", csrf: "", sub: "", email: "" } as const;

export async function confirm(ctx: Context, request: Request): Promise<Response> {
  const posted = await sessionPost(ctx, request);
  if (posted instanceof Response) return posted;
  const { current, form } = posted;
  if (current.row.purpose !== "device" || !current.row.sub) return error(ctx, "session", 403);
  if (current.row.started_at <= ctx.store.resetAt(current.row.sub))
    return error(ctx, "session", 403);
  const action = form.get("action");
  if (action !== "approve" && action !== "deny") return error(ctx, "csrf", 400);
  const device = ctx.store.deviceByUserCode(current.row.user_code);
  const status = action === "approve" ? "approved" : "denied";
  const decided = ctx.store.decide(
    current.row.user_code,
    status,
    current.row.sub,
    current.row.email,
    ctx.now,
  );
  ctx.store.updateSession(current.idHash, SIGNED_OUT);
  if (!device || !decided) return show(ctx, { kind: "expired" }, 410);
  return show(
    ctx,
    action === "approve" ? { kind: "done", name: device.name } : { kind: "denied" },
    200,
  );
}

export async function confirmReset(ctx: Context, request: Request): Promise<Response> {
  const posted = await sessionPost(ctx, request);
  if (posted instanceof Response) return posted;
  const { current } = posted;
  if (current.row.purpose !== "reset" || !current.row.sub) return error(ctx, "session", 403);
  ctx.store.reset(current.row.sub, ctx.now);
  ctx.store.updateSession(current.idHash, SIGNED_OUT);
  return show(ctx, { kind: "resetDone" }, 200);
}
