import { gtFallback, useGT } from "gt-react";
import type { DesktopBridge, DesktopUpdateState } from "@goat/contracts";
import { ArrowRightIcon } from "~/components/solar";

import {
  type DesktopUpdateTranslate,
  getDesktopUpdateActionError,
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
