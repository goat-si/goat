import { useAtomValue } from "@effect/atom-react";
import {
  AuthHubProxyScope,
  type AuthAccessSnapshot,
  type AuthCreatePairingCredentialInput,
  type AuthPairingCredentialResult,
  type AuthSessionId,
  type AuthSessionState,
  type EnvironmentId,
} from "@goat/contracts";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import type { ServerPairingLinkRecord } from "~/environments/primary";
import { useState } from "react";
import { authEnvironment } from "../../state/auth";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { useEnvironment } from "../../state/environments";
import { SettingsRow } from "./settingsLayout";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";
import {
  sortDesktopClientSessions,
  sortDesktopPairingLinks,
  toDesktopClientSessionRecord,
  toDesktopPairingLinkRecord,
} from "./ConnectionsSettings.logic";

const MAX_CREATED_LINKS = 100;
function rememberLink<T>(
  previous: ReadonlyMap<string, T>,
  id: string,
  value: T,
): ReadonlyMap<string, T> {
  const next = new Map(previous);
  next.delete(id);
  next.set(id, value);
  if (next.size > MAX_CREATED_LINKS) {
    const oldest = next.keys().next();
    if (!oldest.done) next.delete(oldest.value);
  }
  return next;
}

export function SavedEnvironmentAccessView(props: {
  environmentId: EnvironmentId;
  label: string;
  session: AuthSessionState | null;
  canRead: boolean;
  snapshot: AuthAccessSnapshot | null;
  error: string | null;
  isPending: boolean;
  onBusyChange?: (delta: 1 | -1) => void;
}) {
  const { environmentId, snapshot } = props;
  const createAllowed = useAtomValue(authEnvironment.createPairing.permissionAtom(environmentId));
  const revokePairingAllowed = useAtomValue(
    authEnvironment.revokePairing.permissionAtom(environmentId),
  );
  const revokeClientAllowed = useAtomValue(
    authEnvironment.revokeClient.permissionAtom(environmentId),
  );
  const createPairing = useAtomCommand(authEnvironment.createPairing, { reportFailure: false });
  const revokePairing = useAtomCommand(authEnvironment.revokePairing, { reportFailure: false });
  const revokeClient = useAtomCommand(authEnvironment.revokeClient, { reportFailure: false });
  const prepared = usePreparedConnection(environmentId);
  const environment = useEnvironment(environmentId);
  const endpointUrl =
    Option.isSome(prepared) && prepared.value.target._tag === "BearerConnectionTarget"
      ? prepared.value.httpBaseUrl
      : null;
  const [credentials, setCredentials] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [createdLinks, setCreatedLinks] = useState<ReadonlyMap<string, ServerPairingLinkRecord>>(
    () => new Map(),
  );
  const [newestId, setNewestId] = useState<string | null>(null);
  const [revokingPairingId, setRevokingPairingId] = useState<string | null>(null);
  const [revokingClientId, setRevokingClientId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const held = props.session?.authenticated
    ? (props.session.permissions ?? props.session.scopes ?? [])
    : [];
  const ownScopes = held.filter((scope) => scope !== AuthHubProxyScope);
  const delegatableScopes =
    props.session?.canDelegateHubProxy === true &&
    environment?.serverConfig?.settings.hub.enabled === true
      ? [...ownScopes, AuthHubProxyScope]
      : ownScopes;
  const links = snapshot ? snapshot.pairingLinks.map(toDesktopPairingLinkRecord) : [];
  const listedIds = new Set(links.map((link) => link.id));
  const visibleLinks = sortDesktopPairingLinks([
    ...links,
    ...[...createdLinks.values()].filter((link) => !listedIds.has(link.id)),
  ]);
  const clients = snapshot
    ? sortDesktopClientSessions(snapshot.clientSessions.map(toDesktopClientSessionRecord))
    : [];
  const create = async (
    input: AuthCreatePairingCredentialInput,
  ): Promise<AuthPairingCredentialResult> => {
    props.onBusyChange?.(1);
    try {
      const { label, ...rest } = input;
      const trimmedLabel = label?.trim();
      const result = await createPairing({
        environmentId,
        input: { ...rest, ...(trimmedLabel ? { label: trimmedLabel } : {}) },
      });
      if (result._tag === "Success") {
        const created = result.value;
        setCreatedLinks((previous) =>
          rememberLink(previous, created.id, {
            id: created.id,
            subject: "one-time-token",
            scopes: input.scopes ?? [],
            ...(created.label === undefined ? {} : { label: created.label }),
            createdAt: new Date().toISOString(),
            expiresAt: DateTime.formatIso(created.expiresAt),
          }),
        );
        return created;
      }
      throw squashAtomCommandFailure(result);
    } finally {
      props.onBusyChange?.(-1);
    }
  };
  const revokeLink = async (id: string) => {
    setError(null);
    setRevokingPairingId(id);
    props.onBusyChange?.(1);
    try {
      const result = await revokePairing({ environmentId, input: { id } });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not revoke the pairing link.");
      } else if (!result.value.revoked) setError("That pairing link is no longer available.");
      else {
        setCreatedLinks((previous) => {
          const next = new Map(previous);
          next.delete(id);
          return next;
        });
        setCredentials((previous) => {
          const next = new Map(previous);
          next.delete(id);
          return next;
        });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the pairing link.");
    } finally {
      setRevokingPairingId(null);
      props.onBusyChange?.(-1);
    }
  };
  const revokeSession = async (sessionId: AuthSessionId) => {
    setError(null);
    setRevokingClientId(sessionId);
    props.onBusyChange?.(1);
    try {
      const result = await revokeClient({ environmentId, input: { sessionId } });
      if (result._tag === "Failure") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Could not revoke the client.");
      } else if (!result.value.revoked) setError("That client is no longer available.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not revoke the client.");
    } finally {
      setRevokingClientId(null);
      props.onBusyChange?.(-1);
    }
  };
  return (
    <>
      <SettingsRow
        title={props.label}
        description="Access is shown for this environment."
        control={
          createAllowed && delegatableScopes.length > 0 ? (
            <AuthorizedClientsHeaderAction
              environmentId={environmentId}
              createPairingCredential={create}
              showRevokeOthers={false}
              delegatableScopes={delegatableScopes}
              clientSessions={props.canRead && snapshot ? clients : null}
              isRevokingOtherClients={false}
              onRevokeOtherClients={() => {}}
              onPairingLinkCreated={(created) => {
                setNewestId(created.id);
                setCredentials((previous) =>
                  rememberLink(previous, created.id, created.credential),
                );
              }}
            />
          ) : undefined
        }
      />
      {error ? <SettingsRow title="Could not update access" description={error} /> : null}
      {!props.canRead ? (
        <SettingsRow
          title="Access details unavailable"
          description="This connection does not have permission to view service access."
        />
      ) : props.error ? (
        <SettingsRow title="Could not read service access" description={props.error} />
      ) : !snapshot ? (
        <SettingsRow title="Loading service access…" />
      ) : null}
      {snapshot || createdLinks.size > 0 ? (
        <PairingClientsList
          servedByEnvironment={false}
          endpointUrl={endpointUrl}
          endpoints={[]}
          defaultEndpointKey={null}
          isLoading={props.isPending}
          pairingLinks={visibleLinks}
          createdPairingCredentials={credentials}
          sharedPairingLinkId={newestId}
          clientSessions={clients}
          revokingPairingLinkId={revokingPairingId}
          revokingClientSessionId={revokingClientId}
          onRevokePairingLink={(id) => void revokeLink(id)}
          onRevokeClientSession={(id) => void revokeSession(id)}
          canRevoke={revokePairingAllowed && revokeClientAllowed}
        />
      ) : null}
    </>
  );
}
