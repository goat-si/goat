// @effect-diagnostics globalDate:off - A plain Cloudflare Worker with no Effect runtime.
import { DurableObject } from "cloudflare:workers";
import { signingKeyFromSeed } from "@goat/pen-protocol/identity";
import { base64url, fromBase64url, loginKid } from "@goat/pen-protocol/login";
import { forget, keys, register, start, token } from "./api.ts";
import { type Context, type Limits, type LoginSigner, readLimits } from "./context.ts";
import type { Env } from "./env.ts";
import { CITY_HEADER, COUNTRY_HEADER, json, SOURCE_HEADER } from "./http.ts";
import { Store } from "./store.ts";
import {
  callback,
  confirm,
  confirmReset,
  enterPage,
  resetPage,
  startReset,
  submitCode,
} from "./web.ts";

type Handler = (ctx: Context, request: Request) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
  "GET /v1/keys": keys,
  "POST /v1/device/start": start,
  "POST /v1/device/token": token,
  "POST /v1/mesh/register": register,
  "POST /v1/mesh/forget": forget,
  "GET /device": enterPage,
  "POST /device": submitCode,
  "POST /device/confirm": confirm,
  "GET /reset": resetPage,
  "POST /reset": startReset,
  "POST /reset/confirm": confirmReset,
  "GET /v1/auth/google/callback": callback,
};

/** Device codes, browser sessions, rate counters and the registry: one instance, `idFromName("global")`. */
export class Login extends DurableObject<Env> {
  private readonly store: Store;
  private lastPrune = 0;
  private readonly limits: Limits;
  private signer: Promise<LoginSigner> | null = null;
  private cookieKey: Promise<CryptoKey> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new Store(ctx.storage);
    this.limits = readLimits(env);
  }

  private loginKey(): Promise<LoginSigner> {
    this.signer ??= (async () => {
      const key = await signingKeyFromSeed(fromBase64url(this.env.LOGIN_SIGNING_KEY));
      return { key, public: { kid: await loginKid(key.signPub), pub: base64url(key.signPub) } };
    })();
    return this.signer;
  }

  /** HMAC key for session cookies, derived from the login seed so no further secret is needed. */
  private sessionKey(): Promise<CryptoKey> {
    this.cookieKey ??= (async () => {
      const seed = await crypto.subtle.importKey(
        "raw",
        fromBase64url(this.env.LOGIN_SIGNING_KEY),
        "HKDF",
        false,
        ["deriveKey"],
      );
      return crypto.subtle.deriveKey(
        {
          name: "HKDF",
          hash: "SHA-256",
          salt: new Uint8Array(0),
          info: new TextEncoder().encode("pen-login/1 session cookie"),
        },
        seed,
        { name: "HMAC", hash: "SHA-256", length: 256 },
        false,
        ["sign", "verify"],
      );
    })();
    return this.cookieKey;
  }

  override async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    if (now - this.lastPrune > 60_000) {
      this.store.prune(now);
      this.lastPrune = now;
    }
    const url = new URL(request.url);
    const handler = ROUTES[`${request.method} ${url.pathname}`];
    if (!handler) return json({ error: "not_found" }, 404);
    const ctx: Context = {
      env: this.env,
      store: this.store,
      now,
      url,
      origin: url.origin,
      source: request.headers.get(SOURCE_HEADER) ?? "unknown",
      country: request.headers.get(COUNTRY_HEADER) ?? "",
      city: request.headers.get(CITY_HEADER) ?? "",
      loginKey: () => this.loginKey(),
      sessionKey: () => this.sessionKey(),
      limits: this.limits,
    };
    return handler(ctx, request);
  }
}
