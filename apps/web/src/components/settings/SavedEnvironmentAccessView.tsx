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
import { useState } from "react";
import { authEnvironment } from "../../state/auth";
import { useAtomCommand } from "../../state/use-atom-command";
import { usePreparedConnection } from "../../state/session";
import { useEnvironment } from "../../state/environments";
import { SettingsRow } from "./settingsLayout";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";
import { AuthorizedClientsHeaderAction, PairingClientsList } from "./AuthorizedClientsSettings";
import {
  sortDesktopClientSessions,
  sortDesktopPairingLinks,
  toDesktopClientSessionRecord,
  toDesktopPairingLinkRecord,
} from "./ConnectionsSettings.logic";

const NO_PAIRING_CREDENTIALS: ReadonlyMap<string, string> = new Map();

function OneTimePairingCode(props: {
  credential: string;
  endpointUrl: string | null;
  onDismiss: () => void;
}) {
  const [copyError, setCopyError] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: "pairing code",
    onError: () => setCopyError(true),
  });
  const url =
    props.endpointUrl === null
      ? null
      : (resolveHostedPairingUrl(props.endpointUrl, props.credential) ??
        resolveDesktopPairingUrl(props.endpointUrl, props.credential));
  const value = url ?? props.credential;
  const label = url === null ? "Pairing code" : "Pairing link";
  return (
    <SettingsRow
      title={label}
      description="Copy this now. It will not be shown again after you dismiss it."
    >
      <div className="flex flex-col gap-2 pb-2">
        <Textarea
          aria-label={label}
          readOnly
          value={value}
          rows={2}
          onFocus={(event) => event.currentTarget.select()}
        />
        {copyError ? (
          <p role="alert" className="text-xs text-destructive">
            Could not copy. Select the text and copy it manually.
          </p>
        ) : null}
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              setCopyError(false);
              copyToClipboard(value, undefined);
            }}
          >
            {isCopied ? "Copied" : url === null ? "Copy code" : "Copy link"}
          </Button>
          <Button size="xs" variant="outline" onClick={props.onDismiss}>
            Done
          </Button>
        </div>
      </div>
    </SettingsRow>
  );
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
  const [oneTimeCode, setOneTimeCode] = useState<string | null>(null);
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
  const visibleLinks = sortDesktopPairingLinks(links);
  const clients = snapshot
    ? sortDesktopClientSessions(snapshot.clientSessions.map(toDesktopClientSessionRecord))
    : [];
  const create = async (
    input: AuthCreatePairingCredentialInput,
  ): Promise<AuthPairingCredentialResult> => {
    setError(null);
    props.onBusyChange?.(1);
    try {
      const { label, ...rest } = input;
      const trimmedLabel = label?.trim();
      const result = await createPairing({
        environmentId,
        input: { ...rest, ...(trimmedLabel ? { label: trimmedLabel } : {}) },
      });
      if (result._tag === "Success") return result.value;
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
          createAllowed && delegatableScopes.length > 0 && oneTimeCode === null ? (
            <AuthorizedClientsHeaderAction
              environmentId={environmentId}
              createPairingCredential={create}
              showRevokeOthers={false}
              delegatableScopes={delegatableScopes}
              clientSessions={props.canRead && snapshot ? clients : null}
              isRevokingOtherClients={false}
              onRevokeOtherClients={() => {}}
              onPairingLinkCreated={(created) => {
                setOneTimeCode(created.credential);
              }}
            />
          ) : undefined
        }
      />
      {oneTimeCode !== null ? (
        <OneTimePairingCode
          credential={oneTimeCode}
          endpointUrl={endpointUrl}
          onDismiss={() => setOneTimeCode(null)}
        />
      ) : null}
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
      {snapshot ? (
        <PairingClientsList
          servedByEnvironment={false}
          endpointUrl={endpointUrl}
          endpoints={[]}
          defaultEndpointKey={null}
          isLoading={props.isPending}
          pairingLinks={visibleLinks}
          createdPairingCredentials={NO_PAIRING_CREDENTIALS}
          sharedPairingLinkId={null}
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
