import type { RemoteGoatRunnerOptions } from "./remoteRuntime.ts";
import type { SshEnvironmentEnsureOptions } from "./tunnel.ts";

/** Only preparation policy participates: tokens, callbacks and request identity are per waiter. */
export const preparationIntent = (
  runner: RemoteGoatRunnerOptions | undefined,
  requestOptions: SshEnvironmentEnsureOptions | undefined,
  background = false,
) =>
  JSON.stringify({
    background,
    keyOnly: requestOptions?.keyOnly === true,
    refreshRuntime: requestOptions?.refreshRuntime === true,
    confirmReplacement: requestOptions?.confirmReplacement === true,
    forceReplace: requestOptions?.forceReplace ?? null,
    reuseWhileRefreshPending: requestOptions?.reuseWhileRefreshPending === true,
    allowFoldedProbe:
      requestOptions?.refreshRuntime !== true && requestOptions?.confirmReplacement !== true,
    nodeScriptPath: runner?.nodeScriptPath ?? null,
    nodeEngineRange: runner?.nodeEngineRange ?? null,
    archiveVersion: runner?.archiveVersion ?? null,
    archiveCommitTime: runner?.archiveCommitTime ?? null,
    archiveSource: runner?.archiveSource ?? null,
    releaseBaseUrl: runner?.releaseBaseUrl ?? null,
    archiveDirectory: runner?.archiveDirectory ?? null,
    bundledArchiveDirectory: runner?.bundledArchiveDirectory ?? null,
    hostDownload: runner?.hostDownload === true,
    publishedFallback: runner?.publishedFallback === true,
    ghCommand: runner?.ghCommand ?? null,
    cleanupTimeoutMs: runner?.cleanupTimeoutMs ?? null,
    keepExistingRunner: runner?.keepExistingRunner === true,
    refreshOwnedRuntimeOnFirstConnection: runner?.refreshOwnedRuntimeOnFirstConnection === true,
    runnerConfirmReplacement: runner?.confirmReplacement === true,
    replacementGraceSeconds: runner?.replacementGraceSeconds ?? null,
  });
