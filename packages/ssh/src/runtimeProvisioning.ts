import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import {
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  cliArchivePlatformKey,
  isPublishableCliReleaseVersion,
  type CliArchivePlatformKey,
} from "@goat/shared/cliRelease";
import { compareRuntimeBuilds, parseSemver, type RuntimeBuild } from "@goat/shared/semver";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as SshAuth from "./auth.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
import { downloadRuntimeArchiveWithHttps } from "./runtimeArchiveHttp.ts";
import { findPublishedRuntime, type PublishedRuntimeMiss } from "./runtimePublished.ts";
import {
  decodeRemoteJsonOutput,
  isNodeScriptRunner,
  matchesSignals,
  liveRuntimeBlocksUpdate,
  notifyRuntimePhase,
  REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
  requestedRuntime,
  shellSingleQuote,
  sshTargetLogFields,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
  type SshRuntimeProgressCallback,
} from "./remoteRuntime.ts";
import { REMOTE_RUNTIME_STATE_KEY, runSshCommand } from "./command.ts";
import { SshLaunchError } from "./errors.ts";
import { buildRemoteRuntimeProbeScript, decodeRemoteRuntimeProbe } from "./runtimeProbe.ts";
import {
  archiveFailure,
  archiveSupplyError,
  archiveUnavailableText,
  missAction,
  runtimePreparationError,
} from "./runtimePreparationErrors.ts";
import {
  buildPublishedRuntimeGateScript,
  REMOTE_HOST_FETCH_FUNCTION,
  remoteUploadCommand,
  replaceRunnerAcquisitionBlock,
} from "./runtimeInstallScripts.ts";

/**
 * `compareRuntimeBuilds` for runtimes found on a host. Between a plain release and a prerelease
 * the commit time decides, and a plain build without one predates stamping, so it is older.
 * GOAT has only published prereleases, so a plain `0.1.1` on a host is a leftover from an older
 * install. It sorts above every `0.1.0-nightly.*` yet lacks their migrations, so starting it
 * against their database fails every launch.
 */
const compareHostRuntimeBuilds = (left: RuntimeBuild, right: RuntimeBuild): number | undefined => {
  const leftParsed = parseSemver(left.version);
  const rightParsed = parseSemver(right.version);
  const leftPlain = leftParsed?.prerelease.length === 0;
  if (
    leftParsed === null ||
    rightParsed === null ||
    leftPlain === (rightParsed.prerelease.length === 0)
  )
    return compareRuntimeBuilds(left, right);
  const [plain, prerelease] = leftPlain ? [left, right] : [right, left];
  if (prerelease.commitTime === undefined) return compareRuntimeBuilds(left, right);
  const plainNewer = plain.commitTime === undefined ? -1 : plain.commitTime - prerelease.commitTime;
  if (plainNewer === 0) return compareRuntimeBuilds(left, right);
  return leftPlain ? plainNewer : -plainNewer;
};

/**
 * Provisioning code that embeds the upstream-shaped runner script. tunnel.ts owns that builder and
 * passes it in, so this module never imports tunnel.ts.
 */
