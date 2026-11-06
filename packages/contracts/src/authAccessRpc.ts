import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import {
  AuthAccessStreamError,
  AuthAccessStreamEvent,
  AuthGrantScope,
  AuthGrantScopes,
  AuthPairingCredentialResult,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { AuthSessionId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AUTH_ACCESS_WS_METHODS = {
  subscribeAuthAccess: "subscribeAuthAccess",
  authAccessCreatePairing: "auth.access.createPairing",
  authAccessRevokePairing: "auth.access.revokePairing",
  authAccessRevokeClient: "auth.access.revokeClient",
} as const;

export class AuthAccessMutationError extends Schema.TaggedError<AuthAccessMutationError>()(
  "AuthAccessMutationError",
  {
    message: Schema.String,
  },
) {}

export const AuthAccessCreatePairingInput = Schema.Struct({
  label: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  scopes: Schema.optionalKey(
    AuthGrantScopes.check(Schema.isMaxLength(AuthGrantScope.literals.length)),
  ),
});
const revokePairingInput = Schema.Struct({
  id: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
});
const revokeClientInput = Schema.Struct({
  sessionId: AuthSessionId.check(Schema.isMaxLength(512)),
});
const errors = Schema.Union([AuthAccessMutationError, EnvironmentAuthorizationError]);
const revokeResult = Schema.Struct({ revoked: Schema.Boolean });
export const Subscribe = Rpc.make(AUTH_ACCESS_WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  error: Schema.Union([AuthAccessStreamError, EnvironmentAuthorizationError]),
  stream: true,
});
export const CreatePairing = Rpc.make(AUTH_ACCESS_WS_METHODS.authAccessCreatePairing, {
  payload: AuthAccessCreatePairingInput,
  success: AuthPairingCredentialResult,
  error: errors,
});
export const RevokePairing = Rpc.make(AUTH_ACCESS_WS_METHODS.authAccessRevokePairing, {
  payload: revokePairingInput,
  success: revokeResult,
  error: errors,
});
export const RevokeClient = Rpc.make(AUTH_ACCESS_WS_METHODS.authAccessRevokeClient, {
  payload: revokeClientInput,
  success: revokeResult,
  error: errors,
});
