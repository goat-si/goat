import {
  AuthAccessMutationError,
  AuthHubProxyScope,
  AuthStandardClientScopes,
  type AuthCreatePairingCredentialInput,
  type AuthRevokeClientSessionInput,
  type AuthRevokePairingLinkInput,
  WS_METHODS,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSettings from "../serverSettings.ts";
import { hubProxyDelegationRefusal } from "./hubProxyDelegation.ts";
import { rpcAuthorizationError } from "./RpcAuthorization.ts";

export const make = Effect.fn("AuthAccessRpc.make")(function* (
  session: EnvironmentAuth.AuthenticatedSession,
) {
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const settings = yield* ServerSettings.ServerSettingsService;
  const holds = (scope: (typeof session.scopes)[number]) => session.scopes.includes(scope);
  const fail = (message: string) => new AuthAccessMutationError({ message });
  return {
    [WS_METHODS.authAccessCreatePairing]: Effect.fn("AuthAccessRpc.createPairing")(function* (
      input: AuthCreatePairingCredentialInput,
    ) {
      const scopes = input.scopes ?? AuthStandardClientScopes;
      if (scopes.length === 0 || new Set(scopes).size !== scopes.length)
        return yield* fail("Choose a nonempty set of distinct permissions.");
      for (const scope of scopes) {
        if (scope === AuthHubProxyScope) {
          const hubEnabled = yield* settings.getSettings.pipe(
            Effect.map((value) => value.hub.enabled),
            Effect.mapError(() => fail("Could not read hub settings.")),
          );
          const refusal = hubProxyDelegationRefusal(
            { subject: session.subject, holds },
            hubEnabled,
          );
          if (refusal?._tag === "ScopeRequired") return yield* rpcAuthorizationError(refusal.scope);
          if (refusal?._tag === "HubOff")
            return yield* fail("Enable the hub before granting hub access.");
        } else if (!holds(scope)) {
          return yield* rpcAuthorizationError(scope);
        }
      }
      return yield* auth
        .issuePairingCredential(input)
        .pipe(Effect.mapError(() => fail("Could not create the pairing link.")));
    }),
    [WS_METHODS.authAccessRevokePairing]: Effect.fn("AuthAccessRpc.revokePairing")(function* (
      input: AuthRevokePairingLinkInput,
    ) {
      const revoked = yield* auth
        .revokePairingLink(input.id)
        .pipe(Effect.mapError(() => fail("Could not revoke the pairing link.")));
      return { revoked };
    }),
    [WS_METHODS.authAccessRevokeClient]: Effect.fn("AuthAccessRpc.revokeClient")(function* (
      input: AuthRevokeClientSessionInput,
    ) {
      const revoked = yield* auth
        .revokeClientSession(session.sessionId, input.sessionId)
        .pipe(
          Effect.mapError((error) =>
            fail(
              error._tag === "ServerAuthForbiddenOperationError"
                ? "Cannot revoke the current client."
                : "Could not revoke the client.",
            ),
          ),
        );
      return { revoked };
    }),
  };
});
