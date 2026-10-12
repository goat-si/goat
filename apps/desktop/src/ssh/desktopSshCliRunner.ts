import * as Option from "effect/Option";
import type { RemoteGoatRunnerOptions } from "@goat/ssh/tunnel";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

/**
 * The remote runs the exact release this app is on, from its self-contained
 * archive, so it needs neither Node nor npm. Development can point the remote
 * at a source checkout instead so the two sides can be iterated together.
 *
 * An unpackaged app reports Electron's own version, which names no GOAT
 * release, so it uses the server package version that packaging would stamp.
 */
export const resolveDesktopSshCliRunner = (
  environment: Pick<
    DesktopEnvironment.DesktopEnvironment["Service"],
    "appVersion" | "isPackaged" | "isDevelopment" | "devRemoteGoatServerEntryPath"
  >,
  archiveOptions: Pick<
    RemoteGoatRunnerOptions,
    "archiveDirectory" | "bundledArchiveDirectory" | "releaseBaseUrl"
  >,
  serverPackage: { readonly version: string; readonly engines: { readonly node: string } },
): RemoteGoatRunnerOptions => {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteGoatServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackage.engines.node,
    };
  }
  return {
    archiveVersion: environment.isPackaged ? environment.appVersion : serverPackage.version,
    ...archiveOptions,
    ...(environment.isPackaged ? { refreshOwnedRuntimeOnFirstConnection: true } : {}),
  };
};
