import type { Login } from "./login.ts";

export interface Env {
  readonly LOGIN: DurableObjectNamespace<Login>;
  readonly GOOGLE_CLIENT_ID: string;
  readonly GOOGLE_CLIENT_SECRET: string;
  /** base64url Ed25519 seed (32 bytes). */
  readonly LOGIN_SIGNING_KEY: string;
  readonly GOOGLE_ISSUER?: string;
  readonly GOOGLE_DISCOVERY?: string;
  /** Test override, clamped to 600 000. */
  readonly DEVICE_TTL_MS?: string;
}
