import * as Schema from "effect/Schema";

import { AuthGrantScope } from "./auth.ts";
import { AuthSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ChildSetupPurpose } from "./opencodexChildReady.ts";
import { RuntimeMode } from "./providerPolicy.ts";

/**
 * Issues a credential from the running server itself, for an SSH client attaching to a server it
 * did not start (the GOAT app's own). It takes the same loopback peer and runtime control token as
 * a drain. Running `goat auth` against that server's base directory instead would open its live
 * database with whatever CLI version the host has installed.
 */
export const GOAT_RUNTIME_SESSION_PATH = "/.well-known/goat/runtime/session";

const RuntimeCredentialTtl = TrimmedNonEmptyString.check(Schema.isMaxLength(32));
const RuntimeCredentialLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(200));

/**
 * `session` answers like `goat auth session issue --json`, `pairing` like
 * `goat auth pairing create --json`. `revoke` ends one session on the running server, so a
 * Home can withdraw a Child setup bearer it delegated without opening that server's database.
 */
export const RuntimeSessionRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("session"),
    subject: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
    scopes: Schema.NonEmptyArray(AuthGrantScope),
    ttl: RuntimeCredentialTtl,
    label: Schema.optionalKey(RuntimeCredentialLabel),
    runtimeModeCeiling: Schema.optionalKey(RuntimeMode),
    childSetupPurpose: Schema.optionalKey(ChildSetupPurpose),
  }),
  Schema.Struct({
    kind: Schema.Literal("revoke"),
    sessionId: AuthSessionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("pairing"),
    ttl: Schema.optionalKey(RuntimeCredentialTtl),
    label: Schema.optionalKey(RuntimeCredentialLabel),
  }),
]);
export type RuntimeSessionRequest = typeof RuntimeSessionRequest.Type;

export const RuntimeSessionRevokeResult = Schema.Struct({
  sessionId: AuthSessionId,
  revoked: Schema.Boolean,
});
export type RuntimeSessionRevokeResult = typeof RuntimeSessionRevokeResult.Type;
