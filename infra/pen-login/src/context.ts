import type { SigningKey } from "@goat/pen-protocol/identity";
import type { LoginKey } from "@goat/pen-protocol/login";
import type { Env } from "./env.ts";
import type { Store } from "./store.ts";

export interface LoginSigner {
  readonly key: SigningKey;
  readonly public: LoginKey;
}

/** What one request handler needs; source, country and city come from the Worker, never from the client. */
export interface Context {
  readonly env: Env;
  readonly store: Store;
  readonly limits: Limits;
  readonly now: number;
  readonly url: URL;
  readonly origin: string;
  readonly source: string;
  readonly country: string;
  readonly city: string;
  loginKey(): Promise<LoginSigner>;
  /** HMAC key for the session cookie and its CSRF tokens. */
  sessionKey(): Promise<CryptoKey>;
}

const RATES = { start: 10, page: 20, registry: 30, tokenMiss: 10 } as const;

/** Counts this request against its per-source, per-minute bucket; true when over the limit. */
export function limited(ctx: Context, bucket: keyof typeof RATES): boolean {
  return ctx.store.hit(`${bucket}:${ctx.source}`, ctx.now) > RATES[bucket];
}

export const POLL_INTERVAL_S = 2;

export interface Limits {
  readonly deviceTtlMs: number;
  /** Live browser sessions (signed in or on their way to Google) per source. */
  readonly sourceSessions: number;
  /** Live device codes per source. */
  readonly sourceDevices: number;
  readonly jwksTtlMs: number;
  /** Least time between JWKS fetches made for an unknown kid. */
  readonly jwksRefetchMs: number;
}

const DEFAULTS: Limits = {
  deviceTtlMs: 600_000,
  sourceSessions: 40,
  sourceDevices: 20,
  jwksTtlMs: 3_600_000,
  jwksRefetchMs: 300_000,
};

/** A test override may only lower its default; anything else means the default. */
function lowered(raw: string | undefined, max: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value >= 0 && value <= max ? value : max;
}

export function readLimits(env: Env): Limits {
  return {
    deviceTtlMs: lowered(env.DEVICE_TTL_MS, DEFAULTS.deviceTtlMs),
    sourceSessions: lowered(env.SOURCE_SESSION_CAP, DEFAULTS.sourceSessions),
    sourceDevices: lowered(env.SOURCE_DEVICE_CAP, DEFAULTS.sourceDevices),
    jwksTtlMs: lowered(env.JWKS_TTL_MS, DEFAULTS.jwksTtlMs),
    jwksRefetchMs: lowered(env.JWKS_REFETCH_MS, DEFAULTS.jwksRefetchMs),
  };
}
