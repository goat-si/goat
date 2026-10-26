import { useEffect } from "react";

import { APP_VERSION } from "~/branding";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { createNewerHostUpdateCheck } from "./newerHostUpdateCheck.logic";

const checkWhenHostIsNewer = createNewerHostUpdateCheck(APP_VERSION, () => {
  const bridge = window.desktopBridge;
  // Older desktop builds and partial test bridges may lack the update API.
  if (typeof bridge?.checkForUpdate !== "function") return;
  void bridge.checkForUpdate().catch((error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: "Could not check for updates",
        description: error instanceof Error ? error.message : "Update check failed.",
      }),
    );
  });
});

/** Checks for an app update as soon as one of these hosts reports a newer GOAT. */
export function useCheckForUpdateWhenHostIsNewer(
  hostVersions: ReadonlyArray<string | null | undefined>,
) {
  const versionsKey = hostVersions.filter(Boolean).join("\n");
  useEffect(() => {
    for (const version of versionsKey.split("\n")) checkWhenHostIsNewer(version);
  }, [versionsKey]);
}
