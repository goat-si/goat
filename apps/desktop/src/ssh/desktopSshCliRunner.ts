import * as Option from "effect/Option";
import { cliReleaseDownloadBaseUrl } from "@goat/shared/cliRelease";
import type { RemoteGoatRunnerOptions } from "@goat/ssh/tunnel";

import type * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { validatedReleaseBaseUrl } from "../shell/desktopReleaseBaseUrl.ts";

const DEFAULT_RELEASE_BASE_URL = cliReleaseDownloadBaseUrl("").slice(0, -2);

type ReleaseNotice = (level: "info" | "warn", message: string) => void;

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
    "archiveDirectory" | "bundledArchiveDirectory" | "bundledFontAssetDirectory" | "releaseBaseUrl"
  >,
  serverPackage: { readonly version: string; readonly engines: { readonly node: string } },
  buildCommitTime?: number,
  shellEnvironment?: Readonly<Record<string, string | undefined>>,
  notice?: ReleaseNotice,
): RemoteGoatRunnerOptions => {
  const devRemoteEntryPath = Option.getOrUndefined(environment.devRemoteGoatServerEntryPath);
  if (environment.isDevelopment && devRemoteEntryPath !== undefined) {
    return {
      nodeScriptPath: devRemoteEntryPath,
      nodeEngineRange: serverPackage.engines.node,
    };
  }
  let effectiveOptions = archiveOptions;
  if (shellEnvironment !== undefined) {
    const candidate = validatedReleaseBaseUrl(shellEnvironment.GOAT_RELEASE_BASE_URL);
    const fallback = validatedReleaseBaseUrl(archiveOptions.releaseBaseUrl);
    if (candidate === undefined)
      notice?.(
        "warn",
        "Shell release mirror is unavailable or invalid; using the configured release source.",
      );
    const selected = candidate ?? fallback;
    const { releaseBaseUrl: _configured, ...otherOptions } = archiveOptions;
    effectiveOptions =
      selected === undefined ? otherOptions : { ...otherOptions, releaseBaseUrl: selected };
    const effective = selected ?? DEFAULT_RELEASE_BASE_URL;
    if (effective.replace(/\/+$/, "") !== DEFAULT_RELEASE_BASE_URL) {
      notice?.("info", `Using release mirror ${new URL(effective).host}`);
    }
  }
  const archiveVersion = environment.isPackaged ? environment.appVersion : serverPackage.version;
  return {
    archiveVersion,
    ownRuntimeVersion: archiveVersion,
    ...(buildCommitTime === undefined ? {} : { archiveCommitTime: buildCommitTime }),
    ...effectiveOptions,
    hostDownload: true,
    publishedFallback: true,
    attachAppServer: true,
    ...(environment.isPackaged ? { refreshOwnedRuntimeOnFirstConnection: true } : {}),
  };
};
