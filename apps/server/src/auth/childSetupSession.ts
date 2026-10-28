import { ChildSetupPurpose, childSetupPurposeIsLive } from "@goat/contracts";
import * as Schema from "effect/Schema";

import { MCP_CLIENT_SUBJECT } from "./mcpClientSubject.ts";

const isChildSetupPurpose = Schema.is(ChildSetupPurpose);

interface SessionAuthority {
  readonly subject?: string | undefined;
  readonly method?: string | undefined;
  readonly scopes?: ReadonlyArray<string> | undefined;
}

/**
 * A Child setup purpose rides only on a read-scoped MCP bearer: tool admission, never its
 * scopes, decides which setup writes it may make, so any broader scope would escape that gate.
 */
const readScopedMcpBearer = (authority: SessionAuthority) =>
  authority.subject === MCP_CLIENT_SUBJECT &&
  authority.method === "bearer-access-token" &&
  authority.scopes?.length === 1 &&
  authority.scopes[0] === "orchestration:read";

export const refused = () => new Error("Invalid Child setup purpose or authority.");

/**
 * The lifetime to sign: the requested one, capped at the purpose's expiry when a purpose rides
 * along. Undefined refuses the issue: an invalid or expired purpose, or authority beyond read.
 */
export const ttlMs = (
  input:
    | (SessionAuthority & {
        readonly childSetupPurpose?: unknown;
        readonly proofKeyThumbprint?: string | undefined;
      })
    | undefined,
  issuedAt: number,
  requestedMs: number,
): number | undefined => {
  const purpose = input?.childSetupPurpose;
  if (input === undefined || purpose === undefined) return requestedMs;
  return isChildSetupPurpose(purpose) &&
    childSetupPurposeIsLive(purpose, issuedAt) &&
    input.proofKeyThumbprint === undefined &&
    readScopedMcpBearer(input)
    ? Math.min(requestedMs, purpose.expiresAt - issuedAt)
    : undefined;
};

/** Signed claims re-checked on every verification, before the revocation lookup. */
export const claimsValid = (
  claims: {
    readonly csp?: ChildSetupPurpose | undefined;
    readonly sub: string;
    readonly method: string;
    readonly scopes: ReadonlyArray<string>;
    readonly exp: number;
  },
  now: number,
) =>
  claims.csp === undefined ||
  (childSetupPurposeIsLive(claims.csp, now) &&
    claims.exp <= claims.csp.expiresAt &&
    readScopedMcpBearer({ subject: claims.sub, method: claims.method, scopes: claims.scopes }));
