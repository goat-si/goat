import { SavedEnvironmentAccessView } from "./SavedEnvironmentAccessView";
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

function SavedEnvironmentAccessSection({
  environments,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const [selectedId, setSelectedId] = useState<EnvironmentId | null>(null);
  const [pendingChanges, setPendingChanges] = useState(0);
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
            disabled={pendingChanges > 0}
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
        onBusyChange={(delta) => setPendingChanges((count) => count + delta)}
      />
    </SettingsSection>
  );
}

export function SavedEnvironmentAccess({
  environmentId,
  label,
  connected,
  onBusyChange,
}: {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
  onBusyChange?: (delta: 1 | -1) => void;
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
  if (session.isPending && session.data === null)
    return <SettingsRow title={label} description="Loading service access…" />;
  if (session.hasError && session.data === null)
    return (
      <SettingsRow title={label} description="Could not read this connection's permissions." />
    );
  return (
    <SavedEnvironmentAccessView
      environmentId={environmentId}
      label={label}
      session={session.data}
      canRead={canRead}
      snapshot={snapshot}
      error={access.error}
      isPending={access.isPending}
      {...(onBusyChange ? { onBusyChange } : {})}
    />
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
