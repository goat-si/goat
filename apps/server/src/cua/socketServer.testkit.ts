// @effect-diagnostics nodeBuiltinImport:off -- Fake X11 and D-Bus servers listen on Unix socket paths.
import type * as NodeNet from "node:net";

import * as HostProcess from "@goat/shared/HostProcess";

/** X11 and AT-SPI are Linux-only and reached over a socket path; Windows cannot listen on one. */
export const canListenOnSocketPath = HostProcess.Platform.defaultValue() !== "win32";

/** Rejects when the path cannot be listened on, so the test fails instead of waiting for a peer. */
export const listenOnSocketPath = (server: NodeNet.Server, path: string) =>
  new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
