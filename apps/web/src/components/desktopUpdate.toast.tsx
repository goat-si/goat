import { gtFallback, useGT } from "gt-react";
import type { DesktopBridge, DesktopUpdateState } from "@goat/contracts";
import { ArrowRightIcon } from "~/components/solar";

import {
  type DesktopUpdateTranslate,
  getDesktopUpdateActionError,
  getDesktopUpdateActionTooltip,
  getDesktopUpdateCheckError,
  getDesktopUpdateDisabledReason,
  getDesktopUpdateDownloadedVersion,
  getDesktopUpdateReleaseUrl,
  shouldToastDesktopUpdateActionResult,
  translateDesktopUpdateMessage,
} from "./desktopUpdate.logic";
import type { ReportLocalUpdateError } from "./sidebar/useUpdateEverything";
import { stackedThreadToast, toastManager } from "./ui/toast";

type DesktopUpdateShell = Pick<DesktopBridge, "openExternal">;

export async function openDesktopUpdateReleaseNotes(
  shell: DesktopUpdateShell | undefined,
  releaseUrl: string,
  gt: DesktopUpdateTranslate = gtFallback,
): Promise<void> {
  try {
    if (shell && (await shell.openExternal(releaseUrl))) return;
  } catch {}
  toastManager.add({ type: "error", title: gt("Unable to open release notes") });
}

function ReleaseNotesLink({
  shell,
  releaseUrl,
}: {
  shell: DesktopUpdateShell;
  releaseUrl: string;
}) {
  const gt = useGT();
  return (
    <button
      className="ml-2 inline cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-4 transition-colors hover:text-foreground"
      onClick={() => {
        void openDesktopUpdateReleaseNotes(shell, releaseUrl, gt);
      }}
      type="button"
    >
      {gt("Read more")}
      <ArrowRightIcon
        aria-hidden
        className="ml-1 inline size-3 -rotate-45 align-[-0.125em]"
        strokeWidth={2.25}
      />
    </button>
  );
}

export function showDesktopUpdateDownloadedToast(
  shell: DesktopUpdateShell,
  state: DesktopUpdateState,
  gt: DesktopUpdateTranslate = gtFallback,
): void {
  const releaseUrl = getDesktopUpdateReleaseUrl(getDesktopUpdateDownloadedVersion(state));
  toastManager.add({
    type: "success",
    title: gt("Update downloaded"),
    description: (
      <>
        {gt("Restart the app from the update button to install it.")}
        {releaseUrl ? <ReleaseNotesLink releaseUrl={releaseUrl} shell={shell} /> : null}
      </>
    ),
  });
}

export const toastUpdateError: ReportLocalUpdateError = (title, description) => {
  toastManager.add(stackedThreadToast({ type: "error", title, description }));
};

type UpdateCheckBridge = Pick<DesktopBridge, "checkForUpdate" | "getUpdateState" | "onUpdateState">;

// Electron may acknowledge a check before publishing its outcome. Subscribe before
// reading the snapshot so a completion on either side of the reply is observed.
async function waitForCheckOutcome(bridge: UpdateCheckBridge, checking: DesktopUpdateState) {
  const outcome = Promise.withResolvers<DesktopUpdateState | null>();
  const observe = (state: DesktopUpdateState) => {
    if (state.channel !== checking.channel) outcome.resolve(null);
    else if (state.status !== "checking" && (state.checkedAt ?? "") >= (checking.checkedAt ?? ""))
      outcome.resolve(state);
  };
  const unsubscribe = bridge.onUpdateState(observe);
  // Release the manual action if the native updater stops sending events.
  const timeout = window.setTimeout(outcome.reject, 120_000);
  try {
    void bridge.getUpdateState().then(observe, outcome.reject);
    return await outcome.promise;
  } finally {
    window.clearTimeout(timeout);
    unsubscribe();
  }
}

async function reportUpdateCheck(bridge: UpdateCheckBridge, gt: DesktopUpdateTranslate) {
  try {
    const result = await bridge.checkForUpdate();
    if (!result.checked) {
      toastUpdateError(
        gt("Could not check for updates"),
        getDesktopUpdateDisabledReason(result.state, gt) ??
          translateDesktopUpdateMessage(result.state.message, gt) ??
          gt("Update check failed."),
      );
      return;
    }
    const state =
      result.state.status === "checking"
        ? await waitForCheckOutcome(bridge, result.state)
        : result.state;
    if (!state) return;
    const error = getDesktopUpdateCheckError(state, gt);
    if (error) {
      toastUpdateError(gt("Could not check for updates"), error);
    } else if (state.status === "up-to-date") {
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: `GOAT ${state.currentVersion}`,
          description: getDesktopUpdateActionTooltip(state, gt),
        }),
      );
    }
  } catch (error) {
    toastUpdateError(
      gt("Could not check for updates"),
      (error instanceof Error && error.message) || gt("Update check failed."),
    );
  }
}

let pendingCheck: Promise<void> | undefined;

export function checkLocalUpdate(
  bridge: UpdateCheckBridge,
  gt: DesktopUpdateTranslate,
): Promise<void> {
  pendingCheck ??= reportUpdateCheck(bridge, gt).finally(() => {
    pendingCheck = undefined;
  });
  return pendingCheck;
}

export async function downloadLocalUpdate(
  bridge: DesktopBridge,
  gt: DesktopUpdateTranslate,
  {
    notifyDownloaded,
    reportError = toastUpdateError,
  }: {
    readonly notifyDownloaded: boolean;
    readonly reportError?: ReportLocalUpdateError;
  },
): Promise<boolean> {
  try {
    const result = await bridge.downloadUpdate();
    if (result.completed && notifyDownloaded) {
      showDesktopUpdateDownloadedToast(bridge, result.state, gt);
    }
    const actionError = shouldToastDesktopUpdateActionResult(result)
      ? translateDesktopUpdateMessage(getDesktopUpdateActionError(result), gt)
      : null;
    if (actionError) reportError(gt("Could not download update"), actionError);
    return result.completed;
  } catch (error) {
    reportError(
      gt("Could not start update download"),
      error instanceof Error ? error.message : gt("An unexpected error occurred."),
    );
    return false;
  }
}
