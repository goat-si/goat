import type { DesktopConnectionCatalogUnreadable } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const TITLE = "Saved environments couldn't be unlocked";

/** The desktop's saved connection catalog when no key this app has can open it. */
function useConnectionCatalogUnreadable() {
  const [unreadable, setUnreadable] = useState<DesktopConnectionCatalogUnreadable | null>(null);
  useEffect(() => {
    const read = window.desktopBridge?.getConnectionCatalogUnreadable;
    if (read === undefined) return;
    let active = true;
    void read()
      .then((value) => {
        if (active) setUnreadable(value);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  return unreadable;
}

// One toast per launch, across remounts and Strict Mode effect replay.
let toastShown = false;

/** Mounted once at the root, so missing environments do not go unexplained. */
export function ConnectionCatalogUnreadableToast() {
  const unreadable = useConnectionCatalogUnreadable();
  const navigate = useNavigate();
  useEffect(() => {
    if (unreadable === null || toastShown) return;
    toastShown = true;
    const id = toastManager.add({
      type: "error",
      title: TITLE,
      description:
        "Another GOAT app saved them with a key this app can't read. GOAT kept the file and did not change it.",
      timeout: 0,
      actionProps: {
        children: "Open Connections",
        onClick: () => {
          toastManager.close(id);
          void navigate({ to: "/settings/connections" });
        },
      },
    });
  }, [navigate, unreadable]);
  return null;
}

/** Explains what happened, where the copy is, and how to restore or start fresh. */
export function ConnectionCatalogUnreadableAlert() {
  const unreadable = useConnectionCatalogUnreadable();
  const [clearing, setClearing] = useState(false);
  if (unreadable === null) return null;

  const startFresh = async () => {
    const clear = window.desktopBridge?.clearConnectionCatalog;
    if (clear === undefined || unreadable.backupPath === null) return;
    const confirmed = await (requestConfirmDialog(
      [
        "Start with no saved environments?",
        `GOAT removes the unreadable file and keeps its copy at ${unreadable.backupPath}.`,
      ].join("\n"),
      { variant: "destructive" },
    ) ?? false);
    if (!confirmed) return;
    setClearing(true);
    try {
      await clear();
      // The renderer's catalog cache is per page; reload to start from the empty catalog.
      window.location.reload();
    } catch (error) {
      setClearing(false);
      toastManager.add({
        type: "error",
        title: "Could not start fresh",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <Alert variant="error" controlAlignment="first-line">
      <AlertTitle>{TITLE}</AlertTitle>
      <AlertDescription>
        <p>
          Another GOAT app, such as GOAT (Nightly) or a dev build, saved them with a key this app
          can't read. The file is unchanged at{" "}
          <code className="break-all">{unreadable.catalogPath}</code>
          {unreadable.backupPath === null ? (
            ". GOAT could not make a copy of it, so it will not replace the file."
          ) : (
            <>
              , and a copy is at <code className="break-all">{unreadable.backupPath}</code>.
            </>
          )}
        </p>
        <p>
          To get them back, quit and reopen GOAT, then choose Allow when your system asks to use the
          other GOAT app's key. You can also open them in the GOAT app that saved them.
        </p>
      </AlertDescription>
      {unreadable.backupPath === null ? null : (
        <AlertAction>
          <Button size="sm" variant="outline" disabled={clearing} onClick={() => void startFresh()}>
            {clearing ? "Starting fresh…" : "Start fresh"}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
