import type {
  DesktopSshEnvironmentTarget,
  SshHostFailure,
  SshHostStatus,
  SshRuntimePendingReplacement,
  SshRuntimePhase,
} from "@goat/contracts";
import { ORCHESTRATION_PROTOCOL_VERSION } from "@goat/contracts";
import { extractJsonObject } from "@goat/shared/schemaJson";
import {
  compareRuntimeProtocols,
  ownRuntimeProtocolRanges,
  SSH_RUNTIME_PROTOCOL_VERSION,
} from "@goat/shared/sshRuntimeProtocol";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

// A cold archive launch also downloads and unpacks a ~70 MB release archive
// and may wait on another installer's lock. The budgets nest: the checksum
// file is tiny and the archive download is bounded; a waiter outlasts both
// downloads plus extraction so it can reuse the result; and the SSH command
// outlasts an install (own or waited-for) plus readiness, with slack for
// verification and extraction, which have no timeout of their own.
export const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
export const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
export const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
export const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;

export interface RemoteGoatRunnerOptions {
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  readonly archiveVersion?: string | null;
  /**
   * Commit time (Unix seconds) of the build `archiveVersion` names. It orders that build against
   * the host's when their versions cannot be ordered, such as two `0.1.0-dev.<sha>` builds.
   */
  readonly archiveCommitTime?: number;
  /** Acquisition authority recorded only when an archive is installed. */
  readonly archiveSource?: "bundle" | "cache" | "mirror" | "https" | "gh";
  readonly releaseBaseUrl?: string | null;
  /** Writable user cache; only this directory may receive gh downloads. */
  readonly archiveDirectory?: string | null;
  /** Read-only packaged archives. Never create, repair, or download into this directory. */
  readonly bundledArchiveDirectory?: string | null;
  /**
   * Ask the host to download a published release itself before this client uploads one.
   * The desktop app and the server's SSH dispatch set it; without it the client always
   * acquires the archive and uploads it.
   */
  readonly hostDownload?: boolean;
  /**
   * When this build's own runtime cannot be acquired for a host that runs nothing usable,
   * install the newest published runtime that is compatible with it instead. The desktop app
   * and the server's SSH dispatch set it.
   */
  readonly publishedFallback?: boolean;
  /** Local gh executable used for authenticated acquisition; defaults to PATH lookup. */
  readonly ghCommand?: string | undefined;
  /** Deadline for the best-effort post-install cleanup and fact warming round trip; 10 s by default. */
  readonly cleanupTimeoutMs?: number | undefined;
  /**
   * Reuse the remote's existing `run-t3.sh` instead of replacing it. Pairing and
   * MCP-session helpers set it so remote CLI commands run with the binary that
   * matches the running server. A launch with it never installs, refreshes, or
   * replaces the host's runtime.
   */
  readonly keepExistingRunner?: boolean | null;
  /**
   * The first connection per manager may refresh an older owned runtime once,
   * when idle. Packaged desktop and the server's SSH dispatch set it.
   */
  readonly refreshOwnedRuntimeOnFirstConnection?: boolean;
  /**
   * The user confirmed replacing the live runtime even if its work outlasts the drain window.
   * Without it an expired window cancels the replacement and the server keeps running.
   */
  readonly confirmReplacement?: boolean;
  /** Drain window for a replacement, in seconds (default 60, at most 300). */
  readonly replacementGraceSeconds?: number;
  /**
   * A person asked for this refresh. Only refreshes without it, and without
   * `confirmReplacement`, are automatic and let the runtime arbitrate the target.
   */
  readonly manualRefresh?: boolean;
  /**
   * The protocol the candidate build speaks, when it is not this build's own: a runtime that
   * replaces itself with a newer release builds the launch script on that release's behalf.
   */
  readonly candidateProtocol?: { readonly ssh: number; readonly orchestration: number };
}

