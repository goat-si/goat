import { SshLaunchError, type SshCommandError } from "./errors.ts";
import * as Effect from "effect/Effect";
import type { RemoteGoatRunnerOptions, PreparedRemoteRuntime } from "./remoteRuntime.ts";

type Installation = { readonly installation?: "existing-only" | undefined } | undefined;

export const existingOnly = (value: Installation): boolean =>
  value?.installation === "existing-only";

export const existingOnlyError = (
  alias: string,
  message = `${alias} has no GOAT this app can attach to without installing one.`,
) => new SshLaunchError({ reason: "existing-runtime-required", message, stdout: "" });

/** An existing-only request never also asks to refresh or replace the runtime. */
export const refuseReplacement = (
  alias: string,
  request:
    | (Installation & {
        readonly refreshRuntime?: boolean;
        readonly confirmReplacement?: boolean;
        readonly forceReplace?: RemoteGoatRunnerOptions["forceReplace"];
      })
    | undefined,
) =>
  existingOnly(request) &&
  (request?.refreshRuntime || request?.confirmReplacement || request?.forceReplace)
    ? Effect.fail(
        existingOnlyError(
          alias,
          "existing-only contradicts refreshRuntime, confirmReplacement or forceReplace.",
        ),
      )
    : Effect.void;

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

/** The runner a request runs: an existing-only request never installs or replaces one. */
export const runnerFor = (request: Installation, runner: RemoteGoatRunnerOptions | undefined) =>
  existingOnly(request) ? restrictedRunner(runner) : runner;

export const restrictSelection = (request: Installation, selection: PreparedRemoteRuntime) =>
  existingOnly(request) ? { ...selection, runner: restrictedRunner(selection.runner) } : selection;

/** A credential request's selection; an ordinary request never reuses an existing-only one. */
export const selectionFor = (
  request: Installation,
  selection: PreparedRemoteRuntime | undefined,
) =>
  selection === undefined || (!existingOnly(request) && existingOnly(selection.runner))
    ? undefined
    : restrictSelection(request, selection);

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
