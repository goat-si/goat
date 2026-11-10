import type { Login } from "./login.ts";

export interface Env {
  readonly LOGIN: DurableObjectNamespace<Login>;
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  /** base64url Ed25519 seed (32 bytes); the session cookie key is derived from it. */
  readonly LOGIN_SIGNING_KEY: string;
  readonly GOOGLE_ISSUER?: string;
  readonly GOOGLE_DISCOVERY?: string;
  // Test overrides; each can only lower its default (see context.ts limits).
  readonly DEVICE_TTL_MS?: string;
  readonly SOURCE_SESSION_CAP?: string;
  readonly SOURCE_DEVICE_CAP?: string;
  readonly JWKS_TTL_MS?: string;
  readonly JWKS_REFETCH_MS?: string;
}