export interface PreparedRemoteRuntime {
  readonly runner: RemoteGoatRunnerOptions;
  readonly version: string | null;
  readonly requestedVersion: string | null;
  readonly source: "requested" | "retained" | "live" | "installed";
  readonly installedExecutableSha256?: string;
  readonly requireInstalled: boolean;
  /** This preparation uploaded the archive, so an older runtime may have just become garbage. */
  readonly uploaded?: boolean;
  readonly mayUpgradeOwnedServer: boolean;
  /** SHA-256 of the retained run-t3.sh observed by preparation; null for other sources. */
  readonly retainedRunnerSha256: string | null;
  readonly refreshIfIdle?: boolean;
  readonly expectedLiveVersion?: string;
  readonly expectedLiveRunnerSha256?: string;
  readonly upgradeFailure?: SshHostFailure;
  /** Why a compatible live selection can be attached to, but cannot be updated. */
  readonly updateBlocked?: string;
  readonly reconnectProbe?: string;
  readonly reconnectPending?: SshRuntimePendingReplacement;
  readonly hostPlatform?: "darwin" | "linux" | "win32";
  /**
   * Set for a published fallback chosen because the host had no GOAT data. Launch refuses to
   * start it if data appeared meanwhile, since that data may come from a newer build.
   */
  readonly requireFreshHost?: boolean;
}

export const requestedRuntime = (
  runner: RemoteGoatRunnerOptions | undefined,
): PreparedRemoteRuntime => ({
  runner: { ...runner },
  version: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  requestedVersion: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  source: "requested",
  requireInstalled: false,
  retainedRunnerSha256: null,
  mayUpgradeOwnedServer: runner?.keepExistingRunner !== true,
});

export const RuntimeSignals = Schema.Struct({
  serverVersion: Schema.String,
  sshRuntimeProtocolVersion: Schema.optionalKey(Schema.Int),
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  invalid: Schema.optionalKey(Schema.Boolean),
});

const CLIENT_PROTOCOL_RANGES = ownRuntimeProtocolRanges(ORCHESTRATION_PROTOCOL_VERSION);

/**
 * Protocol ranges decide compatibility. Only a server too old to advertise both integers
 * (`unknown`) falls back to the exact release, since an identical build speaks identical protocols.
 */
export const matchesSignals = (signals: typeof RuntimeSignals.Type, requested: string) => {
  if (signals.invalid) return false;
  const verdict = compareRuntimeProtocols(CLIENT_PROTOCOL_RANGES, signals);
  return (
    verdict === "compatible" ||
    (verdict === "unknown" &&
      signals.serverVersion === requested &&
      (signals.sshRuntimeProtocolVersion === undefined ||
        signals.sshRuntimeProtocolVersion === SSH_RUNTIME_PROTOCOL_VERSION) &&
      (signals.orchestrationProtocolVersion === undefined ||
        signals.orchestrationProtocolVersion === ORCHESTRATION_PROTOCOL_VERSION))
  );
};

export function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

export function isNodeScriptRunner(runner: RemoteGoatRunnerOptions | undefined): boolean {
  return Boolean(runner?.nodeScriptPath?.trim());
}

export interface SshRuntimeProgress {
  readonly target: DesktopSshEnvironmentTarget;
  readonly phase: SshRuntimePhase;
  readonly upload?: SshHostStatus["upload"];
}

export type SshRuntimeProgressCallback = (progress: SshRuntimeProgress) => void;

// Progress observers must never change the outcome of an SSH operation.
export function notifyRuntimePhase(
  target: DesktopSshEnvironmentTarget,
  phase: SshRuntimePhase,
  onPhase?: SshRuntimeProgressCallback,
  upload?: SshHostStatus["upload"],
) {
  try {
    onPhase?.({ target, phase, ...(upload === undefined ? {} : { upload }) });
  } catch {
    // The requesting view may already have gone away.
  }
}

export const decodeRemoteJsonOutput = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) {
          return yield* Effect.fail(error);
        }
        const exit = yield* Effect.exit(decode(jsonObject));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

export function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    // A replacer function keeps `$$` and other `$` patterns in the value literal.
    result = result.replaceAll(`@@${token}@@`, () => value);
  }
  return result;
}
