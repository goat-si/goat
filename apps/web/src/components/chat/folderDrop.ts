import type { PreparedConnection } from "@goat/client-runtime/connection";
import {
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type EnvironmentId,
  type DesktopBridge,
} from "@goat/contracts";

import { desktopLocalBackendId, isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isLoopbackHostname } from "~/environments/primary/target";

export type FolderDropTarget = "local" | "remote" | { wslBackendId: string };

export function folderDropTarget(input: {
  localEnvironmentDisabled: boolean;
  environmentId: EnvironmentId;
  primaryEnvironmentId: EnvironmentId | null;
  connection: Pick<PreparedConnection, "target" | "httpBaseUrl"> | null;
  isDesktopRenderer: boolean;
  primaryRunsInWsl?: boolean;
}): FolderDropTarget {
  if (
    !input.localEnvironmentDisabled &&
    input.primaryEnvironmentId !== null &&
    input.environmentId === input.primaryEnvironmentId
  ) {
    return input.isDesktopRenderer && input.primaryRunsInWsl
      ? { wslBackendId: PRIMARY_LOCAL_ENVIRONMENT_ID }
      : "local";
  }
  if (!input.isDesktopRenderer || input.connection === null) return "remote";
  const backendId = desktopLocalBackendId(input.connection.target);
  if (backendId?.startsWith("wsl:")) {
    return input.localEnvironmentDisabled ? "remote" : { wslBackendId: backendId };
  }
  return isSavedLoopbackConnection(input.connection) ? "local" : "remote";
}

// A direct saved connection to loopback shares the desktop's filesystem; SSH forwards do not.
function isSavedLoopbackConnection({
  target,
  httpBaseUrl,
}: Pick<PreparedConnection, "target" | "httpBaseUrl">): boolean {
  if (target._tag !== "BearerConnectionTarget" || isDesktopLocalConnectionTarget(target)) {
    return false;
  }
  try {
    return isLoopbackHostname(new URL(httpBaseUrl).hostname);
  } catch {
    return false;
  }
}

export function resolveDroppedFolderPath(
  folder: File,
  getPathForFile: ((file: File) => string) | undefined,
): string | null {
  const path = getPathForFile?.(folder);
  return typeof path === "string" && path.length > 0 ? path : null;
}

export async function insertDroppedComposerFolders(input: {
  folders: readonly File[];
  target: Exclude<FolderDropTarget, "remote">;
  signal: AbortSignal;
  bridge: Pick<DesktopBridge, "getPathForFile" | "toLocalBackendPath"> | undefined;
  onUnavailable: (folder: File) => void;
  insert: (path: string) => boolean;
}): Promise<void> {
  for (const folder of input.folders) {
    if (input.signal.aborted) return;
    let path: string | null;
    try {
      path = resolveDroppedFolderPath(folder, input.bridge?.getPathForFile);
      if (path !== null && typeof input.target !== "string") {
        path = (await input.bridge?.toLocalBackendPath?.(input.target.wslBackendId, path)) ?? null;
      }
    } catch {
      path = null;
    }
    if (input.signal.aborted) return;
    if (path === null) input.onUnavailable(folder);
    else if (!input.insert(path)) return;
  }
}
