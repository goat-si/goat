import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@goat/client-runtime/platform";
import type { DesktopConnectionCatalogUnreadable } from "@goat/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

const TITLE = "Saved environments couldn't be unlocked";
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

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
        unreadable.reason === "locked"
          ? "Another GOAT app saved them with a key this app can't read. GOAT kept the file and did not change it."
          : "The saved environments file is damaged. GOAT kept the file and did not change it.",
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
  const [startingFresh, setStartingFresh] = useState(false);
  if (unreadable === null) return null;

  const startFresh = async () => {
    const save = window.desktopBridge?.setConnectionCatalog;
    if (save === undefined || unreadable.backupPath === null) return;
    const message = [
      "Start with no saved environments?",
      `GOAT replaces the unreadable file with an empty list and keeps its copy at ${unreadable.backupPath}.`,
    ].join("\n");
    // The first-run recovery screen shows this before the themed dialog host mounts.
    const confirmed = await (requestConfirmDialog(message, { variant: "destructive" }) ??
      Promise.resolve(window.confirm(message)));
    if (!confirmed) return;
    setStartingFresh(true);
    const replaceCatalog = async () => {
      // An empty catalog, not a removed file: a missing file re-imports legacy environments.
      const stored = await save(encodeCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT), null);
      if (stored === "conflict") {
        throw new Error("Another app changed the saved environments. Reload and try again.");
      }
      if (!stored) {
        throw new Error("Secure storage is unavailable.");
      }
      // The renderer's catalog cache is per page; reload to start from the empty catalog.
      window.location.reload();
    };
    await replaceCatalog().catch((error: unknown) => {
      setStartingFresh(false);
      toastManager.add({
        type: "error",
        title: "Could not start fresh",
        description: error instanceof Error ? error.message : String(error),
      });
    });
  };

  return (
    <Alert variant="error" controlAlignment="first-line">
      <AlertTitle>{TITLE}</AlertTitle>
      <AlertDescription>
        <p>
          {unreadable.reason === "locked"
            ? "Another GOAT app, such as GOAT (Nightly) or a dev build, saved them with a key this app can't read."
            : "The saved environments file is damaged."}{" "}
          The file is unchanged at <code className="break-all">{unreadable.catalogPath}</code>
          {unreadable.backupPath === null ? (
            ". GOAT could not make a copy of it, so it will not replace the file."
          ) : (
            <>
              , and a copy is at <code className="break-all">{unreadable.backupPath}</code>.
            </>
          )}
        </p>
        {unreadable.reason === "locked" ? (
          <p>
            To get them back, quit and reopen GOAT, then choose Allow when your system asks to use
            the other GOAT app's key. You can also open them in the GOAT app that saved them.
          </p>
        ) : (
          <p>To continue, start fresh and add your environments again.</p>
        )}
      </AlertDescription>
      {unreadable.backupPath === null ? null : (
        <AlertAction>
          <Button
            size="sm"
            variant="outline"
            disabled={startingFresh}
            onClick={() => void startFresh()}
          >
            {startingFresh ? "Starting fresh…" : "Start fresh"}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
