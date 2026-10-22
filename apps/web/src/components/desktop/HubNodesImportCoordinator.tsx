import { isHubNodesUnsupportedError } from "@goat/client-runtime/hub-nodes";
import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { useEffect } from "react";
import { environmentCatalog } from "~/connection/catalog";
import { usePrimaryEnvironment } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { catalogToImportInput } from "./hubNodesImport.logic";

const attemptedEnvironments = new Set<string>();

export function HubNodesImportCoordinator() {
  const primary = usePrimaryEnvironment();
  const environmentId = primary?.environmentId ?? null;
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const permitted = useAtomValue(serverEnvironment.importHubNodes.permissionAtom(environmentId));
  const importNodes = useAtomCommand(serverEnvironment.importHubNodes, { reportFailure: false });
  const connected = primary?.connection.phase === "connected";
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      !environmentId ||
      !connected ||
      !permitted ||
      !catalog.isReady ||
      attemptedEnvironments.has(environmentId)
    )
      return;
    attemptedEnvironments.add(environmentId);
    const run = async () => {
      const unreadable = await bridge.getConnectionCatalogUnreadable?.();
      const input =
        unreadable?.reason === "locked" || unreadable?.reason === "damaged"
          ? { source: "desktop-catalog" as const, catalog: { state: "locked" as const } }
          : catalogToImportInput(catalog.entries.values());
      const result = await importNodes({ environmentId, input });
      if (result._tag === "Failure" && !isHubNodesUnsupportedError(result.cause))
        console.warn("Hub device import failed", squashAtomCommandFailure(result));
    };
    void run().catch((error: unknown) => {
      if (!isHubNodesUnsupportedError(error)) console.warn("Hub device import failed");
    });
  }, [environmentId, connected, permitted, catalog, importNodes]);
  return null;
}
