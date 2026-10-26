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
 *
 * `buildCommitTime` is this build's commit time. It lets the remote order the
 * requested archive against an idle runtime of the same version core, such as an
 * older dev or nightly build, so that runtime is refreshed instead of reused.
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
  buildCommitTime?: number,
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
    ...(buildCommitTime === undefined ? {} : { archiveCommitTime: buildCommitTime }),
    ...archiveOptions,
    hostDownload: true,
    publishedFallback: true,
    attachAppServer: true,
    ...(environment.isPackaged ? { refreshOwnedRuntimeOnFirstConnection: true } : {}),
  };
};
