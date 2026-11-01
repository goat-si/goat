import type { SshHostFailure } from "@goat/contracts";
import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  cliArchiveFileName,
  isPublishableCliReleaseVersion,
} from "@goat/shared/cliRelease";
import { type PublishedRuntimeMiss } from "./runtimePublished.ts";
import { SshCommandError, SshInvalidTargetError, SshLaunchError } from "./errors.ts";

/**
 * SSH failures (an unreachable host, a timeout, rejected authentication) keep their own error
 * and message, so they never read as a missing runtime archive. Anything else is wrapped with
 * its message attached.
 */
export const runtimePreparationError = (cause: unknown) =>
  cause instanceof SshLaunchError ||
  cause instanceof SshCommandError ||
  cause instanceof SshInvalidTargetError
    ? cause
    : new SshLaunchError({
        message: `Failed to prepare the SSH runtime archive: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        stdout: "",
        cause,
      });

/** A failure to read or fetch the archive itself: supplying another archive is the remedy. */
export const archiveSupplyError = (cause: unknown, action?: string) => {
  const error = runtimePreparationError(cause);
  return error instanceof SshLaunchError && error.reason === undefined
    ? new SshLaunchError({
        reason: "archive-unavailable",
        message: error.message,
        stdout: error.stdout,
        ...(error.acquisition === undefined ? {} : { acquisition: error.acquisition }),
        ...(action === undefined ? {} : { action }),
        cause: error.cause,
      })
    : error;
};

/** The single next step for a host that has no runtime this app can start. */
export function missAction(miss: PublishedRuntimeMiss, asset: string, directory: string): string {
  switch (miss) {
    case "unreachable":
      return "Check that this computer can reach github.com, then reconnect.";
    case "client-too-old":
      return "Update this app, then reconnect.";
    case "none":
      return directory === ""
        ? "Install a published GOAT release on this computer, then reconnect."
        : `Put ${asset} in ${directory}, then reconnect.`;
  }
}

/** One sentence for what failed and one for the fix; the acquisition detail goes to the log. */
export function archiveUnavailableText(
  alias: string,
  error: SshLaunchError,
  acquisition: NonNullable<SshLaunchError["acquisition"]>,
  directory: string,
) {
  const key = CLI_ARCHIVE_PLATFORM_KEYS.find((candidate) => candidate === acquisition.platformKey);
  if (key === undefined) {
    const action = "Use Linux, an Apple Silicon Mac, or Windows.";
    return {
      message: `GOAT has no runtime for ${alias} (${acquisition.platformKey}). ${action}`,
      action,
    };
  }
  const action =
    error.action ??
    (isPublishableCliReleaseVersion(acquisition.requestedVersion)
      ? missAction("unreachable", "", directory)
      : missAction("none", cliArchiveFileName(acquisition.requestedVersion, key), directory));
  return {
    message: `No GOAT runtime for ${key} that works with this app (GOAT ${acquisition.requestedVersion}) could be installed on ${alias}. ${action}`,
    action,
  };
}

export function archiveFailure(error: SshLaunchError): SshHostFailure | undefined {
  if (error.reason !== "archive-unavailable" || error.acquisition === undefined) return undefined;
  if (error.acquisition.platformKey === "darwin-x64") {
    return {
      reason: "unsupported_platform",
      fix: { actor: "human", instruction: "Use Linux, an Apple Silicon Mac, or Windows." },
    };
  }
  return {
    reason: "archive_unavailable",
    archive: error.acquisition,
    fix: {
      actor: "human",
      instruction:
        error.action ??
        `GOAT ${error.acquisition.requestedVersion} runtime archive is unavailable. Install a published GOAT release, or set a release mirror.`,
    },
  };
}
