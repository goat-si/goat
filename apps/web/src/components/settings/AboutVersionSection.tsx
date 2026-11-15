import { type DesktopUpdateChannel } from "@goat/contracts";
import { useState } from "react";

import { HAS_MOBILE_BETA_LINK, IS_NIGHTLY_BUILD, NightlyMobileBetaRow } from "../NightlyMobileBeta";
import { useCheckProviderUpdates } from "../ProviderUpdatesAction";
import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateIdleDescription,
  getDesktopUpdateInstallConfirmationMessage,
  getDesktopUpdateStatusText,
  isDesktopUpdateButtonDisabled,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AboutVersionTitle } from "./AboutVersionTitle";
import { CliCommandSettingsRow } from "./CliCommandSettingsRow";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow } from "./settingsLayout";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { ensureLocalApi } from "../../localApi";

export function AboutVersionSection() {
  const updateState = useDesktopUpdateState();
  const [isChangingUpdatePolicy, setIsChangingUpdatePolicy] = useState(false);
  const [isChangingUpdateChannel, setIsChangingUpdateChannel] = useState(false);
  const [isUpdateActionPending, setIsUpdateActionPending] = useState(false);
  const checkProviderUpdates = useCheckProviderUpdates();
  const hasDesktopBridge = typeof window !== "undefined" && Boolean(window.desktopBridge);
  const selectedUpdateChannel = updateState?.channel ?? "latest";
  // Show the beta app links as soon as someone picks Nightly, before the update installs.
  const showNightlyMobileBeta =
    HAS_MOBILE_BETA_LINK &&
    (IS_NIGHTLY_BUILD || (hasDesktopBridge && selectedUpdateChannel === "nightly"));
  const handleUpdateChannelChange = (channel: DesktopUpdateChannel) => {
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.setUpdateChannel !== "function" ||
      channel === selectedUpdateChannel
    ) {
      return;
    }
    setIsChangingUpdateChannel(true);
    void bridge
      .setUpdateChannel(channel)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not change update track",
            description: error instanceof Error ? error.message : "Update track change failed.",
          }),
        );
      })
      .finally(() => {
        setIsChangingUpdateChannel(false);
      });
  };
  const handleButtonClick = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
    if (action === "download") {
      void bridge.downloadUpdate().catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not download update",
            description: error instanceof Error ? error.message : "Download failed.",
          }),
        );
      });
      return;
    }
    if (action === "install") {
      if (isUpdateActionPending) return;
      setIsUpdateActionPending(true);
      let confirmed = false;
      try {
        confirmed = await ensureLocalApi().dialogs.confirm(
          getDesktopUpdateInstallConfirmationMessage(
            updateState ?? { availableVersion: null, downloadedVersion: null },
          ),
          { initialFocus: "confirm" },
        );
      } catch (error) {
        setIsUpdateActionPending(false);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not confirm update",
            description: error instanceof Error ? error.message : "Update confirmation failed.",
          }),
        );
        return;
      }
      if (!confirmed) {
        setIsUpdateActionPending(false);
        return;
      }
      void bridge
        .installUpdate()
        .catch((error: unknown) => {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not install update",
              description: error instanceof Error ? error.message : "Install failed.",
            }),
          );
        })
        .finally(() => setIsUpdateActionPending(false));
      return;
    }
    if (typeof bridge.checkForUpdate !== "function") return;
    void checkProviderUpdates();
    void bridge
      .checkForUpdate()
      .then((result) => {
        if (!result.checked) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not check for updates",
              description:
                result.state.message ?? "Automatic updates are not available in this build.",
            }),
          );
        }
      })
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not check for updates",
            description: error instanceof Error ? error.message : "Update check failed.",
          }),
        );
      });
  };
  const action = updateState ? resolveDesktopUpdateButtonAction(updateState) : "none";
  const buttonTooltip = updateState ? getDesktopUpdateButtonTooltip(updateState) : null;
  const buttonDisabled =
    action === "none"
      ? !canCheckForUpdate(updateState)
      : isDesktopUpdateButtonDisabled(updateState);
  const actionLabel: Record<string, string> = { download: "Download", install: "Install" };
  const statusLabel: Record<string, string> = {
    checking: "Checking…",
    downloading: "Downloading…",
    "up-to-date": "Up to Date",
  };
  const buttonLabel =
    actionLabel[action] ?? statusLabel[updateState?.status ?? ""] ?? "Check for Updates";
  const description =
    updateState?.installationNotice ??
    (action === "download" || action === "install"
      ? "Update available."
      : getDesktopUpdateIdleDescription(updateState));

  return (
    <>
      <SettingsRow
        id={searchableSetting("app-version").id}
        title={<AboutVersionTitle />}
        description={description}
        control={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={buttonDisabled || isUpdateActionPending}
                  onClick={handleButtonClick}
                >
                  {buttonLabel}
                </Button>
              }
            />
            {buttonTooltip ? <TooltipPopup>{buttonTooltip}</TooltipPopup> : null}
          </Tooltip>
        }
      />
      {hasDesktopBridge &&
      updateState &&
      typeof window.desktopBridge?.setUpdateInstallPolicy === "function" ? (
        <SettingsRow
          id={searchableSetting("update-install-policy").id}
          title="Update installation"
          description={getDesktopUpdateStatusText(updateState)}
          control={
            <Select
              value={updateState.installPolicy}
              onValueChange={(value) => {
                if (
                  value !== "restart-when-idle" &&
                  value !== "install-on-quit" &&
                  value !== "paused"
                )
                  return;
                const bridge = window.desktopBridge;
                if (
                  !bridge ||
                  typeof bridge.setUpdateInstallPolicy !== "function" ||
                  value === updateState.installPolicy
                )
                  return;
                setIsChangingUpdatePolicy(true);
                void bridge
                  .setUpdateInstallPolicy(value)
                  .catch((error: unknown) => {
                    toastManager.add(
                      stackedThreadToast({
                        type: "error",
                        title: "Could not change update installation",
                        description:
                          error instanceof Error ? error.message : "Update policy change failed.",
                      }),
                    );
                  })
                  .finally(() => setIsChangingUpdatePolicy(false));
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-48"
                aria-label="Update installation"
                disabled={isChangingUpdatePolicy}
              >
                <SelectValue>
                  {updateState.installPolicy === "restart-when-idle"
                    ? "Restart when idle"
                    : updateState.installPolicy === "install-on-quit"
                      ? "Install on quit"
                      : "Paused"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="restart-when-idle">
                  Restart when idle
                </SelectItem>
                <SelectItem hideIndicator value="install-on-quit">
                  Install on quit
                </SelectItem>
                <SelectItem hideIndicator value="paused">
                  Paused
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {hasDesktopBridge ? (
        <SettingsRow
          {...searchableSetting("update-track")}
          description="Use stable releases or nightly builds. Switch back anytime."
          control={
            <Select
              value={selectedUpdateChannel}
              onValueChange={(value) => {
                handleUpdateChannelChange(value as DesktopUpdateChannel);
              }}
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-40"
                aria-label="Update track"
                disabled={isChangingUpdateChannel}
              >
                <SelectValue>
                  {selectedUpdateChannel === "nightly" ? "Nightly" : "Stable"}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="latest">
                  Stable
                </SelectItem>
                <SelectItem hideIndicator value="nightly">
                  Nightly
                </SelectItem>
              </SelectPopup>
            </Select>
          }
        />
      ) : null}
      {showNightlyMobileBeta ? <NightlyMobileBetaRow /> : null}
      {hasDesktopBridge ? <CliCommandSettingsRow /> : null}
    </>
  );
}
