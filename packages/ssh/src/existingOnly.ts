import { SshLaunchError, type SshCommandError } from "./errors.ts";
import type { RemoteGoatRunnerOptions, PreparedRemoteRuntime } from "./remoteRuntime.ts";

export const existingOnly = (value: RemoteGoatRunnerOptions | undefined): boolean =>
  value?.installation === "existing-only";

export const existingOnlyError = (
  alias: string,
  message = `${alias} has no GOAT this app can attach to without installing one.`,
) => new SshLaunchError({ reason: "existing-runtime-required", message, stdout: "" });

export const launchFlags = (
  runner: RemoteGoatRunnerOptions | undefined,
  selection: PreparedRemoteRuntime,
) => ({
  requireInstalled: existingOnly(runner) || selection.requireInstalled,
  upgrade: !existingOnly(runner) && selection.mayUpgradeOwnedServer,
  refresh: !existingOnly(runner) && selection.mayUpgradeOwnedServer && selection.refreshIfIdle,
});

export const restrictedRunner = (runner: RemoteGoatRunnerOptions | undefined) => ({
  ...runner,
  installation: "existing-only" as const,
});

export const existingRunnerError = (
  error: SshCommandError,
  runner: RemoteGoatRunnerOptions | undefined,
  alias: string,
) =>
  existingOnly(runner) &&
  /GOAT_EXISTING_RUNNER_REQUIRED|Selected retained (?:GOAT runner bytes changed|runner changed|runner changed while copying)|Running runner changed before publication/u.test(
    error.stderr,
  )
    ? existingOnlyError(alias)
    : error;
