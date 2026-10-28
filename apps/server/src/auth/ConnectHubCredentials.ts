import {
  AuthHubProxyScope,
  AuthStandardClientScopes,
  type AuthWebSocketTicketUse,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as HubConnectAccess from "./HubConnectAccess.ts";
import * as PairingGrantStore from "./PairingGrantStore.ts";

export const make = Effect.gen(function* () {
  const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
  const connectAccess = yield* HubConnectAccess.HubConnectAccess;
  const createPairingLinkInternal: (
    input?: Parameters<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]>[0] & {
      readonly connectAccessGeneration?: number;
    },
  ) => ReturnType<EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"]> = Effect.fn(
    "EnvironmentAuth.createPairingLink",
  )(
    function* (input) {
      const createdAt = yield* DateTime.now;
      const issued = yield* bootstrapCredentials.issueOneTimeToken({
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(input?.ttl ? { ttl: input.ttl } : {}),
        ...(input?.label ? { label: input.label } : {}),
        ...(input?.proofKeyThumbprint ? { proofKeyThumbprint: input.proofKeyThumbprint } : {}),
        ...(input?.purpose ? { purpose: input.purpose } : {}),
        ...(input?.connectAccessGeneration !== undefined
          ? { connectAccessGeneration: input.connectAccessGeneration }
          : {}),
      });
      return {
        id: issued.id,
        credential: issued.credential,
        scopes: input?.scopes ?? AuthStandardClientScopes,
        subject: input?.subject ?? "one-time-token",
        ...(issued.label ? { label: issued.label } : {}),
        createdAt: DateTime.toUtc(createdAt),
        expiresAt: DateTime.toUtc(issued.expiresAt),
      } satisfies EnvironmentAuth.IssuedPairingLink;
    },
    Effect.mapError((cause) => new EnvironmentAuth.ServerAuthPairingLinkCreationError({ cause })),
  );

  const createPairingLink: EnvironmentAuth.EnvironmentAuth["Service"]["createPairingLink"] = (
    input,
  ) =>
    HubConnectAccess.isPrivilegedConnect({
      subject: input?.subject ?? "",
      scopes: input?.scopes ?? [],
    })
      ? Effect.fail(
          new EnvironmentAuth.ServerAuthPairingLinkCreationError({
            cause: "Use coordinated Connect issuance",
          }),
        )
      : createPairingLinkInternal(input);
  const createCloudConnectPairingLink: EnvironmentAuth.EnvironmentAuth["Service"]["createCloudConnectPairingLink"] =
    (input) =>
      connectAccess.withPolicy((state) => {
        const privileged = {
          subject: "cloud-connect",
          scopes: [AuthHubProxyScope],
          connectAccessGeneration: state.generation,
        };
        const allowed = HubConnectAccess.admits(privileged, state);
        return createPairingLinkInternal({
          ...input,
          subject: "cloud-connect",
          ttl: Duration.minutes(2),
          scopes: allowed
            ? [...AuthStandardClientScopes, AuthHubProxyScope]
            : AuthStandardClientScopes,
          ...(allowed ? { connectAccessGeneration: state.generation } : {}),
        });
      });

  const admit = Effect.fn("EnvironmentAuth.admitConnectHubAccess")(function* <
    A extends Parameters<typeof HubConnectAccess.admits>[0],
  >(credential: A) {
    if (!HubConnectAccess.admits(credential, yield* connectAccess.current))
      return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({
        diagnostic: "GOAT Connect hub access was withdrawn.",
      });
    return credential;
  });

  return { createPairingLink, createCloudConnectPairingLink, admit };
});

export function authenticatedSession(
  session: EnvironmentAuth.AuthenticatedSession,
): EnvironmentAuth.AuthenticatedSession {
  return {
    sessionId: session.sessionId,
    subject: session.subject,
    method: session.method,
    scopes: session.scopes,
    ...(session.connectAccessGeneration !== undefined
      ? { connectAccessGeneration: session.connectAccessGeneration }
      : {}),
    ...(session.proofKeyThumbprint ? { proofKeyThumbprint: session.proofKeyThumbprint } : {}),
    ...(session.expiresAt ? { expiresAt: session.expiresAt } : {}),
  };
}

export const admitSocketUse = Effect.fn("EnvironmentAuth.admitSocketUse")(function* (
  session: EnvironmentAuth.AuthenticatedSession & { readonly audience?: AuthWebSocketTicketUse },
  use: AuthWebSocketTicketUse,
) {
  if (
    use === "rpc" &&
    HubConnectAccess.isPrivilegedConnect(session) &&
    session.method === "dpop-access-token" &&
    session.proofKeyThumbprint === undefined
  )
    return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({
      diagnostic: "Connect hub RPC sockets require a key-bound ticket.",
    });
  if (session.audience !== undefined && session.audience !== use)
    return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({
      diagnostic: `WebSocket ticket was issued for the ${session.audience} route.`,
    });
});
