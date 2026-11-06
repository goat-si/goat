import { AuthAccessReadScope, type EnvironmentId } from "@goat/contracts";
import { useState } from "react";
import type { EnvironmentPresentation } from "../../state/environments";
import { authEnvironment } from "../../state/auth";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentScope, useEnvironmentSessionState } from "../../state/session";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { isLocalEnvironmentDisabled } from "../../localEnvironment";
import { LocalEnvironmentSetting } from "./LocalEnvironmentSetting";
import { HeadlessServerSetting } from "./HeadlessServerSetting";
import { CloudLinkRow } from "./SavedEnvironmentRows";

export function SavedEnvironmentAccessSection({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const candidates = environments.filter((environment) => environment.entry.enabled);
  const selected =
    candidates.find((environment) => environment.environmentId === selectedId) ??
    candidates.find((environment) => environment.connection.phase === "connected") ??
    candidates[0];
  if (!selected) return null;
  return (
    <SettingsSection
      title="Service access"
      headerAction={
        candidates.length > 1 ? (
          <Select
            value={selected.environmentId}
            onValueChange={(value) => {
              if (value !== null) setSelectedId(value);
            }}
          >
            <SelectTrigger size="sm" aria-label="Environment">
              <SelectValue>{selected.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {candidates.map((environment) => (
                <SelectItem key={environment.environmentId} value={environment.environmentId}>
                  {environment.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        ) : undefined
      }
    >
      <SavedEnvironmentAccess
        key={selected.environmentId}
        environmentId={selected.environmentId}
        label={selected.label}
        connected={selected.connection.phase === "connected"}
      />
    </SettingsSection>
  );
}

export function SavedEnvironmentAccess({
  environmentId,
  label,
  connected,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
}) {
  const canRead = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const session = useEnvironmentSessionState(environmentId);
  const access = useEnvironmentQuery(
    connected && canRead ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const snapshot = access.data?.type === "snapshot" ? access.data.payload : null;
  if (!connected)
    return (
      <SettingsRow
        title={label}
        description="Connect this environment to view its service access."
      />
    );
  if (session.isPending) return <SettingsRow title={label} description="Loading service access…" />;
  if (session.hasError)
    return (
      <SettingsRow title={label} description="Could not read this connection's permissions." />
    );
  if (!canRead)
    return (
      <SettingsRow
        title={label}
        description="This connection does not have permission to view service access."
      />
    );
  if (access.error) return <SettingsRow title={label} description={access.error} />;
  if (!snapshot) return <SettingsRow title={label} description="Loading service access…" />;
  return (
    <>
      <SettingsRow
        title={label}
        description="Access is shown for this environment. Manage pairing links and clients on that environment."
      />
      {snapshot.pairingLinks.map((link) => (
        <SettingsRow
          key={link.id}
          title={link.label ?? "Pairing link"}
          description="Pairing link"
        />
      ))}
      {snapshot.clientSessions.map(({ sessionId, client, subject, connected }) => (
        <SettingsRow
          key={sessionId}
          title={client.label ?? subject}
          description={connected ? "Connected client" : "Authorized client"}
        />
      ))}
      {snapshot.pairingLinks.length === 0 && snapshot.clientSessions.length === 0 ? (
        <SettingsRow title="No authorized clients or pairing links" />
      ) : null}
    </>
  );
}

export function NoLocalEnvironmentSettings({
  environments,
  canReadRelay,
  canManageRelay,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  canReadRelay: boolean;
  canManageRelay: boolean;
}) {
  const localOff = isLocalEnvironmentDisabled();
  return (
    <>
      <SettingsSection {...searchableSetting("connections-environment")}>
        <SettingsRow
          title={localOff ? "Local environment is off" : "No environment selected"}
          description={
            localOff
              ? "Use a saved environment to view its service access."
              : "Connect an environment to view its settings and access."
          }
        />
        <LocalEnvironmentSetting />
        <HeadlessServerSetting />
        {canReadRelay || canManageRelay ? (
          <CloudLinkRow canReadRelay={canReadRelay} canManageRelay={canManageRelay} />
        ) : null}
      </SettingsSection>
      {localOff ? <SavedEnvironmentAccessSection environments={environments} /> : null}
    </>
  );
}
