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
import { useEffect, useRef, useState } from "react";
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

interface CreatedLink {
  readonly record: ServerPairingLinkRecord;
  readonly credential: string;
  readonly observed: boolean;
}

const MAX_CREATED_LINKS = 100;
const MAX_PENDING_OBSERVED_LINKS = 1_000;
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
  const [createdLinks, setCreatedLinks] = useState<ReadonlyMap<string, CreatedLink>>(
    () => new Map(),
  );
  const pendingCreation = useRef<{ seen: Set<string>; latest: AuthAccessSnapshot | null } | null>(
    null,
  );
  // oxlint-disable-next-line goat/react-effect-budget -- reconcile locally issued links with the server access stream
  useEffect(() => {
    if (snapshot === null) return;
    const pending = pendingCreation.current;
    if (pending !== null) {
      pending.latest = snapshot;
      for (const link of snapshot.pairingLinks.slice(-MAX_PENDING_OBSERVED_LINKS)) {
        pending.seen.add(link.id);
        if (pending.seen.size > MAX_PENDING_OBSERVED_LINKS) {
          const oldest = pending.seen.values().next();
          if (!oldest.done) pending.seen.delete(oldest.value);
        }
      }
    }
    if (createdLinks.size === 0) return;
    // oxlint-disable-next-line react/set-state-in-effect -- the external stream confirms and retires locally issued credentials
    setCreatedLinks((previous) => {
      const present = new Set<string>();
      for (const item of snapshot.pairingLinks) {
        if (previous.has(item.id)) present.add(item.id);
      }
      let next: Map<string, CreatedLink> | undefined;
      for (const [id, link] of previous) {
        if (present.has(id) && !link.observed) {
          next ??= new Map(previous);
          next.set(id, { ...link, observed: true });
        } else if (!present.has(id) && link.observed) {
          next ??= new Map(previous);
          next.delete(id);
        }
      }
      return next ?? previous;
    });
  }, [snapshot, createdLinks]);
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
    ...[...createdLinks.values()]
      .filter((link) => (!link.observed || snapshot === null) && !listedIds.has(link.record.id))
      .map((link) => link.record),
  ]);
  const credentials = new Map([...createdLinks].map(([id, link]) => [id, link.credential]));
  const clients = snapshot
    ? sortDesktopClientSessions(snapshot.clientSessions.map(toDesktopClientSessionRecord))
    : [];
  const create = async (
    input: AuthCreatePairingCredentialInput,
  ): Promise<AuthPairingCredentialResult> => {
    setError(null);
    props.onBusyChange?.(1);
    pendingCreation.current = { seen: new Set(), latest: snapshot };
    try {
      const { label, ...rest } = input;
      const trimmedLabel = label?.trim();
      const result = await createPairing({
        environmentId,
        input: { ...rest, ...(trimmedLabel ? { label: trimmedLabel } : {}) },
      });
      if (result._tag === "Success") {
        const created = result.value;
        const pending = pendingCreation.current;
        if (
          pending?.seen.has(created.id) &&
          pending.latest !== null &&
          !pending.latest.pairingLinks.some((link) => link.id === created.id)
        ) {
          setError("The pairing link was already used or revoked.");
          return created;
        }
        setCreatedLinks((previous) =>
          rememberLink(previous, created.id, {
            record: {
              id: created.id,
              subject: "one-time-token",
              scopes: input.scopes ?? [],
              ...(created.label === undefined ? {} : { label: created.label }),
              createdAt: new Date().toISOString(),
              expiresAt: DateTime.formatIso(created.expiresAt),
            },
            credential: created.credential,
            observed: false,
          }),
        );
        return created;
      }
      throw squashAtomCommandFailure(result);
    } finally {
      pendingCreation.current = null;
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
