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
  readonly now: number;
  readonly url: URL;
  readonly origin: string;
  readonly source: string;
  readonly country: string;
  readonly city: string;
  loginKey(): Promise<LoginSigner>;
}

const LIMITS = { start: 10, page: 20, registry: 30 } as const;

/** Counts this request against its per-source, per-minute bucket; true when over the limit. */
export function limited(ctx: Context, bucket: keyof typeof LIMITS): boolean {
  return ctx.store.hit(`${bucket}:${ctx.source}`, ctx.now) > LIMITS[bucket];
}

export const DEVICE_TTL_MS = 600_000;
export const POLL_INTERVAL_S = 2;

/** DEVICE_TTL_MS may only shorten the lifetime (tests); anything else means the default. */
export function deviceTtl(env: Env): number {
  const raw = env.DEVICE_TTL_MS;
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value >= 0 && value <= DEVICE_TTL_MS
    ? value
    : DEVICE_TTL_MS;
}
