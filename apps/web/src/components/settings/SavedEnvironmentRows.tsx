import { useEffect, useEffectEvent, useState } from "react";
import {
  AuthRelayWriteScope,
  connectReachabilityHelpUrl,
  formatConnectReachable,
} from "@goat/contracts";

import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useCloudLinkController } from "~/cloud/useCloudLinkController";

import { readEnvironmentScope } from "~/state/session";
import { usePrimaryEnvironmentId } from "~/state/environments";

function CloudLinkSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Enable GOAT Connect",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

function ConfiguredCloudLinkRow({ canManageRelay }: { readonly canManageRelay: boolean }) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const {
    isSignedIn,
    linkState: primaryCloudLinkState,
    linkRevoked,
    managedTunnelActive,
    managedTunnelOutOfSync,
    publishAgentActivity,
    holdWebhooksWhileOffline,
    operationError,
    reconcileCloudState,
  } = useCloudLinkController();
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUpdatingPreference, setIsUpdatingPreference] = useState(false);

  const disabledReason = !isSignedIn
    ? "Sign in to GOAT Connect to manage this environment."
    : !canManageRelay
      ? "Your session does not have permission to manage GOAT Connect access."
      : null;
  const isBusy = isUpdating || isUpdatingPreference;
  const refreshLinkState = useEffectEvent(primaryCloudLinkState.refresh);
  // The server rechecks reachability when the tunnel's 30 s readiness poll changes.
  // Poll while mounted, so a failed read does not stop later ones.
  useEffect(() => {
    const interval = window.setInterval(() => refreshLinkState(), 30_000);
    return () => window.clearInterval(interval);
  }, []);
  const reachability = managedTunnelActive ? primaryCloudLinkState.data?.reachability : undefined;
  const reachabilityStatus =
    reachability?.status === "reachable" ? (
      formatConnectReachable(reachability)
    ) : reachability?.status === "unreachable" ? (
      <span className="block text-destructive">
        {[reachability.reason, reachability.hint, `Fix: ${reachability.fix}`]
          .filter(Boolean)
          .join(" ")}{" "}
        <a
          href={connectReachabilityHelpUrl(reachability.cause)}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          More info
        </a>
      </span>
    ) : null;

  const updateManagedTunnel = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdating(true);
    const ok = await reconcileCloudState({ managedTunnel: enabled, publish: publishAgentActivity });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled
          ? "GOAT Connect linked"
          : publishAgentActivity
            ? "GOAT Connect tunnel disabled"
            : "GOAT Connect unlinked",
        description: enabled
          ? "This environment is available through GOAT Connect."
          : publishAgentActivity
            ? "The managed tunnel was removed. Agent activity publishing stays on."
            : "This environment is no longer available through GOAT Connect.",
      });
    }
    setIsUpdating(false);
  };

  const updatePublishAgentActivity = async (enabled: boolean) => {
    if (
      primaryEnvironmentId === null ||
      !readEnvironmentScope(primaryEnvironmentId, AuthRelayWriteScope)
    )
      return;
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({ managedTunnel: managedTunnelActive, publish: enabled });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Agent activity enabled" : "Agent activity disabled",
        description: enabled
          ? "This environment publishes agent activity to your mobile clients."
          : "This environment will stop publishing agent activity.",
      });
    }
    setIsUpdatingPreference(false);
  };

  const updateHoldWebhooks = async (enabled: boolean) => {
    setIsUpdatingPreference(true);
    const ok = await reconcileCloudState({
      managedTunnel: managedTunnelActive,
      publish: publishAgentActivity,
      holdWebhooksWhileOffline: enabled,
    });
    if (ok) {
      toastManager.add({
        type: "success",
        title: enabled ? "Webhooks held while offline" : "Webhooks no longer held",
        description: enabled
          ? "GOAT Connect keeps webhook requests for up to 24 hours while this environment is offline."
          : "Requests to an offline environment now fail. Anything already held is still delivered.",
      });
    }
    setIsUpdatingPreference(false);
  };

  return (
    <>
      {window.desktopBridge ? (
        <SettingsRow
          title={searchableSetting("goat-connect").title}
          description={
            linkRevoked
              ? "This environment was removed from GOAT Connect. Turn it on to link it again."
              : managedTunnelActive
                ? reachability?.status === "unreachable"
                  ? "GOAT Connect is on, but other devices cannot reach this environment."
                  : reachability?.status === "reachable"
                    ? "This environment is available to your other devices through GOAT Connect."
                    : "GOAT Connect is on. Reachability has not been checked yet."
                : managedTunnelOutOfSync
                  ? "GOAT Connect is out of sync. This environment is linked only to publish agent activity, so other devices cannot connect. Turn GOAT Connect on to repair it."
                  : "Make this environment available to your other devices through GOAT Connect."
          }
          status={operationError ?? primaryCloudLinkState.error ?? reachabilityStatus}
          control={
            <CloudLinkSwitch
              checked={managedTunnelActive}
              disabled={
                !canManageRelay ||
                !isSignedIn ||
                primaryCloudLinkState.data === null ||
                primaryCloudLinkState.isPending ||
                isBusy
              }
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updateManagedTunnel(enabled)}
            />
          }
        />
      ) : linkRevoked ? (
        <SettingsRow
          title={searchableSetting("goat-connect").title}
          description="This environment was removed from GOAT Connect. Run `goat connect link` on the host to link it again."
        />
      ) : null}
      <SettingsRow
        title={searchableSetting("publish-agent-activity").title}
        description="Send activity to mobile notifications and Live Activities without GOAT Connect."
        control={
          <CloudLinkSwitch
            ariaLabel="Publish agent activity to mobile clients"
            checked={publishAgentActivity}
            disabled={
              !canManageRelay ||
              !isSignedIn ||
              primaryCloudLinkState.data === null ||
              primaryCloudLinkState.isPending ||
              isBusy
            }
            disabledReason={disabledReason}
            onCheckedChange={(enabled) => void updatePublishAgentActivity(enabled)}
          />
        }
      />
      {managedTunnelActive ? (
        <SettingsRow
          title={searchableSetting("hold-webhooks-while-offline").title}
          description="Keep webhook requests for up to 24 hours while this environment is offline, then deliver them. Off: GOAT Connect only forwards requests and stores nothing."
          control={
            <CloudLinkSwitch
              ariaLabel="Hold webhook requests while this environment is offline"
              checked={holdWebhooksWhileOffline}
              disabled={!canManageRelay || !isSignedIn || primaryCloudLinkState.isPending || isBusy}
              disabledReason={disabledReason}
              onCheckedChange={(enabled) => void updateHoldWebhooks(enabled)}
            />
          }
        />
      ) : null}
    </>
  );
}

export function CloudLinkRow({
  canReadRelay,
  canManageRelay,
}: {
  readonly canReadRelay: boolean;
  readonly canManageRelay: boolean;
}) {
  if (!hasCloudPublicConfig()) return null;
  if (!canReadRelay) {
    return (
      <SettingsRow
        title="GOAT Connect"
        description="To edit these settings, pair this connection with both View relay and Manage relay permissions."
      />
    );
  }
  return <ConfiguredCloudLinkRow canManageRelay={canManageRelay} />;
}