export function makeRuntimeProvisioning(
  buildRemoteGoatRunnerScript: (input?: RemoteGoatRunnerOptions) => string,
) {
  function buildRemoteGoatUploadInstallerScript(
    input: RemoteGoatRunnerOptions,
    sha256: string,
  ): string {
    if (
      isNodeScriptRunner(input) ||
      !input.archiveVersion?.trim() ||
      !/^[0-9a-f]{64}$/iu.test(sha256)
    ) {
      throw new SshLaunchError({
        message: "Upload requires an archive version and SHA256 digest.",
        stdout: "",
      });
    }
    return replaceRunnerAcquisitionBlock(
      buildRemoteGoatRunnerScript(input),
      () =>
        '  cp "$GOAT_SSH_UPLOADED_ARCHIVE" "$GOAT_STAGING/$GOAT_ARCHIVE"\n' +
        `  GOAT_EXPECTED='${sha256.toLowerCase()}'\n`,
    );
  }

  /**
   * Installs the requested published release on the host from its own network, verified
   * against the release's SHA256SUMS like every HTTPS acquisition, and exits after
   * `goat --version` without starting a server. Launch then finds the runtime ready.
   */
  function buildRemoteHostDownloadScript(input: RemoteGoatRunnerOptions): string {
    if (isNodeScriptRunner(input) || !input.archiveVersion?.trim()) {
      throw new SshLaunchError({
        message: "Host download requires an archive version.",
        stdout: "",
      });
    }
    return (
      "set -- --version\n" +
      replaceRunnerAcquisitionBlock(
        buildRemoteGoatRunnerScript(input),
        (block) =>
          REMOTE_HOST_FETCH_FUNCTION + block.replaceAll('  goat_fetch "', '  goat_host_fetch "'),
      )
    );
  }

  function buildRemoteUploadScript(input: RemoteGoatRunnerOptions, sha256: string): string {
    const { archiveSource, ...runner } = input;
    const installer = buildRemoteGoatUploadInstallerScript(runner, sha256);
    return `set -eu
umask 077
mkdir -p "$HOME/.goat/runtime/goat/versions"
upload_dir="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.upload-XXXXXX")"
trap 'rm -rf "$upload_dir"' EXIT
trap 'exit 1' HUP INT TERM
cat > "$upload_dir/archive.tar.gz"
export GOAT_SSH_UPLOADED_ARCHIVE="$upload_dir/archive.tar.gz"
export GOAT_SSH_ARCHIVE_SOURCE=${shellSingleQuote(archiveSource ?? "cache")}
sh -c ${shellSingleQuote(installer)} -- --version
`;
  }

  /**
   * Succeeds with false when the host could not install the release itself (no network,
   * a proxy, a pruned release, a checksum mismatch), so the caller uploads instead. Only a
   * definite exit falls back: after a dropped connection (255) or a timeout (no exit code)
   * the host installer may still hold the install lock, so an upload would race it.
   */
  const installOnHost = Effect.fn("ssh/tunnel.installOnHost")(function* (
    target: DesktopSshEnvironmentTarget,
    authOptions: SshAuth.SshAuthOptions,
    runner: RemoteGoatRunnerOptions,
    onPhase?: SshRuntimeProgressCallback,
  ) {
    const script = yield* Effect.try({
      try: () => buildRemoteHostDownloadScript(runner),
      catch: runtimePreparationError,
    });
    notifyRuntimePhase(target, "uploading", onPhase);
    // A login shell picks up the user's proxy settings for curl and wget.
    return yield* runSshCommand(target, {
      ...authOptions,
      remoteCommandArgs: ["sh", "-l", "-s"],
      stdin: script,
      timeoutStage: "runtime-install",
      timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
    }).pipe(
      Effect.as(true),
      Effect.catchTags({
        SshCommandError: (error) =>
          error.exitCode === null || error.exitCode === 255
            ? Effect.fail(error)
            : Effect.logWarning("ssh.runtime.host-download.failed", {
                ...sshTargetLogFields(target),
                version: runner.archiveVersion,
                exitCode: error.exitCode,
                reason: error.message,
              }).pipe(Effect.as(false)),
      }),
    );
  });

  // oxlint-disable-next-line goat/prefer-effect-fn -- moved unchanged from tunnel.ts (rule backlog); Effect.fn would move the "ssh.prepareRemoteRuntime" span inside the error mapping below.
  const prepareRemoteRuntime = (
    target: DesktopSshEnvironmentTarget,
    authOptions: SshAuth.SshAuthOptions,
    runner?: RemoteGoatRunnerOptions,
    stateKey?: string,
    owningLaunch = false,
    onPhase?: SshRuntimeProgressCallback,
    observedProbe?: string,
  ) =>
    Effect.gen(function* () {
      let exact = requestedRuntime(runner);
      if (isNodeScriptRunner(runner)) return exact;
      const directory = runner?.archiveDirectory?.trim() ?? "";
      const bundleDirectory = runner?.bundledArchiveDirectory?.trim() ?? "";
      const mirror = runner?.releaseBaseUrl?.trim() ?? "";
      // Observe a compatible installed runtime before any acquisition, including mirrors.
      const version = runner?.archiveVersion?.trim() ?? "";
      yield* Effect.annotateCurrentSpan({
        "ssh.target": target.alias,
        "goat.runtime.version": version,
      });
      yield* Effect.try({
        try: () => buildRemoteGoatRunnerScript(runner),
        catch: runtimePreparationError,
      });
      notifyRuntimePhase(target, "checking", onPhase);
      const result =
        observedProbe === undefined
          ? yield* runSshCommand(target, {
              ...authOptions,
              remoteCommandArgs: ["sh", "-l", "-s"],
              stdin: buildRemoteRuntimeProbeScript(
                version,
                stateKey,
                runner?.keepExistingRunner ?? false,
              ),
            }).pipe(Effect.mapError(runtimePreparationError))
          : { stdout: observedProbe };
      const probe = yield* decodeRemoteJsonOutput(result.stdout, decodeRemoteRuntimeProbe).pipe(
        Effect.mapError(runtimePreparationError),
      );
      exact = { ...exact, hostPlatform: probe.platform };
      // Every replace, refresh, and upgrade below needs a proven order; `undefined` means none,
      // and then the host keeps what it runs or has installed (see `compareRuntimeBuilds`).
      const requestedBuild = { version, commitTime: runner?.archiveCommitTime };
      const liveOrder =
        probe.liveVersion === undefined
          ? undefined
          : compareRuntimeBuilds(
              { version: probe.liveVersion, commitTime: probe.liveCommitTime },
              requestedBuild,
            );
      const retainedOrder =
        probe.retainedVersion === undefined
          ? undefined
          : compareHostRuntimeBuilds(
              { version: probe.retainedVersion, commitTime: probe.retainedCommitTime },
              requestedBuild,
            );
      const liveCompatible =
        probe.liveVersion !== undefined &&
        probe.liveSignals !== undefined &&
        probe.liveBinarySignals !== undefined &&
        probe.liveSignals.serverVersion === probe.liveVersion &&
        probe.liveBinarySignals.serverVersion === probe.liveVersion &&
        matchesSignals(probe.liveSignals, version) &&
        matchesSignals(probe.liveBinarySignals, version);
      if (
        owningLaunch &&
        probe.liveVersion !== undefined &&
        !liveCompatible &&
        liveOrder !== undefined &&
        liveOrder > 0
      ) {
        return yield* new SshLaunchError({
          reason: "runtime-newer",
          message: "Remote runtime is newer than this app; update the app.",
          stdout: "",
        });
      }
      if (
        owningLaunch &&
        exact.mayUpgradeOwnedServer &&
        probe.liveStatus === "live" &&
        probe.liveVersion !== undefined &&
        !liveCompatible &&
        liveOrder === undefined
      ) {
        return yield* new SshLaunchError({
          message: `Remote runtime GOAT ${probe.liveVersion} cannot be ordered against this app (GOAT ${version}); it was left running. Stop it on the remote host when its work is done, then reconnect.`,
          stdout: "",
        });
      }
      const retainedCompatible =
        probe.liveStatus === "none" &&
        probe.retained === "ready" &&
        probe.retainedVersion !== undefined &&
        probe.retainedSignals !== undefined &&
        probe.retainedRunnerSha256 !== undefined &&
        probe.retainedSignals.serverVersion === probe.retainedVersion &&
        matchesSignals(probe.retainedSignals, version) &&
        // A held fallback runs only through the published path, which rechecks the host's data.
        probe.retainedHeld === undefined;
      // No server runs, so no thread can be interrupted: an owning client installs
      // its own release instead of restarting an older retained one. A retained
      // build without a commit time predates stamping, so a stamped client counts it
      // older; only here, where nothing runs, so one manual stop moves such a host on.
      // It keeps the retained runtime when that one is newer or of unknown order, or
      // when the requested archive cannot be acquired (handled below, with the reason logged).
      const retainedPredatesStamps =
        retainedOrder === undefined &&
        probe.retainedCommitTime === undefined &&
        runner?.archiveCommitTime !== undefined;
      // A runtime of unknown order whose CLI cannot issue memory scopes is replaced as if older:
      // keeping it would fail every memory task on this host until someone stops it by hand.
      const retainedLacksCapability =
        retainedOrder === undefined && probe.retainedLacksMemoryScopes === true;
      const liveLacksCapability = liveOrder === undefined && probe.liveLacksMemoryScopes === true;
      const upgradeRetained =
        owningLaunch &&
        exact.mayUpgradeOwnedServer &&
        retainedCompatible &&
        probe.retainedVersion !== undefined &&
        ((retainedOrder !== undefined && retainedOrder < 0) ||
          retainedPredatesStamps ||
          retainedLacksCapability);
      const adoptLegacy =
        owningLaunch &&
        exact.mayUpgradeOwnedServer &&
        probe.liveDrain === true &&
        probe.identityAbsent === true &&
        !(liveCompatible && (liveOrder === undefined || liveOrder > 0)) &&
        (probe.liveStatus === "unknown" ||
          (probe.liveStatus === "live" && probe.liveOwned === true));
      const refreshIfIdle =
        owningLaunch &&
        exact.mayUpgradeOwnedServer &&
        runner?.refreshOwnedRuntimeOnFirstConnection === true &&
        liveCompatible &&
        probe.liveOwned === true &&
        probe.identityAbsent !== true &&
        ((liveOrder !== undefined && liveOrder < 0) || liveLacksCapability);
      const unorderedVersion =
        liveCompatible && liveOrder === undefined && !refreshIfIdle
          ? probe.liveVersion
          : probe.liveStatus === "none" &&
              retainedCompatible &&
              !upgradeRetained &&
              retainedOrder === undefined
            ? probe.retainedVersion
            : undefined;
      if (owningLaunch && exact.mayUpgradeOwnedServer && unorderedVersion !== undefined) {
        yield* Effect.logInfo("ssh.runtime.upgrade.skipped", {
          ...sshTargetLogFields(target),
          installedVersion: unorderedVersion,
          requestedVersion: version,
          reason: liveLacksCapability
            ? `GOAT ${unorderedVersion} cannot issue memory-scoped sessions, but this connection cannot replace it (it cannot drain, another client owns it, or this app already decided on it), so it is kept and memory tasks on this host fail until it is stopped.`
            : `GOAT ${unorderedVersion} and ${version} have no provable build order (a build without a commit time, or versions that only differ by sha or train), so the installed ${unorderedVersion} is kept.`,
        });
      }
      if (
        owningLaunch &&
        ((refreshIfIdle && liveLacksCapability) || (upgradeRetained && retainedLacksCapability))
      ) {
        yield* Effect.logInfo("ssh.runtime.upgrade.capability", {
          ...sshTargetLogFields(target),
          installedVersion: refreshIfIdle ? probe.liveVersion : probe.retainedVersion,
          requestedVersion: version,
          reason:
            "The installed runtime cannot issue memory-scoped sessions, so it is replaced when idle.",
        });
      }
      if (adoptLegacy || refreshIfIdle) {
        exact = {
          ...exact,
          ...(refreshIfIdle ? { refreshIfIdle: true, expectedLiveVersion: probe.liveVersion } : {}),
          ...(probe.retainedRunnerSha256 === undefined
            ? {}
            : { expectedLiveRunnerSha256: probe.retainedRunnerSha256 }),
        };
      }
      const selectedVersion =
        liveCompatible && !adoptLegacy && !refreshIfIdle
          ? probe.liveVersion
          : retainedCompatible && !upgradeRetained
            ? probe.retainedVersion
            : undefined;
      const selectInstalled = (selectedVersion: string, from = probe) => {
        const installed =
          from.liveStatus === "none"
            ? from.installedCandidates?.find((candidate) => candidate.version === selectedVersion)
            : undefined;
        const retained =
          selectedVersion === from.retainedVersion &&
          from.retainedSignals !== undefined &&
          from.retainedSignals.serverVersion === selectedVersion &&
          matchesSignals(from.retainedSignals, version) &&
          from.retainedRunnerSha256 !== undefined;
        return Effect.annotateCurrentSpan(
          "goat.runtime.source",
          retained ? "retained-runner" : installed ? "recorded-install" : "live-runtime",
        ).pipe(
          Effect.as({
            ...exact,
            version: selectedVersion,
            source: retained ? "retained" : installed ? "installed" : "live",
            ...(installed === undefined
              ? {}
              : { installedExecutableSha256: installed.executableSha256 }),
            requireInstalled: true,
            runner: { ...runner, archiveVersion: selectedVersion },
            retainedRunnerSha256: retained ? (from.retainedRunnerSha256 ?? null) : null,
            ...(from.liveStatus === "live" &&
            liveRuntimeBlocksUpdate(from, liveOrder, liveCompatible, selectedVersion === version)
              ? {
                  updateBlocked: `A GOAT server that this app didn't start or cannot replace is running on ${target.alias}. Stop it on the host, then reconnect.`,
                }
              : {}),
          } satisfies PreparedRemoteRuntime),
        );
      };
      // Install the requested release: already present, bundled, cached, or downloaded.
      const sourcesTried: string[] = [];
      const platformKey = cliArchivePlatformKey(probe.platform, probe.arch);
      const source = <A, E, R>(label: string, effect: Effect.Effect<A, E, R>) =>
        Effect.suspend(() => {
          sourcesTried.push(label);
          return effect;
        });
      // `fallback` installs another published version only: it never reports the requested one ready.
      // oxlint-disable-next-line goat/prefer-effect-fn -- moved unchanged from tunnel.ts (rule backlog); an inline step of prepareRemoteRuntime's span.
      const acquireVersion = (version: string, fallback = false) =>
        Effect.gen(function* () {
          if (!fallback && probe.ready) {
            yield* Effect.annotateCurrentSpan("goat.runtime.source", "ready");
            return { ...exact, requireInstalled: true };
          }
          if (platformKey === undefined) {
            if (mirror !== "") {
              sourcesTried.push("mirror");
              yield* Effect.annotateCurrentSpan("goat.runtime.source", "download");
              return exact;
            }
            const asset =
              platformKey === undefined
                ? `unsupported-${probe.platform}-${probe.arch}`
                : cliArchiveFileName(version, platformKey);
            return yield* new SshLaunchError({
              reason: "archive-unavailable",
              message: `Cannot acquire the SSH runtime archive (repo=${CLI_RELEASE_REPOSITORY}, tag=v${version}, asset=${asset}, archive directory=${directory || "<not configured>"}). Configure a local archive directory and use a supported SSH platform, or an explicit release mirror.`,
              stdout: "",
            });
          }
          // The host's own network is usually faster than this client's uplink, and an upload
          // costs this client the whole archive. Unpublished builds and mirrors skip it.
          if (
            runner?.hostDownload === true &&
            mirror === "" &&
            isPublishableCliReleaseVersion(version) &&
            (yield* source(
              "host",
              installOnHost(target, authOptions, { ...runner, archiveVersion: version }, onPhase),
            ))
          ) {
            yield* Effect.annotateCurrentSpan("goat.runtime.source", "host-download");
            return { ...exact, requireInstalled: true, uploaded: true };
          }
          const bundledArchive =
            bundleDirectory === ""
              ? null
              : yield* source(
                  "bundle",
                  readLocalRuntimeArchive(bundleDirectory, version, platformKey, true),
                ).pipe(
                  Effect.mapError((cause) =>
                    archiveSupplyError(cause, "Reinstall this app, then reconnect."),
                  ),
                );
          const localArchive =
            bundledArchive !== null || directory === ""
              ? null
              : yield* source(
                  "cache",
                  readLocalRuntimeArchive(directory, version, platformKey),
                ).pipe(
                  Effect.mapError((cause) =>
                    archiveSupplyError(
                      cause,
                      `Remove ${cliArchiveFileName(version, platformKey)} from ${directory}, then reconnect.`,
                    ),
                  ),
                );
          if (bundledArchive === null && localArchive === null && mirror !== "") {
            sourcesTried.push("mirror");
            yield* Effect.annotateCurrentSpan("goat.runtime.source", "download");
            return exact;
          }
          if (bundledArchive === null && localArchive === null) {
            const path = yield* Path.Path;
            if (
              directory === "" ||
              (bundleDirectory !== "" && path.resolve(directory) === path.resolve(bundleDirectory))
            ) {
              return yield* new SshLaunchError({
                reason: "archive-unavailable",
                message: `Cannot acquire ${cliArchiveFileName(version, platformKey)} for ${target.alias}: no writable user archive cache distinct from the bundle (${directory || "<not configured>"}). Configure archiveDirectory for ${CLI_RELEASE_REPOSITORY} release v${version} or rebuild the packaged archives.`,
                stdout: "",
                action: "Reinstall this app, then reconnect.",
              });
            }
          }
          const archive =
            bundledArchive ??
            localArchive ??
            (yield* source(
              "https",
              downloadRuntimeArchiveWithHttps(directory, version, platformKey),
            ).pipe(
              Effect.catchTags({
                RuntimeArchiveNotPublished: () =>
                  source(
                    "gh",
                    downloadRuntimeArchiveWithGh(
                      directory,
                      version,
                      platformKey,
                      runner?.ghCommand,
                    ),
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new SshLaunchError({
                          reason: "archive-unavailable",
                          message: `Public HTTPS release is not published and local gh acquisition failed: ${cause.message}`,
                          stdout: "",
                          // A published build whose archive is gone was pruned: a newer app has one.
                          action: isPublishableCliReleaseVersion(version)
                            ? missAction("client-too-old", "", directory)
                            : missAction(
                                "none",
                                cliArchiveFileName(version, platformKey),
                                directory,
                              ),
                          cause,
                        }),
                    ),
                  ),
                RuntimeArchiveNetworkError: () =>
                  source(
                    "gh",
                    downloadRuntimeArchiveWithGh(
                      directory,
                      version,
                      platformKey,
                      runner?.ghCommand,
                    ),
                  ).pipe(
                    Effect.mapError(
                      (cause) =>
                        new SshLaunchError({
                          reason: "archive-unavailable",
                          message: `Public HTTPS release download failed and local gh acquisition failed: ${cause.message}`,
                          stdout: "",
                          action: missAction("unreachable", "", directory),
                          cause,
                        }),
                    ),
                  ),
              }),
              Effect.mapError(archiveSupplyError),
            ));
          yield* Effect.annotateCurrentSpan(
            "goat.runtime.acquisition",
            bundledArchive !== null ? "bundle" : localArchive !== null ? "cache" : "https-or-gh",
          );
          yield* Effect.annotateCurrentSpan({
            "goat.runtime.source": "upload",
            "goat.runtime.upload.bytes": archive.bytes.byteLength,
            "goat.runtime.upload.sha256": archive.sha256,
            "goat.runtime.upload.installComplete": false,
          });
          const script = yield* Effect.try({
            try: () =>
              buildRemoteUploadScript(
                {
                  ...runner,
                  archiveVersion: version,
                  archiveSource:
                    bundledArchive !== null
                      ? "bundle"
                      : localArchive !== null
                        ? "cache"
                        : sourcesTried.at(-1) === "gh"
                          ? "gh"
                          : "https",
                },
                archive.sha256,
              ),
            catch: runtimePreparationError,
          });
          const { archiveOffset, archiveLength, ...uploadCommand } = remoteUploadCommand(
            script,
            archive.bytes,
            probe.platform,
          );
          notifyRuntimePhase(target, "uploading", onPhase, {
            sentBytes: 0,
            totalBytes: archiveLength,
          });
          yield* runSshCommand(target, {
            ...authOptions,
            ...uploadCommand,
            onStdinProgress: (sentBytes) => {
              if (sentBytes <= archiveOffset) return;
              notifyRuntimePhase(target, "uploading", onPhase, {
                sentBytes: Math.min(sentBytes - archiveOffset, archiveLength),
                totalBytes: archiveLength,
              });
            },
            timeoutStage: "runtime-install",
            timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
          }).pipe(
            // A remote reader that exits early (full disk, failed checksum) fails only
            // this upload, with the remote's own reason. A connection failure or timeout
            // stays an SshCommandError that names the host.
            Effect.catchTags({
              SshCommandError: (error) =>
                error.exitCode === null || error.exitCode === 255
                  ? Effect.fail(error)
                  : Effect.fail(
                      new SshLaunchError({
                        message: `Uploading the runtime archive failed (exit ${error.exitCode}): ${error.message}`,
                        stdout: error.stdout ?? "",
                        cause: error,
                      }),
                    ),
            }),
          );
          yield* Effect.annotateCurrentSpan("goat.runtime.upload.installComplete", true);
          return { ...exact, requireInstalled: true, uploaded: true };
        }).pipe(
          // Error.message is non-enumerable; adding acquisition context must preserve it explicitly.
          Effect.mapError((error) =>
            error instanceof SshLaunchError && error.reason === "archive-unavailable"
              ? new SshLaunchError({
                  message: error.message,
                  stdout: error.stdout,
                  reason: error.reason,
                  ...(error.cause === undefined ? {} : { cause: error.cause }),
                  ...(error.action === undefined ? {} : { action: error.action }),
                  acquisition: {
                    requestedVersion: version,
                    platformKey: platformKey ?? `${probe.platform}-${probe.arch}`,
                    sourcesTried: [...sourcesTried],
                  },
                })
              : error,
          ),
        );
      const acquireRequested = acquireVersion(version);
      if (selectedVersion !== undefined) return yield* selectInstalled(selectedVersion);
      // Legacy ownership must be adopted through its normal replacement path;
      // attaching without adoption would fail the launch-time identity check.
      const fallbackToLive = probe.liveStatus === "live" && liveCompatible && !adoptLegacy;
      let fallbackVersion = fallbackToLive
        ? probe.liveVersion
        : upgradeRetained
          ? probe.retainedVersion
          : undefined;
      // Disk discovery is recovery only: exact acquisition and a compatible live server win.
      if (owningLaunch && probe.liveStatus === "none") {
        let chosen = retainedCompatible
          ? { version: probe.retainedVersion, commitTime: probe.retainedCommitTime }
          : undefined;
        for (const candidate of probe.installedCandidates ?? []) {
          if (
            candidate.held !== undefined ||
            candidate.signals.serverVersion !== candidate.version ||
            !matchesSignals(candidate.signals, version) ||
            compareHostRuntimeBuilds(candidate, requestedBuild) === undefined
          )
            continue;
          if (probe.retainedVersion !== undefined) {
            const retainedOrder = compareHostRuntimeBuilds(candidate, {
              version: probe.retainedVersion,
              commitTime: probe.retainedCommitTime,
            });
            if (retainedOrder === undefined || retainedOrder <= 0) continue;
          }
          const order = chosen === undefined ? 1 : compareHostRuntimeBuilds(candidate, chosen);
          if (order !== undefined && order > 0)
            chosen = { version: candidate.version, commitTime: candidate.commitTime };
        }
        if (chosen !== undefined) fallbackVersion = chosen.version;
      }
      if (fallbackVersion !== undefined) {
        yield* Effect.logInfo("ssh.runtime.upgrade.start", {
          ...sshTargetLogFields(target),
          installedVersion: fallbackVersion,
          requestedVersion: version,
        });
        return yield* acquireRequested.pipe(
          Effect.catchTags({
            SshLaunchError: (error) => {
              // An unavailable archive may cancel an optional upgrade. Upload and
              // SSH failures retain their own error instead of being hidden by reuse.
              if (error.reason !== "archive-unavailable") return Effect.fail(error);
              return Effect.logWarning("ssh.runtime.upgrade.skipped", {
                ...sshTargetLogFields(target),
                installedVersion: fallbackVersion,
                requestedVersion: version,
                reason: `GOAT ${version} could not be installed; using compatible GOAT ${fallbackVersion} (${fallbackToLive ? "live server" : fallbackVersion === probe.retainedVersion ? "retained runtime; no verified newer ordered candidate" : `newest verified installed runtime with proven build order${probe.installedCandidates?.find((candidate) => candidate.version === fallbackVersion)?.unrecorded ? " (unrecorded install)" : ""}`}): ${error.message}`,
              }).pipe(
                Effect.andThen(selectInstalled(fallbackVersion)),
                Effect.map((selected): PreparedRemoteRuntime => {
                  const failure = archiveFailure(error);
                  const fallback = {
                    ...selected,
                    // Revalidate compatibility at launch, but never refresh or adopt
                    // an installed runtime after failing to acquire its replacement.
                    mayUpgradeOwnedServer: false,
                    refreshIfIdle: false,
                    ...(failure === undefined
                      ? {}
                      : {
                          upgradeFailure: {
                            ...failure,
                            fix: {
                              ...failure.fix,
                              instruction: `Using compatible GOAT ${fallbackVersion}. ${failure.fix.instruction}`,
                            },
                          },
                        }),
                  };
                  delete fallback.expectedLiveVersion;
                  delete fallback.expectedLiveRunnerSha256;
                  return fallback;
                }),
              );
            },
          }),
        );
      }
      // A host that has never run GOAT: nothing installed, nothing running, no data. Only such a
      // host may get a published runtime other than the requested one, because GOAT has no way
      // to prove that an older build can read data a newer one wrote (unknown migrations only
      // warn). Liveness the probe could not establish is never read as stopped. Held runtimes are
      // earlier published fallbacks that never passed verification and launch.
      const coldHost =
        probe.liveStatus !== "live" &&
        probe.liveStatus !== "unknown" &&
        (probe.retainedVersion === undefined || probe.retainedHeld !== undefined) &&
        (probe.installedCandidates ?? []).every((candidate) => candidate.held !== undefined);
      if (
        runner?.publishedFallback !== true ||
        !owningLaunch ||
        !exact.mayUpgradeOwnedServer ||
        !coldHost ||
        mirror !== "" ||
        platformKey === undefined
      )
        return yield* acquireRequested;
      return yield* acquireRequested.pipe(
        Effect.catchTags({
          SshLaunchError: (error) =>
            error.reason === "archive-unavailable"
              ? installPublishedRuntime(platformKey, error)
              : Effect.fail(error),
        }),
      );

      function installPublishedRuntime(key: CliArchivePlatformKey, requestedError: SshLaunchError) {
        const asset = cliArchiveFileName(version, key);
        const giveUp = (miss: PublishedRuntimeMiss, detail: string) =>
          Effect.logWarning("ssh.runtime.published.unavailable", {
            ...sshTargetLogFields(target),
            requestedVersion: version,
            miss,
            detail,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new SshLaunchError({
                  message: requestedError.message,
                  stdout: requestedError.stdout,
                  reason: "archive-unavailable",
                  ...(requestedError.acquisition === undefined
                    ? {}
                    : { acquisition: requestedError.acquisition }),
                  action: missAction(miss, asset, directory),
                  cause: requestedError,
                }),
              ),
            ),
          );
        return Effect.gen(function* () {
          const gate = (mode: "fresh" | "capable" | "hold" | "reject", candidate = "") =>
            runSshCommand(target, {
              ...authOptions,
              remoteCommandArgs: ["sh", "-s", "--", mode, candidate],
              stdin: buildPublishedRuntimeGateScript(stateKey ?? REMOTE_RUNTIME_STATE_KEY),
            }).pipe(
              Effect.map((result) => result.stdout.trim()),
              Effect.catchTags({
                SshCommandError: (error) =>
                  error.exitCode === null || error.exitCode === 255
                    ? Effect.fail(error)
                    : Effect.succeed("no"),
              }),
            );
          const raced = new SshLaunchError({
            message: `Another GOAT client set up ${target.alias} at the same time. Reconnect to use it.`,
            stdout: "",
          });
          if ((yield* gate("fresh")) !== "yes")
            return yield* giveUp(
              "none",
              "The host has GOAT data but no runtime this app can start.",
            );
          const search = yield* findPublishedRuntime({
            platformKey: key,
            requestedVersion: version,
            exclude: new Set(
              [
                ...(probe.installedCandidates ?? []).map((candidate) => ({
                  version: candidate.version,
                  held: candidate.held,
                })),
                { version: probe.retainedVersion, held: probe.retainedHeld },
              ].flatMap((runtime) =>
                runtime.held === "rejected" && runtime.version !== undefined
                  ? [runtime.version]
                  : [],
              ),
            ),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed({ miss: "unreachable" as const, rejected: [Cause.pretty(cause)] }),
            ),
          );
          if ("miss" in search) return yield* giveUp(search.miss, search.rejected.join("; "));
          const published = search.found;
          yield* Effect.logInfo("ssh.runtime.published.install", {
            ...sshTargetLogFields(target),
            requestedVersion: version,
            publishedVersion: published.version,
            channel: published.channel,
            manifest: published.manifest !== undefined,
            rejected: search.rejected.join("; "),
          });
          yield* Effect.annotateCurrentSpan("goat.runtime.published", published.version);
          // Held from before installation until launch confirms the host still has no data, so
          // installed-runtime recovery never starts it unverified, here or from another client.
          // "no": data appeared since the check above; "busy": another client holds the lock.
          if ((yield* gate("hold", published.version)) !== "yes") return yield* raced;
          yield* acquireVersion(published.version, true).pipe(
            Effect.catchTags({
              SshLaunchError: (error) =>
                error.reason === "archive-unavailable"
                  ? giveUp("unreachable", error.message)
                  : Effect.fail(error),
            }),
          );
          // The installed binary, not the release, has the last word: its own protocol answer,
          // a proven build order, and positive evidence of every required capability.
          const after = yield* runSshCommand(target, {
            ...authOptions,
            remoteCommandArgs: ["sh", "-l", "-s"],
            stdin: buildRemoteRuntimeProbeScript(
              version,
              stateKey,
              runner?.keepExistingRunner ?? false,
            ),
          }).pipe(
            Effect.mapError(runtimePreparationError),
            Effect.flatMap((result) =>
              decodeRemoteJsonOutput(result.stdout, decodeRemoteRuntimeProbe),
            ),
            Effect.mapError(runtimePreparationError),
          );
          // A launch that failed after publishing the runner left this version retained.
          const listed = [
            ...(after.installedCandidates ?? []),
            ...(after.retainedVersion === undefined || after.retainedSignals === undefined
              ? []
              : [
                  {
                    version: after.retainedVersion,
                    signals: after.retainedSignals,
                    commitTime: after.retainedCommitTime,
                    held: after.retainedHeld,
                  },
                ]),
          ].find((candidate) => candidate.version === published.version);
          // Another client set the host up meanwhile, or the probe could not see the install. Neither
          // says anything against this runtime, so it is neither rejected nor started here.
          if (listed === undefined || after.liveStatus === "live" || after.liveStatus === "unknown")
            return yield* raced;
          const order = compareRuntimeBuilds(listed, requestedBuild);
          if (
            listed.held === "rejected" ||
            listed.signals.serverVersion !== listed.version ||
            !matchesSignals(listed.signals, version) ||
            order === undefined ||
            (yield* gate("capable", published.version)) !== "yes"
          ) {
            // Stays installed but held for good: recovery skips it and the search never offers it.
            // The gate refuses once the host has data, so a runtime another client already
            // started is never rejected.
            yield* gate("reject", published.version);
            return yield* giveUp(
              "none",
              `GOAT ${published.version} was installed but cannot serve this app (protocol, build order or capability).`,
            );
          }
          const selected = yield* selectInstalled(published.version, after);
          // Older than this app: say so and keep retrying the requested build. Newer: nothing to wait for.
          const failure = order < 0 ? archiveFailure(requestedError) : undefined;
          const pinned = {
            ...selected,
            mayUpgradeOwnedServer: false,
            refreshIfIdle: false,
            requireFreshHost: true,
            ...(failure === undefined
              ? {}
              : {
                  upgradeFailure: {
                    ...failure,
                    fix: {
                      ...failure.fix,
                      instruction: `Using published GOAT ${published.version}. ${failure.fix.instruction}`,
                    },
                  },
                }),
          };
          delete pinned.expectedLiveVersion;
          delete pinned.expectedLiveRunnerSha256;
          return pinned satisfies PreparedRemoteRuntime;
        });
      }
    }).pipe(
      Effect.tapError((error) =>
        error instanceof SshLaunchError && error.reason === "archive-unavailable"
          ? Effect.logWarning("ssh.runtime.acquisition.failed", {
              ...sshTargetLogFields(target),
              requestedVersion: runner?.archiveVersion?.trim() ?? "",
              sourcesTried: error.acquisition?.sourcesTried.join(",") ?? "",
              detail: error.message,
            })
          : Effect.void,
      ),
      Effect.mapError((error) =>
        error instanceof SshLaunchError
          ? error.reason === "archive-unavailable" && error.acquisition !== undefined
            ? new SshLaunchError({
                ...archiveUnavailableText(
                  target.alias,
                  error,
                  error.acquisition,
                  runner?.archiveDirectory?.trim() ?? "",
                ),
                stdout: error.stdout,
                reason: error.reason,
                acquisition: error.acquisition,
                cause: error,
              })
            : new SshLaunchError({
                message: `Cannot prepare GOAT ${runner?.archiveVersion?.trim() || "(node-script runner)"} on ${target.alias}: ${error.message} The existing runner and server have been left unchanged.`,
                stdout: error.stdout,
                ...(error.reason === undefined ? {} : { reason: error.reason }),
                ...(error.acquisition === undefined ? {} : { acquisition: error.acquisition }),
                cause: error,
              })
          : error,
      ),
      Effect.withSpan("ssh.prepareRemoteRuntime"),
    );

  return {
    buildRemoteGoatUploadInstallerScript,
    buildRemoteHostDownloadScript,
    buildRemoteUploadScript,
    prepareRemoteRuntime,
  };
}
