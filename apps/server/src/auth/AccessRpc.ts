import {
  AuthAccessMutationError,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  AuthHubProxyScope,
  type AuthSessionId,
  authScopeResponse,
  AuthStandardClientScopes,
  type AuthCreatePairingCredentialInput,
  type AuthRevokeClientSessionInput,
  type AuthRevokePairingLinkInput,
  WS_METHODS,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { rpcInitialItems } from "../rpcInitialItems.ts";
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

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: { ...change.pairingLink, ...authScopeResponse(change.pairingLink.scopes) },
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          ...authScopeResponse(change.clientSession.scopes),
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

export const makeStream = Effect.fn("AuthAccessRpc.makeStream")(function* (
  currentSessionId: AuthSessionId,
) {
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const sessions = yield* SessionStore.SessionStore;
  const loadAuthAccessSnapshot = () =>
    Effect.all({
      pairingLinks: serverAuth.listPairingLinks(),
      clientSessions: serverAuth.listClientSessions(currentSessionId),
    }).pipe(
      Effect.mapError(
        (error) =>
          new AuthAccessStreamError({
            message: error.message,
          }),
      ),
    );
  return {
    [WS_METHODS.subscribeAuthAccess]: (_input: unknown) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const initialSnapshot = yield* loadAuthAccessSnapshot();
          const revisionRef = yield* Ref.make(1);
          const accessChanges: Stream.Stream<
            PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
          > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

          const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
            Stream.mapEffect((change) =>
              Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                Effect.map((revision) =>
                  toAuthAccessStreamEvent(change, revision, currentSessionId),
                ),
              ),
            ),
          );

          return Stream.concat(
            rpcInitialItems([
              {
                version: 1 as const,
                revision: 1,
                type: "snapshot" as const,
                payload: initialSnapshot,
              },
            ]),
            liveEvents,
          );
        }),
      ),
  };
});
