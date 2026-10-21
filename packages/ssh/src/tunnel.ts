import {
  isSshHostUnreachable,
  sshAuthenticationFailure,
  sshFailureDiagnostic,
  sshLocalProxyFailure,
} from "@goat/shared/sshFailure";
import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";
import type {
  AuthEnvironmentScope,
  DesktopSshEnvironmentReadyOrPending,
  DesktopSshPreparationProgress,
  DesktopSshRuntimePendingResult,
  SshRuntimePendingReplacement,
  DesktopSshEnvironmentTarget,
  SshHostFailure,
  SshHostResult,
  SshHostStatus,
  SshHostProviders,
  SshHostSetupProgress,
  SshRuntimePhase,
} from "@goat/contracts";
import {
  AuthEnvironmentScopes,
  SshRuntimePendingReplacementSchema,
  ORCHESTRATION_PROTOCOL_VERSION,
  RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS,
  RUNTIME_DRAIN_MAX_GRACE_SECONDS,
  SERVER_EXIT_CODE_DATABASE_AHEAD,
  buildSshKeyAuthInstructions,
} from "@goat/contracts";
import {
  compareRuntimeProtocols,
  ownRuntimeProtocolRanges,
  SSH_RUNTIME_PROTOCOL_VERSION,
} from "@goat/shared/sshRuntimeProtocol";
import {
  describeReadinessCause,
  waitForHttpReady as waitForHttpReadyShared,
} from "@goat/shared/httpReadiness";
import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  cliArchivePlatformKey,
  cliReleaseDownloadBaseUrl,
  isPublishableCliReleaseVersion,
  type CliArchivePlatformKey,
} from "@goat/shared/cliRelease";
import * as KeyedLock from "@goat/shared/KeyedLock";
import * as NetService from "@goat/shared/Net";
import * as HostProcess from "@goat/shared/HostProcess";
import { extractJsonObject, fromLenientJson } from "@goat/shared/schemaJson";
import { compareRuntimeBuilds, parseSemver, type RuntimeBuild } from "@goat/shared/semver";
import {
  encodePowerShellCommand,
  WINDOWS_DETACHED_SPAWN_POWERSHELL,
  WINDOWS_PROCESS_INFO_POWERSHELL,
} from "@goat/shared/windowsHostProcess";
import * as Config from "effect/Config";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import * as SshAuth from "./auth.ts";
import {
  makeEnsureFlights,
  supersededPreparation,
  type PreparationAdmission,
} from "./ensureFlight.ts";
import { REMOTE_NODE_ENGINE_CHECK_SCRIPT } from "./remoteNodeEngineCheck.ts";
import { ensureSshMaster } from "./master.ts";
import { makeOwnedSshTunnelCommand, ownedAuthDirectory } from "./tunnelOwner.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
import { downloadRuntimeArchiveWithHttps } from "./runtimeArchiveHttp.ts";
import { findPublishedRuntime, type PublishedRuntimeMiss } from "./runtimePublished.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  getLastNonEmptyOutputLine,
  REMOTE_RUNTIME_STATE_KEY,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  SshReconnectCost,
  SshHostAnswered,
  SshConnectionSharing,
  healthySshMaster,
  type SshMasterConnection,
  measureSshReconnectStep,
  SSH_KEEPALIVE_ARGS,
  sshDiagnosticChunks,
  SSH_DIAGNOSTIC_ARGS,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshEnsureSupersededError,
  SshPreparationTimeoutError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const REMOTE_LAUNCH_ATTEMPTS = 3;
const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
// Ceilings for a slow link. A forwarded probe costs at least one round trip,
// which reaches ~600 ms over a phone hotspot relayed across continents.
const SSH_READY_MAX_PROBE_TIMEOUT_MS = 5_000;
const SSH_READY_MAX_TIMEOUT_MS = 60_000;
// How long an open forward has to answer before it counts as dead. A forward
// whose TCP connection died during sleep accepts locally and never answers.
const EXISTING_TUNNEL_CHECK_TIMEOUT_MS = 2_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const TUNNEL_STDERR_TAIL_CHARS = 16_384;
const REMOTE_READY_TIMEOUT_MS = 60_000;
const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;
// A cold archive launch also downloads and unpacks a ~70 MB release archive
// and may wait on another installer's lock. The budgets nest: the checksum
// file is tiny and the archive download is bounded; a waiter outlasts both
// downloads plus extraction so it can reuse the result; and the SSH command
// outlasts an install (own or waited-for) plus readiness, with slack for
// verification and extraction, which have no timeout of their own.
const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;
// Reserved by the folded launch protocol for re-entering preparation, never a launch failure.
const REMOTE_RECONNECT_REPROBE_EXIT_CODE = 76;
const REMOTE_REPLACEMENT_WAIT_ATTEMPTS = 50;

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
const requestedRuntime = (runner: RemoteGoatRunnerOptions | undefined): PreparedRemoteRuntime => ({
  runner: { ...runner },
  version: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  requestedVersion: isNodeScriptRunner(runner) ? null : runner?.archiveVersion?.trim() || null,
  source: "requested",
  requireInstalled: false,
  retainedRunnerSha256: null,
  mayUpgradeOwnedServer: runner?.keepExistingRunner !== true,
});
const RuntimeSignals = Schema.Struct({
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
const matchesSignals = (signals: typeof RuntimeSignals.Type, requested: string) => {
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

// Starting goat costs about 0.4 s on a host, and one reconnect used to start it dozens of times
// for answers that cannot change while their inputs stand: those of an unchanged executable, and
// those of one running server instance. Each answer is recorded under a key naming every input it
// depends on, so an executable that changed, was reinstalled or removed, or a server that was
// replaced or restarted misses and is asked again. Failures are never recorded, and a record is
// kept only when its key still holds after the answer. Windows hosts ask every time.
const REMOTE_FACTS_SCRIPT = `case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) GOAT_FACTS_DIR= ;;
  *) GOAT_FACTS_DIR="$HOME/.goat/ssh-launch/facts" ;;
esac
FACT_NAME=; FACT_KEY=
fact_nl='
'
file_sig() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  # BSD stat first: GNU stat reads -f as a file-system query and rejects the format operand.
  sig_value="$(stat -f '%d:%i:%z:%m:%c' "$1" 2>/dev/null)" ||
    sig_value="$(stat -c '%d:%i:%s:%Y:%Z' "$1" 2>/dev/null)" || return 1
  printf '%s\\n' "$sig_value" | LC_ALL=C grep -Eq '^[0-9]+(:[0-9]+){4}$' || return 1
  printf '%s' "$sig_value"
}
# Sets FACT_NAME and FACT_KEY for running goat as $1: an installed executable, or an archive
# runner, which execs one. An executable changed less than 2 s ago is not keyed: a second write
# within the same second would leave its ctime unchanged.
exec_fact_key() {
  FACT_NAME=; FACT_KEY=
  [ -n "$GOAT_FACTS_DIR" ] && [ -f "$1" ] || return 1
  fact_versions="$HOME/.goat/runtime/goat/versions"
  case "$1" in
    "$fact_versions"/*/goat) fact_exe="$1"; fact_via=exe ;;
    *)
      command -v read_runner_hint >/dev/null 2>&1 || return 1
      [ -z "$(read_runner_hint "$1" GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY} 2>/dev/null)" ] || return 1
      fact_exe="$fact_versions/$(read_runner_hint "$1" GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY} 2>/dev/null)/goat"
      fact_via="$(runner_sha256 "$1" 2>/dev/null)" || return 1 ;;
  esac
  fact_version="\${fact_exe%/goat}"; fact_version="\${fact_version##*/}"
  valid_version "$fact_version" && [ "$fact_exe" = "$fact_versions/$fact_version/goat" ] || return 1
  fact_sig="$(file_sig "$fact_exe")" || return 1
  [ "$(( $(date +%s) - \${fact_sig##*:} ))" -ge 2 ] || return 1
  # A runner installs a version without its marker instead of running it.
  [ "$(cat "$fact_versions/$fact_version/.install-complete" 2>/dev/null)" = "$fact_version" ] || return 1
  case "$fact_via" in exe) FACT_NAME="$fact_version.exe" ;; *) FACT_NAME="$fact_version.runner" ;; esac
  FACT_KEY="$fact_exe $fact_sig $fact_via"
}
prune_removed_facts() (
  [ -n "$GOAT_FACTS_DIR" ] || exit 0
  # A missing version is enough to discard answers; incomplete installs and links are not.
  for fact_parent in "$HOME" "$HOME/.goat" "$HOME/.goat/ssh-launch" "$GOAT_FACTS_DIR" \
    "$HOME/.goat/runtime" "$HOME/.goat/runtime/goat" "$HOME/.goat/runtime/goat/versions"; do
    [ ! -L "$fact_parent" ] && [ -d "$fact_parent" ] && [ -r "$fact_parent" ] && [ -x "$fact_parent" ] || exit 0
  done
  set +f
  for fact_file in "$GOAT_FACTS_DIR"/*; do
    [ ! -L "$fact_file" ] && [ -f "$fact_file" ] || continue
    fact_base="\${fact_file##*/}"
    case "$fact_base" in version.*|own.*|commit.*|scopes.*|live.*|compat.*) ;; *) continue ;; esac
    case "$fact_base" in *.exe|*.runner) ;; *) continue ;; esac
    fact_version="\${fact_base#*.}"; fact_version="\${fact_version%.*}"
    valid_version "$fact_version" || continue
    fact_dir="$HOME/.goat/runtime/goat/versions/$fact_version"
    [ ! -L "$fact_dir" ] && [ ! -e "$fact_dir" ] || continue
    rm -f "$fact_file" || true
  done
) 2>/dev/null || true
# A recorded value must parse as an answer of its kind (the name's first word); anything else,
# such as a damaged file, is a miss and is asked again.
fact_valid() {
  case "$1" in
    version) case "$2" in "goat v"*) valid_version "\${2#goat v}" ;; *) return 1 ;; esac ;;
    own) (set -f; set -- $2; valid_own_tokens "$@") ;;
    commit) valid_positive "$2" ;;
    scopes) case "$2" in has|lacks|unknown) ;; *) return 1 ;; esac ;;
    live) (set -f; set -- $2; valid_live_tokens "$@" && [ "$1" = live ] && valid_positive "$5") ;;
    compat)
      (set -f; set -- $2
        [ "$#" = 3 ] || exit 1
        case "$1" in compatible|update-required|client-too-old) ;; *) exit 1 ;; esac
        [ "$2" = 1 ] || exit 1
        case "$3" in ''|-|*[!A-Za-z0-9-]*) exit 1 ;; *) ;; esac) ;;
    *) return 1 ;;
  esac
}
fact_get() {
  [ -n "$1" ] && [ -n "$2" ] && [ -f "$GOAT_FACTS_DIR/$1" ] && [ ! -L "$GOAT_FACTS_DIR/$1" ] || return 1
  { IFS= read -r fact_recorded && IFS= read -r fact_value; } <"$GOAT_FACTS_DIR/$1" || return 1
  [ "$fact_recorded" = "$2" ] && fact_valid "\${1%%.*}" "$fact_value" || return 1
  printf '%s\\n' "$fact_value"
}
fact_put() {
  [ -n "$1" ] && [ -n "$2" ] || return 0
  case "$2$3" in *"$fact_nl"*) return 0 ;; esac
  (
    umask 077
    [ ! -L "$GOAT_FACTS_DIR" ] && mkdir -p "$GOAT_FACTS_DIR" &&
      fact_tmp="$(mktemp "$GOAT_FACTS_DIR/.fact.XXXXXX")" || exit 0
    printf '%s\\n%s\\n' "$2" "$3" >"$fact_tmp" && mv -f "$fact_tmp" "$GOAT_FACTS_DIR/$1" || rm -f "$fact_tmp"
  ) 2>/dev/null || true
}
# Prints the output of goat run as "$2" "$3"..., recorded as fact $1 of that executable.
exec_fact() {
  fact_kind="$1"; shift
  exec_fact_key "$1" || true
  fact_name="$fact_kind.$FACT_NAME"; fact_key="$FACT_KEY"
  if fact_get "$fact_name" "$fact_key"; then return 0; fi
  fact_out="$("$@")" || return 1
  if [ -n "$fact_key" ] && exec_fact_key "$1" && [ "$FACT_KEY" = "$fact_key" ]; then
    fact_put "$fact_name" "$fact_key" "$fact_out"
  fi
  printf '%s\\n' "$fact_out"
}
# A live answer from goat $1 depends on its executable, the runtime record $2, the launch port
# and PID files $3 and $4, and whether the PIDs they name still run the same processes.
live_fact_key() {
  exec_fact_key "$1" || return 1
  fact_live="$FACT_KEY"; FACT_KEY=
  [ -f "$2" ] && fact_record="$(tr '\\n' ' ' <"$2")" && [ -n "$fact_record" ] || return 1
  fact_pid="$(printf '%s\\n' "$fact_record" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')"
  valid_positive "$fact_pid" || return 1
  fact_record_port="$(printf '%s\\n' "$fact_record" | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')"
  valid_positive "$fact_record_port" || return 1
  fact_start="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$fact_pid" 2>/dev/null)" && [ -n "$fact_start" ] || return 1
  fact_port="$(cat "$3" 2>/dev/null || true)"; fact_remembered="$(cat "$4" 2>/dev/null || true)"
  fact_remembered_start=
  if valid_positive "$fact_remembered"; then
    fact_remembered_start="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$fact_remembered" 2>/dev/null || true)"
  fi
  FACT_KEY="$fact_live|$fact_record|$fact_start|$fact_port|$fact_remembered|$fact_remembered_start"
}
# True when live PID $1 and port $2 are the record's own: only then does the record's process
# identify the server that answered. A historical or service-managed record answers PID 0, and
# whatever listens on its port may change without changing the key.
fact_bound() {
  [ "$1" = "$fact_pid" ] && [ "$2" = "$fact_record_port" ]
}
# Live protocol tokens from goat $1 for runtime record $2, port file $3 and PID file $4.
# Only a live answer from the record's own process is recorded; anything else is asked again.
live_fact() {
  live_fact_key "$1" "$2" "$3" "$4" || FACT_KEY=
  fact_name="live.$FACT_NAME"; fact_key="$FACT_KEY"
  if fact_get "$fact_name" "$fact_key"; then return 0; fi
  fact_out="$("$1" __ssh-helper protocol --runtime-file "$2" --port-file "$3" --pid-file "$4" --shell)" || return 1
  fact_answer="$(set -f; set -- $fact_out; printf '%s %s' "\${5:-}" "\${6:-}")"
  if [ -n "$fact_key" ] && live_fact_key "$1" "$2" "$3" "$4" && [ "$FACT_KEY" = "$fact_key" ] &&
     fact_valid live "$fact_out" && fact_bound "\${fact_answer% *}" "\${fact_answer#* }"; then
    fact_put "$fact_name" "$fact_key" "$fact_out"
  fi
  printf '%s\\n' "$fact_out"
}
# Compatibility tokens from goat $1 for the server on port $2, keyed like live_fact by $3-$5.
# $6 is the PID the live answer named; it is recorded only for the record's own process.
compat_fact() {
  live_fact_key "$1" "$3" "$4" "$5" || FACT_KEY=
  fact_name="compat.$FACT_NAME"; fact_key="$FACT_KEY"
  [ -z "$fact_key" ] || fact_key="$fact_key|$2"
  if fact_get "$fact_name" "$fact_key"; then return 0; fi
  fact_out="$("$1" __ssh-helper compat --port "$2")" || return 1
  if [ -n "$fact_key" ] && live_fact_key "$1" "$3" "$4" "$5" && [ "$FACT_KEY|$2" = "$fact_key" ] &&
     fact_valid compat "$fact_out" && fact_bound "$6" "$2"; then
    fact_put "$fact_name" "$fact_key" "$fact_out"
  fi
  printf '%s\\n' "$fact_out"
}
`;

const REMOTE_PROTOCOL_TOKEN_SCRIPT = `valid_version() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'
}
valid_uint() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)$' || return 1
  [ "\${#1}" -le 16 ] && awk -v n="$1" 'BEGIN { exit !(n <= 9007199254740991) }'
}
valid_positive() { valid_uint "$1" && [ "$1" != 0 ]; }
valid_port() { valid_uint "$1" && [ "$1" -le 65535 ]; }
valid_protocol_field() { [ "$1" = unknown ] || valid_positive "$1"; }
valid_own_tokens() {
  [ "$#" = 5 ] && valid_version "$1" && valid_protocol_field "$2" &&
    valid_protocol_field "$3" && valid_uint "$4" && valid_port "$5" || return 1
  # Own advertisement is normally not running: 0 0 is a valid pair.
  { [ "$4" = 0 ] && [ "$5" = 0 ]; } ||
    { valid_positive "$4" && valid_positive "$5"; }
}
valid_live_tokens() {
  [ "$#" = 6 ] && valid_uint "$5" && valid_port "$6" || return 1
  case "$1" in
    live) valid_version "$2" && valid_protocol_field "$3" &&
      valid_protocol_field "$4" && valid_positive "$6" ;;
    none) [ "$2 $3 $4 $5 $6" = 'unknown unknown unknown 0 0' ] ;;
    unknown) [ "$2 $3 $4" = 'unknown unknown unknown' ] ;;
    *) return 1 ;;
  esac
}
# Commit time of the build behind executable $1; fails for unstamped or older builds.
build_commit_time() {
  t="$(exec_fact commit "$1" __ssh-helper commit-time 2>/dev/null || true)"
  valid_positive "$t" && printf '%s' "$t"
}
# True only when executable $1 lists its session scopes and memory:read is not among them.
# Every GOAT CLI prints its scope choices here, so this also answers for builds before memory.
lacks_memory_scopes() {
  [ -x "$1" ] || return 1
  exec_fact_key "$1" || true
  scope_name="scopes.$FACT_NAME"; scope_key="$FACT_KEY"
  if ! scope_verdict="$(fact_get "$scope_name" "$scope_key")"; then
    scope_help="$("$1" auth session issue --help 2>/dev/null)" || return 1
    case "$scope_help" in *memory:read*) scope_verdict=has ;; *--scope*) scope_verdict=lacks ;; *) scope_verdict=unknown ;; esac
    if [ -n "$scope_key" ] && exec_fact_key "$1" && [ "$FACT_KEY" = "$scope_key" ]; then
      fact_put "$scope_name" "$scope_key" "$scope_verdict"
    fi
  fi
  [ "$scope_verdict" = lacks ]
}
runner_sha256() {
  if command -v shasum >/dev/null 2>&1; then digest="$(shasum -a 256 "$1")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$1")" || return 1
  else printf 'Install shasum or sha256sum to verify the retained GOAT runner.\\n' >&2; return 1; fi
  digest="\${digest%% *}"
  printf '%s\\n' "$digest" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s' "$digest"
}
${REMOTE_FACTS_SCRIPT}
`;

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteGoatRunnerOptions>;
  /**
   * Close only the local forward when a tunnel ends. A second client of a
   * host (the server's own SSH dispatch) shares the remote server with the
   * client that started it, so it must never stop that server.
   */
  readonly leaveRemoteServerRunning?: boolean;
}

interface ReconnectSelection {
  readonly runtime: PreparedRemoteRuntime;
  readonly generation: number;
  readonly revision: number;
  readonly identity: string;
}

interface SshTunnelEntry {
  readonly master?: SshMasterConnection;
  selectedRuntime: PreparedRemoteRuntime;
  reconnectSelection?: ReconnectSelection;
  attachmentInvalidated?: boolean;
  // Status can revalidate an attachment, but cannot prove a submitted drain was cancelled.
  uncertainDrain?: boolean;
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Closeable;
  readonly readiness: SshReadinessBudget;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshAuth.SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshEnsureSupersededError
  | SshPreparationTimeoutError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function isNodeScriptRunner(runner: RemoteGoatRunnerOptions | undefined): boolean {
  return Boolean(runner?.nodeScriptPath?.trim());
}

function sshRunnerLogFields(runner: RemoteGoatRunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.archiveVersion?.trim()) {
    return { runner: "archive", archiveVersion: runner.archiveVersion.trim() };
  }
  return { runner: "archive" };
}

interface SshAuthOperationInput<T> {
  readonly keyOnly?: boolean;
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuth.SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshRuntimeProgress {
  readonly target: DesktopSshEnvironmentTarget;
  readonly phase: SshRuntimePhase;
  readonly upload?: SshHostStatus["upload"];
}
export type SshRuntimeProgressCallback = (progress: SshRuntimeProgress) => void;
export interface SshEnvironmentEnsureOptions {
  readonly preparedAttachmentId?: string;
  readonly onPreparationProgress?: (progress: DesktopSshPreparationProgress) => void;
  readonly onPreparationAdmission?: (admission: PreparationAdmission) => void;
  readonly issuePairingToken?: boolean;
  readonly keyOnly?: boolean;
  readonly reuseWhileRefreshPending?: boolean;
  readonly refreshRuntime?: boolean;
  readonly confirmReplacement?: boolean;
  readonly onPhase?: SshRuntimeProgressCallback;
}

// Progress observers must never change the outcome of an SSH operation.
function notifyRuntimePhase(
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

/** Publications never resolve aliases or acquire installation locks; stale operations are ignored. */
export type SshSetupOutcome =
  | { readonly kind: "complete" }
  | {
      readonly kind: "error";
      readonly reason:
        | "diagnosis_failed"
        | "approval_expired"
        | "authorization_revoked"
        | "operation_failed";
      readonly message: string;
      readonly fix: SshHostFailure["fix"];
    };

export interface SshEnvironmentManagerShape {
  readonly readyEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<
    Exclude<DesktopSshEnvironmentReadyOrPending, DesktopSshRuntimePendingResult>,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;

  readonly beginSetupOperation: (
    target: DesktopSshEnvironmentTarget,
    operationId: string,
  ) => Effect.Effect<SshHostSetupProgress, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly publishSetupOutcome: (
    target: DesktopSshEnvironmentTarget,
    operation: Pick<SshHostSetupProgress, "generation" | "operationId">,
    outcome: SshSetupOutcome,
  ) => Effect.Effect<boolean>;
  readonly publishProviderDiagnosis: (
    target: DesktopSshEnvironmentTarget,
    operation: Pick<SshHostSetupProgress, "generation" | "operationId">,
    providers: SshHostProviders,
  ) => Effect.Effect<boolean, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly forgetEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options: { readonly stopRuntime: "if_idle" | "no" },
  ) => Effect.Effect<SshHostResult, SshEnvironmentEffectError, SshEnvironmentEffectContext>;

  readonly status: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<SshHostResult, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: SshEnvironmentEnsureOptions,
  ) => Effect.Effect<
    DesktopSshEnvironmentReadyOrPending,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  /**
   * Checks every open local forward and closes the ones that no longer
   * answer, so the next ensure opens a fresh forward instead of handing out
   * a dead one. Remote servers keep running. Used after the machine wakes,
   * when ssh itself can take up to its keepalive window (45 s) to notice.
   */
  readonly revalidateTunnels: () => Effect.Effect<void, never, SshEnvironmentEffectContext>;
  /**
   * Issues a short-lived `mcp-client` session on the remote environment so
   * this process can call the remote's `/mcp` like an outside agent.
   */
  readonly issueMcpClientSession: (
    target: DesktopSshEnvironmentTarget,
    options: RemoteMcpClientSessionOptions,
  ) => Effect.Effect<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly issueClientSession: (
    target: DesktopSshEnvironmentTarget,
    options: RemoteClientSessionOptions,
  ) => Effect.Effect<RemoteClientSession, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
  /** Runs a POSIX `sh` script on the remote host with this manager's SSH auth. */
  readonly runRemoteScript: (
    target: DesktopSshEnvironmentTarget,
    input: { readonly script: string; readonly timeoutMs?: number },
  ) => Effect.Effect<
    { readonly stdout: string; readonly stderr: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
}

export interface RemoteMcpClientSessionOptions {
  readonly requireReady?: boolean;
  readonly label: string;
  /** A duration the remote CLI accepts, such as `12h`. */
  readonly ttl: string;
  /** Most a thread started through this session may run with; null keeps the remote default. */
  readonly runtimeModeCeiling: string | null;
  /** Also grant `orchestration:approve`. A remote CLI that predates it fails the issue. */
  readonly approvals?: boolean;
  /** Also grant `providers:manage`, only for a caller that holds it live on this machine. */
  readonly providersManage?: boolean;
  /** Explicit task memory grants; an older CLI must refuse rather than omit them. */
  readonly memoryScopes?: ReadonlyArray<"memory:read" | "memory:write">;
}

export interface RemoteMcpClientSession {
  readonly token: string;
  readonly expiresAt: string | null;
  /** False when the remote CLI predates `--runtime-mode-ceiling` and kept its default. */
  readonly runtimeModeCeilingApplied: boolean;
}

export interface RemoteClientSessionOptions {
  readonly subject: string;
  readonly label: string;
  readonly ttl: string;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

export interface RemoteClientSession {
  readonly token: string;
  readonly expiresAt: string | null;
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
}

const RemoteLaunchResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("ready"),
    remotePort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
    serverKind: Schema.optionalKey(Schema.Literals(["external", "managed"])),
    selectedVersion: Schema.String,
    refresh: Schema.optionalKey(Schema.Literal("replaced")),
    pending: Schema.optionalKey(SshRuntimePendingReplacementSchema),
  }),
  Schema.Struct({ status: Schema.Literal("pending"), pending: SshRuntimePendingReplacementSchema }),
]);

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const RemoteMcpSessionResult = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
});

const RemoteClientSessionResult = Schema.Struct({
  token: Schema.String,
  expiresAt: Schema.optional(Schema.NullOr(Schema.String)),
  scopes: AuthEnvironmentScopes,
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));
const decodeRemoteMcpSessionResult = Schema.decodeEffect(fromLenientJson(RemoteMcpSessionResult));
const decodeRemoteClientSessionResult = Schema.decodeEffect(
  fromLenientJson(RemoteClientSessionResult),
);

const decodeRemoteJsonOutput = <A, E>(
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

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

const decodeRemotePairingOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemotePairingResult);

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function buildRemoteContendedOutput(
  pending: Pick<SshRuntimePendingReplacement, "replacement" | "requestedVersion" | "liveVersion">,
) {
  const fields = JSON.stringify({ reason: "contended", ...pending }).slice(1, -1);
  return `lock_pending_fields=${shellSingleQuote(fields)}
if [ "$LOCK_DETAIL" = recovery-stale ]; then lock_pending_fields="$lock_pending_fields,"'"detail":"recovery-stale"'; fi
printf '{"status":"pending","pending":{%s}}\\n' "$lock_pending_fields"`;
}

function applyScriptPlaceholders(
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

export { describeReadinessCause };

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(!error));
    });
  });
}

// macOS lets the bind above succeed while another process listens on
// *:<port>, so also skip any port that already answers on loopback.
function answersOnLoopback(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = (await canBind(port)) && !(await answersOnLoopback(port));
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

const REMOTE_WAIT_READY_SCRIPT = `const http = require("node:http");
const port = Number.parseInt(process.argv[2] ?? "", 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? "", 10);
const probeTimeoutMs = Number.parseInt(process.argv[4] ?? "", 10);
if (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {
  process.exit(1);
}
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probe() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        timeout: probeTimeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

(async () => {
  while (Date.now() < deadline) {
    if (await probe()) {
      process.exit(0);
    }
    await sleep(100);
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

// Retained runners are data: inspect either declaration spelling without sourcing shell code.
const REMOTE_RUNNER_HINT_SCRIPT = String.raw`read_runner_hint() {
  if grep -q "^$2=" "$1"; then hint_key="$2"; else hint_key="$3"; fi
  sed -n "s/^$hint_key='\(.*\)'$/\1/p" "$1"
}
`;

const REMOTE_NODE_ENV_SCRIPT = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

remote_node_satisfies_engine() {
  GOAT_NODE_ENGINE_RANGE=@@GOAT_NODE_ENGINE_RANGE@@
  if [ -z "$GOAT_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$GOAT_NODE_ENGINE_RANGE" <<'NODE'
@@GOAT_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

ensure_remote_node_path() {
  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/home/linuxbrew/.linuxbrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"
  # lsof lives in sbin on macOS. A login PATH that already has node returns
  # before these lines, so the launch script also prepends them unconditionally.
  prepend_path_if_dir "/usr/sbin"
  prepend_path_if_dir "/sbin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for GOAT_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$GOAT_NODE_BIN/node" ]; then
        PATH="$GOAT_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;

const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
@@GOAT_NODE_ENV_SCRIPT@@
GOAT_NODE_SCRIPT_PATH=@@GOAT_NODE_SCRIPT_PATH@@
# Older clients inspect these literal declarations without evaluating the runner.
${LEGACY_SSH_NODE_SCRIPT_PATH_KEY}=@@GOAT_NODE_SCRIPT_PATH@@
if [ -n "$GOAT_NODE_SCRIPT_PATH" ]; then
  # Dev mode: a source checkout on the remote. This is the only path that
  # needs Node, so Node discovery runs here and nowhere else.
  ensure_remote_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    printf 'Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$GOAT_NODE_SCRIPT_PATH" "$@"
fi
GOAT_ARCHIVE_VERSION=@@GOAT_ARCHIVE_VERSION@@
${LEGACY_SSH_ARCHIVE_VERSION_KEY}=@@GOAT_ARCHIVE_VERSION@@
if [ -z "$GOAT_ARCHIVE_VERSION" ]; then
  printf 'No GOAT release version was provided for the remote runtime.\\n' >&2
  exit 1
fi
# Self-contained release archive: no Node, npm, or compiler on the remote.
# Unpacked into the pinned-runtime layout so \`goat service install\` reuses it.
GOAT_RELEASE_BASE_URL=@@GOAT_RELEASE_BASE_URL@@
GOAT_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$GOAT_ARCHIVE_VERSION"
goat_runtime_ready() {
  [ -x "$GOAT_RUNTIME_DIR/goat" ] && [ "$(cat "$GOAT_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$GOAT_ARCHIVE_VERSION" ]
}
if ! goat_runtime_ready; then
  mkdir -p "$HOME/.goat/runtime/goat/versions"
  # Cleanup takes this mutex exclusively; installs may still run concurrently.
  if [ "$(uname -s)" = Linux ] && command -v flock >/dev/null 2>&1; then
    GOAT_MAINTENANCE="$HOME/.goat/runtime/goat/versions/.maintenance.lock"
    [ ! -L "$GOAT_MAINTENANCE" ] || exit 1
    exec 9>"$GOAT_MAINTENANCE"
    flock -w @@GOAT_ARCHIVE_LOCK_WAIT_SECONDS@@ -s 9
  fi
  GOAT_LOCK="$HOME/.goat/runtime/goat/versions/.$GOAT_ARCHIVE_VERSION.install.lock"
  # Publish a nonempty directory with an immutable pid and unique token by
  # same-filesystem rename. mv can nest it in an existing lock: only a token
  # at the lock root proves acquisition; losers clean their candidate and
  # retry. There is no mkdir-to-pid window at the shared lock path.
  # Reclaimers cd into the generation BEFORE reading its pid, and delete
  # only relative contents of that directory. The final rmdir cannot remove
  # a newer generation because every published lock is already nonempty.
  # A reclaim counts only once the lock is gone; a lock that cannot be
  # entered or emptied waits like a live one, so the timeout still applies.
  # Legacy pid-less locks retain their short grace period.
  GOAT_LOCK_CANDIDATE=""
  GOAT_LOCK_TOKEN=""
  GOAT_STAGING=""
  goat_remove_lock_contents() {
    find . ! -name . -prune -exec rm -rf {} \\; 2>/dev/null || true
    rmdir "$GOAT_LOCK" 2>/dev/null || [ ! -e "$GOAT_LOCK" ]
  }
  goat_lock_cleanup() {
    (
      cd "$GOAT_LOCK" 2>/dev/null || exit 0
      [ -n "$GOAT_LOCK_TOKEN" ] && [ -f "./$GOAT_LOCK_TOKEN" ] || exit 0
      goat_remove_lock_contents || true
    ) || true
    if [ -n "$GOAT_LOCK_CANDIDATE" ]; then
      rm -rf "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK/\${GOAT_LOCK_CANDIDATE##*/}"
    fi
    if [ -n "$GOAT_STAGING" ]; then rm -rf "$GOAT_STAGING"; fi
  }
  trap 'goat_lock_cleanup' 0
  trap 'exit 1' 1 2 3 15
  goat_reclaim_lock() (
    if ! cd "$GOAT_LOCK" 2>/dev/null; then
      if [ -e "$GOAT_LOCK" ]; then exit 3; fi
      exit 0
    fi
    GOAT_LOCK_OWNER="$(cat pid 2>/dev/null || true)"
    if [ -n "$GOAT_LOCK_OWNER" ]; then
      if kill -0 "$GOAT_LOCK_OWNER" 2>/dev/null; then exit 2; fi
    elif [ "$GOAT_LOCK_UNOWNED" -lt 4 ]; then
      exit 1
    fi
    goat_remove_lock_contents || exit 3
  )
  GOAT_LOCK_WAITED=0
  GOAT_LOCK_UNOWNED=0
  while :; do
    GOAT_LOCK_CANDIDATE="$(mktemp -d "$GOAT_LOCK.candidate-$$-XXXXXX")"
    GOAT_LOCK_TOKEN="\${GOAT_LOCK_CANDIDATE##*/}"
    if { printf '%s\\n' "$$" > "$GOAT_LOCK_CANDIDATE/pid" &&
         : > "$GOAT_LOCK_CANDIDATE/$GOAT_LOCK_TOKEN"; } 2>/dev/null; then
      mv "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK" 2>/dev/null || true
      if [ -f "$GOAT_LOCK/$GOAT_LOCK_TOKEN" ]; then break; fi
    fi
    rm -rf "$GOAT_LOCK_CANDIDATE" "$GOAT_LOCK/$GOAT_LOCK_TOKEN"
    GOAT_LOCK_CANDIDATE=""
    if [ ! -e "$GOAT_LOCK" ]; then
      # Publication failed with no competing lock; wait so a persistent
      # failure reaches the timeout.
      :
    elif goat_reclaim_lock; then continue
    else
      GOAT_LOCK_STATUS=$?
      case "$GOAT_LOCK_STATUS" in
        1) GOAT_LOCK_UNOWNED=$((GOAT_LOCK_UNOWNED + 1)) ;;
        2) GOAT_LOCK_UNOWNED=0 ;;
      esac
    fi
    if [ "$GOAT_LOCK_WAITED" -ge @@GOAT_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
      printf 'Another GOAT %s installation has held %s for too long.\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_LOCK" >&2
      exit 1
    fi
    sleep 1
    GOAT_LOCK_WAITED=$((GOAT_LOCK_WAITED + 1))
  done
fi
if ! goat_runtime_ready; then
  case "$(uname -s)" in
    Darwin) GOAT_PLATFORM="darwin" ;;
    Linux) GOAT_PLATFORM="linux" ;;
    MINGW* | MSYS* | CYGWIN*) GOAT_PLATFORM="win32" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64 | aarch64) GOAT_ARCH="arm64" ;;
    x86_64 | amd64) GOAT_ARCH="x64" ;;
    *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
  esac
  GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM-$GOAT_ARCH.tar.gz"
  if [ "$GOAT_PLATFORM" = win32 ]; then GOAT_ARCHIVE="goat-$GOAT_ARCHIVE_VERSION-$GOAT_PLATFORM-$GOAT_ARCH.zip"; fi
  GOAT_STAGING="$(mktemp -d "$HOME/.goat/runtime/goat/versions/.staging-XXXXXX")"
  goat_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$1" -O "$2"
    else printf 'Remote host needs curl or wget to download %s.\\n' "$GOAT_ARCHIVE" >&2; exit 1
    fi
  }
  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/SHA256SUMS" "$GOAT_STAGING/SHA256SUMS" @@GOAT_ARCHIVE_CHECKSUMS_SECONDS@@
  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/$GOAT_ARCHIVE" "$GOAT_STAGING/$GOAT_ARCHIVE" @@GOAT_ARCHIVE_DOWNLOAD_SECONDS@@
  GOAT_EXPECTED="$(grep " \\*\\{0,1\\}$GOAT_ARCHIVE$" "$GOAT_STAGING/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    GOAT_ACTUAL="$(sha256sum "$GOAT_STAGING/$GOAT_ARCHIVE" | cut -d' ' -f1)"
  else
    GOAT_ACTUAL="$(shasum -a 256 "$GOAT_STAGING/$GOAT_ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ -z "$GOAT_EXPECTED" ] || [ "$GOAT_ACTUAL" != "$GOAT_EXPECTED" ]; then
    printf 'Checksum mismatch for %s.\\n' "$GOAT_ARCHIVE" >&2; exit 1
  fi
  if [ "$GOAT_PLATFORM" = win32 ]; then
    # Git Bash's GNU tar cannot read zip; Windows ships bsdtar in System32.
    "$(cygpath -S)/tar.exe" -xf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1
  else
    tar -xzf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1
  fi
  rm -f "$GOAT_STAGING/$GOAT_ARCHIVE" "$GOAT_STAGING/SHA256SUMS"
  # Verify the executable and exact version before replacing a runtime,
  # including a same-version directory whose completion marker is broken.
  if ! GOAT_STAGED_VERSION_OUTPUT="$("$GOAT_STAGING/goat" --version)"; then
    printf 'The goat %s executable does not run on this host.\\n' "$GOAT_ARCHIVE_VERSION" >&2; exit 1
  fi
  if [ "$GOAT_STAGED_VERSION_OUTPUT" != "goat v$GOAT_ARCHIVE_VERSION" ]; then
    printf 'Cannot install goat %s: expected goat v%s, but the archive executable reported "%s". The existing runtime directory and completion marker have been left unchanged. Supply the correct requested archive in the local SSH runtime archive directory or release mirror, then retry.\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_ARCHIVE_VERSION" "$GOAT_STAGED_VERSION_OUTPUT" >&2
    exit 1
  fi
  if command -v shasum >/dev/null 2>&1; then
    GOAT_EXECUTABLE_SHA256="$(shasum -a 256 "$GOAT_STAGING/goat" | cut -d' ' -f1)"
  else
    GOAT_EXECUTABLE_SHA256="$(sha256sum "$GOAT_STAGING/goat" | cut -d' ' -f1)"
  fi
  # Publish provenance with the verified executable, never backfill legacy directories.
  # The uploader names its source in the environment so run-t3.sh bytes stay source-free:
  # retained-runner identity compares those bytes across launches.
  case "\${GOAT_SSH_ARCHIVE_SOURCE:-}" in
    bundle|cache|gh) GOAT_RECORD_SOURCE="$GOAT_SSH_ARCHIVE_SOURCE" ;;
    *) GOAT_RECORD_SOURCE=@@GOAT_DOWNLOAD_SOURCE@@ ;;
  esac
  printf '%s %s %s %s\\n' "$GOAT_ARCHIVE_VERSION" "$GOAT_EXPECTED" "$GOAT_EXECUTABLE_SHA256" "$GOAT_RECORD_SOURCE" > "$GOAT_STAGING/.install-record"
  printf '%s\\n' "$GOAT_ARCHIVE_VERSION" > "$GOAT_STAGING/.install-complete"
  rm -rf "$GOAT_RUNTIME_DIR"
  mv "$GOAT_STAGING" "$GOAT_RUNTIME_DIR"
fi
if [ -n "\${GOAT_LOCK:-}" ]; then
  goat_lock_cleanup
  trap - 0 1 2 3 15
fi
exec 9>&-
exec "$GOAT_RUNTIME_DIR/goat" "$@"
`;

// Process inspection for the lock owner (this shell) and the server it launches. On a Windows
// host, Git Bash and Cygwin list only their own processes in /proc and ps, while the server is a
// native process: PowerShell reads its identity, and the identity's Windows paths are mapped back
// to the POSIX form the launch script records.
export const REMOTE_HOST_PROCESS_SCRIPT = String.raw`case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    GOAT_HOST_WINDOWS=1
    # By default ln -s copies, so the lock's dangling owner link could not be created.
    MSYS="winsymlinks:sys${"${MSYS:+ $MSYS}"}"; CYGWIN="winsymlinks:sys${"${CYGWIN:+ $CYGWIN}"}"; export MSYS CYGWIN ;;
  *) GOAT_HOST_WINDOWS=0 ;;
esac
if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
  process_start() { [ -r "/proc/$1/stat" ] && sed 's/^.*) //' "/proc/$1/stat" | awk '{ print $20 }'; }
  process_presence() {
    [ -d /proc/self ] || return 1
    if [ -d "/proc/$1" ]; then echo present; else echo absent; fi
  }
  windows_process_info() {
    win_info="$(GOAT_PROCESS_ID="$1" MSYS2_ARG_CONV_EXCL='*' powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand(WINDOWS_PROCESS_INFO_POWERSHELL)}' </dev/null 2>/dev/null)" || return 1
    printf '%s\n' "$win_info" | tr -d '\r'
  }
  server_alive() {
    MSYS2_ARG_CONV_EXCL='*' tasklist.exe /FI "PID eq $1" /NH /FO CSV 2>/dev/null | grep -q "^\"[^\"]*\",\"$1\","
  }
  server_kill() { MSYS2_ARG_CONV_EXCL='*' taskkill.exe /PID "$1" /F >/dev/null 2>&1; }
  server_uid() {
    win_info="$(windows_process_info "$1")" || return 1
    if [ "$(printf '%s\n' "$win_info" | sed -n 1p)" = self ]; then id -u; else echo other; fi
  }
  server_start() {
    win_info="$(windows_process_info "$1")" || return 1
    printf '%s\n' "$win_info" | sed -n 2p
  }
  server_command() {
    win_info="$(windows_process_info "$1")" || return 1
    win_words="$(printf '%s\n' "$win_info" | sed '1,2d')"
    [ -n "$win_words" ] || return 1
    win_line=; win_first=1
    while IFS= read -r win_word; do
      case "$win_word" in [A-Za-z]:[\\/]*) win_word="$(cygpath -u "$win_word")" || return 1 ;; esac
      if [ "$win_first" = 1 ]; then
        win_line="$(printf '%s' "$win_word" | sed 's/\.[Ee][Xx][Ee]$//')"; win_first=0
      else win_line="$win_line $win_word"; fi
    done <<GOAT_WORDS
$win_words
GOAT_WORDS
    printf '%s\n' "$win_line"
  }
  # Starts a program outside the SSH session's job, appending its output to $1; prints its PID.
  # The program and arguments are passed as given, so callers convert paths with cygpath -w.
  windows_spawn_detached() {
    win_log="$(cygpath -w "$1")" || return 1; shift
    win_args=
    for win_word in "$@"; do
      win_args="$win_args$win_word
"
    done
    win_pid="$(GOAT_SPAWN_LOG="$win_log" GOAT_SPAWN_ARGS="$win_args" GOAT_SPAWN_ENV='T3CODE_NO_BROWSER=1' MSYS2_ARG_CONV_EXCL='*' powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand(WINDOWS_DETACHED_SPAWN_POWERSHELL)}' </dev/null)" || return 1
    printf '%s\n' "$win_pid" | tr -d '\r'
  }
else
  process_start() { LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null; }
  process_presence() {
    process_table="$(ps -e -o pid= 2>/dev/null)" || return 1
    printf '%s\n' "$process_table" | awk -v p="$1" '$1==p { found=1 } END { print found ? "present" : "absent" }'
  }
  # An exited, unreaped server still passes kill -0; it cannot be reused.
  # /proc is authoritative for that zombie. ps can return an empty stat under load
  # and must not turn a dead server back into a live one.
  server_alive() {
    [ -n "$1" ] && kill -0 "$1" 2>/dev/null || return 1
    if [ -r "/proc/$1/stat" ]; then
      alive_state="$(sed -n 's/.*) //p' "/proc/$1/stat" 2>/dev/null | awk '{ print $1 }' || true)"
      case "$alive_state" in
        Z) return 1 ;;
        ?*) return 0 ;;
      esac
    fi
    kill -0 "$1" 2>/dev/null || return 1
    case "$(ps -o stat= -p "$1" 2>/dev/null || true)" in *Z*) return 1 ;; esac
  }
  server_kill() { kill "$1" 2>/dev/null; }
  server_uid() { ps -o uid= -p "$1" 2>/dev/null; }
  server_start() { process_start "$1"; }
  server_command() { ps -o command= -p "$1" 2>/dev/null; }
fi
`;

// One host-wide mutex protects publication and server lifecycle across SSH aliases.
const REMOTE_REPLACEMENT_LOCK_SCRIPT = String.raw`${REMOTE_HOST_PROCESS_SCRIPT}LOCK="$DEFAULT_SERVER_HOME/ssh-launch/replacement.lock"
RECOVERY="$DEFAULT_SERVER_HOME/ssh-launch/replacement.recovery"
LOCK_HELD=0; OWNER=; LOCK_DETAIL=
release_replacement_lock() {
  if [ -n "$OWNER" ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then rm -f "$LOCK"; fi
  LOCK_HELD=0
}
release_recovery_lock() {
  if [ -n "$OWNER" ] && [ "$(readlink "$RECOVERY" 2>/dev/null || true)" = "$OWNER" ]; then rm -f "$RECOVERY"; fi
}
owner_proven_dead() {
  recorded="$1"
  old_ifs="$IFS"; IFS='|'; set -f; set -- $recorded; IFS="$old_ifs"
  [ "$#" = 5 ] && [ "$1" = "$LOCK_HOST" ] && [ "$2" = "$LOCK_UID" ] &&
    valid_positive "$3" && [ -n "$4" ] && [ -n "$5" ] || return 1
  owner_pid="$3"; owner_start="$4"
  # Failure to inspect the process table is not proof of death (nor is age).
  presence="$(process_presence "$owner_pid")" || return 1
  case "$presence" in absent) return 0 ;; present) ;; *) return 1 ;; esac
  current_start="$(process_start "$owner_pid")" || return 1
  [ -n "$current_start" ] && [ "$current_start" != "$owner_start" ]
}
acquire_replacement_lock() {
  if [ "$LOCK_HELD" = 1 ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then return 0; fi
  LOCK_HOST="$(uname -n 2>/dev/null)" || return 1
  LOCK_UID="$(id -u 2>/dev/null)" || return 1
  LOCK_START="$(process_start "$$")" || return 1
  [ -n "$LOCK_HOST" ] && [ -n "$LOCK_UID" ] && [ -n "$LOCK_START" ] || return 1
  nonce_dir="$(mktemp -d "$STATE_DIR/lock-owner-XXXXXX")" || return 1
  NONCE="$(basename "$nonce_dir")"
  rmdir "$nonce_dir" || return 1
  OWNER="$LOCK_HOST|$LOCK_UID|$$|$LOCK_START|$NONCE"
  mkdir -p "$DEFAULT_SERVER_HOME/ssh-launch"
  if [ ! -d "$LOCK" ] && ln -s "$OWNER" "$LOCK" 2>/dev/null &&
     [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then LOCK_HELD=1; return 0; fi
  dead_owner="$(readlink "$LOCK" 2>/dev/null)" || return 1
  owner_proven_dead "$dead_owner" || return 1
  if [ -d "$RECOVERY" ] || ! ln -s "$OWNER" "$RECOVERY" 2>/dev/null ||
     [ "$(readlink "$RECOVERY" 2>/dev/null || true)" != "$OWNER" ]; then
    printf 'Recovery is locked; remove %s after checking that no GOAT client is replacing this runtime.\n' "$RECOVERY" >&2
    LOCK_DETAIL=recovery-stale
    return 1
  fi
  # Only serialized recoverers can remove a dead owner's unchanged link.
  if [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$dead_owner" ] && owner_proven_dead "$dead_owner"; then rm -f "$LOCK"; fi
  release_recovery_lock
  if [ ! -d "$LOCK" ] && ln -s "$OWNER" "$LOCK" 2>/dev/null &&
     [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then LOCK_HELD=1; return 0; fi
  return 1
}
wait_for_replacement_lock() {
  replacement_wait=0
  while [ -e "$LOCK" ] || [ -L "$LOCK" ]; do
    [ "$replacement_wait" -lt ${REMOTE_REPLACEMENT_WAIT_ATTEMPTS} ] || return 1
    waiting_owner="$(readlink "$LOCK" 2>/dev/null)" || return 1
    old_ifs="$IFS"; IFS='|'; set -f; set -- $waiting_owner; IFS="$old_ifs"
    [ "$#" = 5 ] && [ "$1" = "$(uname -n)" ] && [ "$2" = "$(id -u)" ] &&
      valid_positive "$3" && [ -n "$4" ] && [ -n "$5" ] || return 1
    # Only a proven local owner can make progress; foreign or ambiguous locks stay pending.
    [ "$(process_start "$3" 2>/dev/null)" = "$4" ] || return 1
    replacement_wait=$((replacement_wait + 1))
    sleep 0.1
  done
}
`;

// Publishing a runner is the switch boundary. Execute the candidate first;
// auth commands keep an existing runner so they match its running server.
const REMOTE_PROTOCOL_GUARD_SCRIPT = `compatible_fields() {
  # version ssh orchestration; full matching integers OR exact legacy.
  [ "$2" = "@@GOAT_SSH_PROTOCOL@@" ] && [ "$3" = "@@GOAT_ORCHESTRATION_PROTOCOL@@" ] && return 0
  [ -n "$REQUESTED_VERSION" ] && [ "$1" = "$REQUESTED_VERSION" ] &&
    { [ "$2" = unknown ] || [ "$2" = "@@GOAT_SSH_PROTOCOL@@" ]; } &&
    { [ "$3" = unknown ] || [ "$3" = "@@GOAT_ORCHESTRATION_PROTOCOL@@" ]; }
}
check_candidate_protocol() {
  if [ -n "$SELECTED_VERSION" ] &&
     [ "$(exec_fact version "$CHECK_RUNNER" --version 2>/dev/null || true)" != "goat v$SELECTED_VERSION" ]; then
    printf 'Selected executable changed before protocol use.\\n' >&2; exit 1
  fi
  if own="$(exec_fact own "$CHECK_RUNNER" __ssh-helper protocol --shell 2>/dev/null)"; then
    set -f; set -- $own
    if ! valid_own_tokens "$@"; then printf 'Malformed candidate protocol output.\\n' >&2; exit 1; fi
    if [ -n "$SELECTED_VERSION" ] && [ "$1" != "$SELECTED_VERSION" ]; then
      printf 'Selected version and binary protocol identity disagree.\\n' >&2; exit 1
    fi
    if ! compatible_fields "$1" "$2" "$3"; then
      printf 'Candidate signals %s incompatible with SSH=%s orchestration=%s.\\n' "$own" "@@GOAT_SSH_PROTOCOL@@" "@@GOAT_ORCHESTRATION_PROTOCOL@@" >&2; exit 1
    fi
  elif [ -z "$SELECTED_VERSION" ] || [ "$SELECTED_VERSION" != "$REQUESTED_VERSION" ] ||
       [ "$(exec_fact version "$CHECK_RUNNER" --version 2>/dev/null || true)" != "goat v$REQUESTED_VERSION" ]; then
    printf 'No protocol signals; only an independently proven exact release is allowed.\\n' >&2; exit 1
  fi
}
check_live_protocol() {
  LIVE_STATUS=none; LIVE_PID=0; LIVE_PORT=0; LIVE_VERSION=unknown
  LIVE_COMPATIBLE=0; LIVE_OWNED=0; NEEDS_OWNED_UPGRADE=0; REPLACEMENT_REASON=incompatible; comparison=
  LIVE_DRAIN=0; LIVE_INSTANCE_ID=; DEFER_NO_DRAIN=0
  if live="$(live_fact "$CHECK_RUNNER" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 2>/dev/null)"; then
    set -f; set -- $live
    if ! valid_live_tokens "$@"; then printf 'Malformed live protocol output.\n' >&2; exit 1; fi
    LIVE_STATUS="$1"; LIVE_VERSION="$2"; LIVE_PID="$5"; LIVE_PORT="$6"
    if [ "$LIVE_STATUS" = live ] && valid_positive "$LIVE_PID" &&
       [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] &&
       [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$LIVE_PID" ] &&
       [ "$(cat "$PORT_FILE" 2>/dev/null || true)" = "$LIVE_PORT" ]; then LIVE_OWNED=1; fi
    if [ "$LIVE_STATUS" = live ]; then read_live_compat "$2" "$3" "$4"; fi
  else
    if [ -e "$DEFAULT_RUNTIME_FILE" ] || [ -e "$PORT_FILE" ] || [ -e "$PID_FILE" ]; then LIVE_STATUS=unknown; fi
  fi
  DRAIN_UNCERTAIN=0
  if [ -e "$STATE_DIR/draining" ] || [ -L "$STATE_DIR/draining" ]; then
    draining_instance="$(cat "$STATE_DIR/draining" 2>/dev/null || true)"
    if [ "$LIVE_STATUS" = none ] ||
       { [ -n "$draining_instance" ] && [ -n "$LIVE_INSTANCE_ID" ] && [ "$draining_instance" != "$LIVE_INSTANCE_ID" ]; }; then
      # Only an owner can retire a fence after the live helper proves its start is gone.
      if [ "$LOCK_HELD" = 1 ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; then
        rm -f "$STATE_DIR/draining"
      fi
    else DRAIN_UNCERTAIN=1; fi
  fi
@@GOAT_RECONNECT_LIVE_GUARD@@  if [ "$ALLOW_LEGACY_ADOPTION" = 1 ] &&
     { [ "$LIVE_STATUS" = unknown ] || { [ "$LIVE_STATUS" = live ] && [ "$LIVE_OWNED" = 1 ] && [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ]; }; }; then
    legacy_verified=1
    if [ "$LEGACY_COMMITTED" = 1 ]; then
      verify_owned_identity "$LEGACY_PID" "$LEGACY_PORT" || ownership_unverified
    elif ! verify_legacy_identity; then legacy_verified=0; LIVE_STATUS=unknown; fi
    if [ "$legacy_verified" = 1 ] && [ "$LEGACY_PENDING" = 1 ]; then
      LIVE_STATUS=live; LIVE_PID="$LEGACY_PID"; LIVE_PORT="$LEGACY_PORT"; LIVE_VERSION="$LEGACY_VERSION"
      LIVE_OWNED=1; REPLACEMENT_REASON=legacy; NEEDS_OWNED_UPGRADE=1
    fi
  fi
  if [ "$ALLOW_OWNED_UPGRADE" = 1 ] && [ "$LIVE_OWNED" = 1 ] && [ "$LEGACY_PENDING" != 1 ] &&
     [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ]; then LIVE_STATUS=unknown; fi
  if [ "$LIVE_STATUS" = unknown ]; then
    recorded_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    recorded_port="$(cat "$PORT_FILE" 2>/dev/null || true)"
    valid_positive "$recorded_pid" || recorded_pid=unknown
    valid_positive "$recorded_port" || recorded_port=unknown
    stop_pid="$recorded_pid"
    [ "$stop_pid" != unknown ] || stop_pid='<pid>'
    printf 'Cannot verify live GOAT PID=%s port=%s: descriptor unavailable or persisted identity disagrees; it may predate GOAT SSH runtime protocol metadata. It was left running, and the runner and ownership files were preserved. If this is your earlier GOAT server, stop it on the remote host (kill %s) and reconnect.\\n' "$recorded_pid" "$recorded_port" "$stop_pid" >&2; exit 1
  fi
  if [ "$LIVE_OWNED" = 1 ] && [ "$ALLOW_OWNED_UPGRADE" = 1 ] && [ "$LEGACY_PENDING" != 1 ]; then
    verify_owned_identity "$LIVE_PID" "$LIVE_PORT" || ownership_unverified
  fi
  if [ "$LIVE_STATUS" = live ] && [ -n "$REQUESTED_VERSION" ]; then
    if [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_VERSION" = "$SELECTED_VERSION" ] && [ "$NEEDS_OWNED_UPGRADE" = 0 ]; then
      # A retained compatible selection only reuses its proven live version;
      # older compatible helpers need not implement the new replacement comparator.
      comparison=selected
    else
      # Commit times order builds whose versions cannot (dev shas, dev against nightly).
      set --
      if live_commit="$(build_commit_time "$HOME/.goat/runtime/goat/versions/$LIVE_VERSION/goat")" &&
         requested_commit="$(build_commit_time "$RUNNER_CANDIDATE_FILE.pin")"; then
        set -- --live-commit-time "$live_commit" --requested-commit-time "$requested_commit"
      fi
      comparison="$("$RUNNER_CANDIDATE_FILE.pin" __ssh-helper compare-version "$@" "$LIVE_VERSION" "$REQUESTED_VERSION" 2>/dev/null || true)"
    fi
    case "$comparison" in
      selected) ;;
      newer)
        if [ "$LIVE_COMPATIBLE" != 1 ]; then
          printf 'Remote runtime is newer than this app; update the app.\n' >&2; exit 1
        fi
        NEEDS_OWNED_UPGRADE=0 ;;
      unknown)
        # No proven order: never replace, so a possibly newer server is never downgraded.
        if [ "$LIVE_COMPATIBLE" != 1 ]; then
          printf 'Remote runtime GOAT %s cannot be ordered against this app (GOAT %s); it was left running. Stop it on the remote host when its work is done, then reconnect.\n' "$LIVE_VERSION" "$REQUESTED_VERSION" >&2; exit 1
        fi
        NEEDS_OWNED_UPGRADE=0
        # Except a server that cannot issue the sessions this app needs: keeping it would leave
        # the host unusable for those tasks, so an idle refresh replaces it with this build.
        if [ "$REFRESH_IF_IDLE" = 1 ] && [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_OWNED" = 1 ] && [ "$REPLACEMENT_REASON" != legacy ] &&
           lacks_memory_scopes "$HOME/.goat/runtime/goat/versions/$LIVE_VERSION/goat"; then
          REPLACEMENT_REASON=capability; NEEDS_OWNED_UPGRADE=1
        fi ;;
      older)
        if [ "$REFRESH_IF_IDLE" = 1 ] && [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_OWNED" = 1 ] && [ "$REPLACEMENT_REASON" != legacy ]; then
          REPLACEMENT_REASON=older; NEEDS_OWNED_UPGRADE=1
        fi ;;
      equal) ;;
      *)
        # Exact-version old helpers may lack comparison; no ordering decision is needed.
        if [ "$LIVE_VERSION" != "$REQUESTED_VERSION" ]; then
          printf 'Cannot verify remote version ordering; process was preserved.\n' >&2; exit 1
        fi ;;
    esac
  fi
  if [ "$LIVE_STATUS" = live ] && [ "$LIVE_COMPATIBLE" != 1 ]; then
    if [ "$ALLOW_OWNED_UPGRADE" = 1 ] && [ "$LIVE_OWNED" = 1 ]; then NEEDS_OWNED_UPGRADE=1
    else printf 'Live GOAT PID=%s port=%s is incompatible; it was left running. Upgrade with the owning client or reconnect.\n' "$LIVE_PID" "$LIVE_PORT" >&2; exit 1; fi
  fi
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] && [ "$ALLOW_OWNED_UPGRADE" != 1 ]; then
    printf 'Secondary preparation cannot replace a live runtime.\n' >&2; exit 1
  fi
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] && [ "$LIVE_DRAIN" != 1 ]; then
    if [ "$REFRESH_IF_IDLE" = 1 ] && [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_OWNED" = 1 ] &&
       { [ "$REPLACEMENT_REASON" = older ] || [ "$REPLACEMENT_REASON" = capability ]; }; then
      DEFER_NO_DRAIN=1
    elif [ "$REPLACEMENT_REASON" = legacy ]; then
      printf 'Live GOAT PID=%s port=%s was started by an older app that cannot hand over ownership without draining; it was left running. Stop it on the remote host when its work is done, then reconnect.\n' "$LIVE_PID" "$LIVE_PORT" >&2; exit 1
    else
      printf 'Live GOAT PID=%s port=%s is incompatible; it was left running because it cannot drain for a replacement and this app cannot attach to it. Stop it on the remote host when its work is done, then reconnect.\n' "$LIVE_PID" "$LIVE_PORT" >&2; exit 1
    fi
  fi
}
read_live_compat() {
  # The pinned helper applies the one protocol-range comparator. A helper that
  # predates it, or a server without integers, falls back to exact fields.
  compat_version="$1"; compat_ssh="$2"; compat_orchestration="$3"
  if compat_tokens="$(compat_fact "$RUNNER_CANDIDATE_FILE.pin" "$LIVE_PORT" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" "$LIVE_PID" 2>/dev/null)"; then
    set -f; set -- $compat_tokens
    if [ "$#" = 3 ]; then
      case "$1" in
        compatible) LIVE_COMPATIBLE=1 ;;
        unknown) if compatible_fields "$compat_version" "$compat_ssh" "$compat_orchestration"; then LIVE_COMPATIBLE=1; fi ;;
      esac
      case "$3" in
        -|''|*[!A-Za-z0-9-]*) ;;
        *) if [ "$2" = 1 ]; then LIVE_DRAIN=1; LIVE_INSTANCE_ID="$3"; fi ;;
      esac
      return 0
    fi
  fi
  if compatible_fields "$compat_version" "$compat_ssh" "$compat_orchestration"; then LIVE_COMPATIBLE=1; fi
}
recheck_selected_before_use() {
  check_retained_runner
  # Never let a vanished ready selection become a network install.
  if [ "$REQUIRE_INSTALLED" = 1 ] && [ -n "$SELECTED_VERSION" ]; then
    selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
    if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
      printf 'Selected GOAT runtime disappeared before use.\\n' >&2; exit 1
    fi
  fi
  if [ "$RUNNER_PUBLISHED" = 1 ]; then
    if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_FILE"; then
      printf 'Published selected runner changed before use.\\n' >&2; exit 1
    fi
    CHECK_RUNNER="$RUNNER_FILE"
  else
    if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_NEXT"; then
      printf 'Candidate runner changed before use.\\n' >&2; exit 1
    fi
    CHECK_RUNNER="$RUNNER_NEXT"
  fi
  check_candidate_protocol
  check_live_protocol
  CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
}
`;

const REMOTE_RUNNER_SETUP_SCRIPT = `RUNNER_FILE="$STATE_DIR/run-t3.sh"
RUNNER_NEXT="$STATE_DIR/run-t3.next.$$"
RUNNER_CANDIDATE_FILE="$RUNNER_NEXT"
CHECK_RUNNER="$RUNNER_NEXT"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
REQUESTED_RUNNER=@@GOAT_REQUESTED_RUNNER@@
EXPECTED_ARCHIVE_VERSION=@@GOAT_EXPECTED_ARCHIVE_VERSION@@
SELECTED_VERSION=@@GOAT_SELECTED_VERSION@@
REQUESTED_VERSION=@@GOAT_REQUESTED_VERSION@@
REQUIRE_INSTALLED=@@GOAT_REQUIRE_INSTALLED@@
PRESERVE_SELECTED_RUNNER=@@GOAT_PRESERVE_SELECTED_RUNNER@@
ALLOW_OWNED_UPGRADE=@@GOAT_ALLOW_OWNED_UPGRADE@@
ALLOW_LEGACY_ADOPTION=@@GOAT_ALLOW_LEGACY_ADOPTION@@
REFRESH_IF_IDLE=@@GOAT_REFRESH_IF_IDLE@@
REFRESH_LIVE_VERSION=@@GOAT_REFRESH_LIVE_VERSION@@
EXPECTED_LIVE_RUNNER_SHA256=@@GOAT_LIVE_RUNNER_SHA256@@
OWNING_LAUNCH=@@GOAT_OWNING_LAUNCH@@
DRAIN_FORCE=@@GOAT_DRAIN_FORCE@@
DRAIN_AUTOMATIC=@@GOAT_DRAIN_AUTOMATIC@@
DRAIN_GRACE_SECONDS=@@GOAT_DRAIN_GRACE_SECONDS@@
RUNNER_PUBLISHED=0; REFRESH_DECISION=; LEGACY_PENDING=0; LEGACY_COMMITTED=0
LEGACY_TERMINATED=0; LEGACY_IDENTITY_LINK=; LEGACY_PUBLICATION_STARTED=0
RETAINED_SNAPSHOT_FILE=; LEGACY_PID=; LEGACY_PORT=; LEGACY_IDENTITY=; LEGACY_VERSION=; LEGACY_UID=; LEGACY_START=
EXPECTED_RETAINED_SHA256=@@GOAT_RETAINED_RUNNER_SHA256@@
EXPECTED_INSTALLED_SHA256=@@GOAT_INSTALLED_EXECUTABLE_SHA256@@
@@GOAT_PROTOCOL_TOKENS@@
${REMOTE_RUNNER_HINT_SCRIPT}
check_retained_runner() {
  # Recovery pins the executable observed by the probe as well as the runner.
  if [ -n "$EXPECTED_INSTALLED_SHA256" ] &&
     [ "$(runner_sha256 "$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat")" != "$EXPECTED_INSTALLED_SHA256" ]; then
    printf 'Recorded GOAT executable changed since probe; reconnect.\\n' >&2; exit 1
  fi
  if [ "$RUNNER_PUBLISHED" = 0 ] && [ -n "$EXPECTED_LIVE_RUNNER_SHA256" ] &&
     [ "$(runner_sha256 "$RUNNER_FILE")" != "$EXPECTED_LIVE_RUNNER_SHA256" ]; then
    printf 'Running runner changed before publication; process was preserved.\\n' >&2; exit 1
  fi
  if [ "$PRESERVE_SELECTED_RUNNER" = 1 ]; then
    if [ -z "$EXPECTED_RETAINED_SHA256" ] || [ ! -f "$RUNNER_FILE" ] ||
       [ "$(runner_sha256 "$RUNNER_FILE")" != "$EXPECTED_RETAINED_SHA256" ]; then
      printf 'Selected retained GOAT runner bytes changed since probe; reconnect to prepare again.\\n' >&2; exit 1
    fi
  fi
}
mkdir -p "$STATE_DIR"
@@GOAT_REPLACEMENT_LOCK@@
cleanup_runner_next() {
  if [ "$LEGACY_COMMITTED" = 1 ] && [ "$LEGACY_TERMINATED" = 0 ]; then
    rollback_legacy_switch
  fi
  release_recovery_lock
  release_replacement_lock
  rm -f "$RUNNER_CANDIDATE_FILE" "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_CANDIDATE_FILE.restore"
  [ -z "$LEGACY_IDENTITY_LINK" ] || rm -f "$LEGACY_IDENTITY_LINK"
  [ -z "$RETAINED_SNAPSHOT_FILE" ] || rm -f "$RETAINED_SNAPSHOT_FILE"
}
trap 'runner_exit=$?; cleanup_runner_next; exit "$runner_exit"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
@@GOAT_CAPTURE_RUNNING_RUNNER@@
if [ "$REQUIRE_INSTALLED" = 1 ] && [ -n "$SELECTED_VERSION" ]; then
  selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
  if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
    printf 'Selected GOAT %s disappeared; reconnect to prepare again.\\n' "$SELECTED_VERSION" >&2; exit 1
  fi
fi
check_retained_runner
if [ "$PRESERVE_SELECTED_RUNNER" = 1 ]; then
  # Use copied retained bytes and verify the parsed selected version again.
  if [ ! -f "$RUNNER_FILE" ] ||
     [ "$(read_runner_hint "$RUNNER_FILE" GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY})" != "$SELECTED_VERSION" ] ||
     [ -n "$(read_runner_hint "$RUNNER_FILE" GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY})" ]; then
    printf 'Selected retained runner changed; reconnect to prepare again.\\n' >&2; exit 1
  fi
  cp "$RUNNER_FILE" "$RUNNER_NEXT"
else
  cat >"$RUNNER_NEXT" <<'SH'
@@GOAT_RUNNER_SCRIPT@@
SH
fi
chmod 700 "$RUNNER_NEXT"
# Verify copied bytes before executing or pinning, closing a same-version replacement race.
check_retained_runner
if [ "$PRESERVE_SELECTED_RUNNER" = 1 ] &&
   [ "$(runner_sha256 "$RUNNER_NEXT")" != "$EXPECTED_RETAINED_SHA256" ]; then
  printf 'Retained GOAT runner changed while copying; reconnect.\\n' >&2; exit 1
fi
cp "$RUNNER_NEXT" "$RUNNER_CANDIDATE_FILE.pin"
if ! RUNNER_VERSION_OUTPUT="$(exec_fact version "$RUNNER_NEXT" --version)"; then
  printf 'Cannot validate %s; existing runner and server were preserved.\\n' "$REQUESTED_RUNNER" >&2; exit 1
fi
if [ -n "$EXPECTED_ARCHIVE_VERSION" ] && [ "$RUNNER_VERSION_OUTPUT" != "goat v$EXPECTED_ARCHIVE_VERSION" ]; then
  printf 'Expected goat v%s, observed %s; existing runner and server were preserved.\\n' "$EXPECTED_ARCHIVE_VERSION" "$RUNNER_VERSION_OUTPUT" >&2; exit 1
fi
TARGET_VERSION="\${RUNNER_VERSION_OUTPUT#goat v}"
if [ -n "$SELECTED_VERSION" ]; then
  # Cold mirrors installed this exact archive during validation; pin future use too.
  selected_dir="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
  if [ ! -x "$selected_dir/goat" ] || [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" != "$SELECTED_VERSION" ]; then
    printf 'Validated selected archive is not complete.\\n' >&2; exit 1
  fi
  REQUIRE_INSTALLED=1
fi
RUNNER_CHANGED=0
@@GOAT_PROTOCOL_GUARD@@
check_candidate_protocol
check_live_protocol
if ! cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_NEXT"; then
  printf 'Candidate runner changed during validation; reconnect.\n' >&2; exit 1
fi
publish_selected_runner() {
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || {
    printf 'Replacement lock ownership changed; runner was preserved.\\n' >&2; exit 1;
  }
  check_retained_runner
@@GOAT_RUNNER_INSTALL@@
  RUNNER_PUBLISHED=1
}
pending_attachment_safe() {
  [ "$DRAIN_UNCERTAIN" = 0 ] || return 1
  # A replacement needs the mutex; lock-only contention can reuse a proven live server.
  { [ "$LOCK_HELD" = 1 ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ]; } ||
    { [ "$reason" = contended ] && [ "$NEEDS_OWNED_UPGRADE" = 0 ]; }
}
emit_pending_only() {
  printf '{"status":"pending","pending":{%s}}\n' "$pending_fields"
  exit 0
}
emit_pending() {
  reason="$1"; pending_detail="\${2:-}"
  [ -n "$pending_detail" ] || pending_detail="$LOCK_DETAIL"
  pending_fields="$(printf '"reason":"%s","replacement":"%s","requestedVersion":"%s","liveVersion":"%s"' "$reason" "$REPLACEMENT_REASON" "$REQUESTED_VERSION" "$LIVE_VERSION")"
  case "$pending_detail" in
    recovery-stale) pending_fields="$pending_fields,"'"detail":"recovery-stale"' ;;
    drain-unavailable) pending_fields="$pending_fields,"'"refreshCause":"drain_unavailable"' ;;
  esac
  # Reuse is independently proven using the retained runner, never the incompatible candidate.
  pending_attachment_safe || emit_pending_only
  if [ "$reason" = contended ] && [ "$NEEDS_OWNED_UPGRADE" = 0 ] && [ ! -f "$RETAINED_SNAPSHOT_FILE" ]; then
    capture_running_runner || emit_pending_only
  fi
@@GOAT_READY_BASELINE@@
  if [ "$LIVE_COMPATIBLE" = 1 ] && [ -f "$RETAINED_SNAPSHOT_FILE" ] &&
     [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] &&
     [ "$("$RETAINED_SNAPSHOT_FILE" --version 2>/dev/null || true)" = "goat v$LIVE_VERSION" ]; then
    retained_own="$("$RETAINED_SNAPSHOT_FILE" __ssh-helper protocol --shell 2>/dev/null || true)"
    set -f; set -- $retained_own
    if valid_own_tokens "$@" && compatible_fields "$1" "$2" "$3" && [ "$1" = "$LIVE_VERSION" ] &&
       "$RETAINED_SNAPSHOT_FILE" __ssh-helper wait-ready "$LIVE_PORT" "@@GOAT_REUSE_READY_TIMEOUT_MS@@" "@@GOAT_READY_PROBE_TIMEOUT_MS@@" >/dev/null 2>&1; then
      CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
      pending_pid="$LIVE_PID"; pending_port="$LIVE_PORT"; pending_version="$LIVE_VERSION"
      check_retained_runner
      check_live_protocol
      pending_attachment_safe || emit_pending_only
      if [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_PID" = "$pending_pid" ] && [ "$LIVE_PORT" = "$pending_port" ] && [ "$LIVE_VERSION" = "$pending_version" ] &&
         { [ "$pending_detail" != drain-unavailable ] || { [ "$LIVE_OWNED" = 1 ] && verify_owned_identity "$LIVE_PID" "$LIVE_PORT"; }; }; then
        pending_kind=external; [ "$LIVE_OWNED" != 1 ] || pending_kind=managed
        # Lock contention does not imply a replacement; compatible attach-only servers stay ready.
        pending_suffix=
        if [ "$reason" != contended ] || [ "$NEEDS_OWNED_UPGRADE" != 0 ]; then
          pending_suffix="$(printf ',"pending":{%s}' "$pending_fields")"
        fi
        printf '{"status":"ready","remotePort":%s,"serverKind":"%s","selectedVersion":"%s"%s}\n' "$LIVE_PORT" "$pending_kind" "$LIVE_VERSION" "$pending_suffix"
        exit 0
      fi
    fi
  fi
  emit_pending_only
}
if [ "$OWNING_LAUNCH" = 1 ]; then
  acquire_replacement_lock || { wait_for_replacement_lock && acquire_replacement_lock || emit_pending contended; }
  # Classification and ordering must be fresh under the host-wide mutex.
  CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
  check_live_protocol
  RECONCILING_DRAIN=0
  if [ "$DRAIN_UNCERTAIN" = 1 ]; then
    [ "$ALLOW_OWNED_UPGRADE" = 1 ] && [ "$LIVE_OWNED" = 1 ] && [ "$LIVE_DRAIN" = 1 ] && [ -n "$LIVE_INSTANCE_ID" ] || emit_pending unknown
    # Retry the authenticated request: the server joins an active drain, confirms its
    # cancellation, or exits for the supervisor. HTTP readiness alone proves none of these.
    RECONCILING_DRAIN=1; NEEDS_OWNED_UPGRADE=1
  fi
  if [ "$LIVE_COMPATIBLE" = 1 ] && [ "$LIVE_VERSION" = "$SELECTED_VERSION" ] &&
     [ "$LIVE_VERSION" = "$REQUESTED_VERSION" ] && [ -n "$REFRESH_LIVE_VERSION" ] &&
     [ "$REFRESH_LIVE_VERSION" != "$LIVE_VERSION" ]; then
    # Another owner completed this exact refresh while we waited; the old runner pin is obsolete.
    EXPECTED_LIVE_RUNNER_SHA256="$(runner_sha256 "$RUNNER_FILE")" || ownership_unverified
  fi
  if [ "$LIVE_COMPATIBLE" = 1 ] && [ "$comparison" = newer ] && [ "$LIVE_VERSION" != "$SELECTED_VERSION" ]; then
    # Another client may have completed a newer installation since preparation.
    # Pin its independently verified retained runner rather than publish our older candidate.
    selected_dir="$HOME/.goat/runtime/goat/versions/$LIVE_VERSION"
    [ -x "$selected_dir/goat" ] && [ "$(cat "$selected_dir/.install-complete" 2>/dev/null)" = "$LIVE_VERSION" ] || ownership_unverified
    fresh_sha="$(runner_sha256 "$RUNNER_FILE")" || ownership_unverified
    cp "$RUNNER_FILE" "$RUNNER_NEXT"
    [ "$(runner_sha256 "$RUNNER_NEXT")" = "$fresh_sha" ] && [ "$(runner_sha256 "$RUNNER_FILE")" = "$fresh_sha" ] || ownership_unverified
    [ "$("$RUNNER_NEXT" --version 2>/dev/null || true)" = "goat v$LIVE_VERSION" ] || ownership_unverified
    cp "$RUNNER_NEXT" "$RUNNER_CANDIDATE_FILE.pin"
    SELECTED_VERSION="$LIVE_VERSION"; REQUIRE_INSTALLED=1
    EXPECTED_LIVE_RUNNER_SHA256="$fresh_sha"
    [ "$PRESERVE_SELECTED_RUNNER" = 0 ] || EXPECTED_RETAINED_SHA256="$fresh_sha"
  fi
  check_candidate_protocol
  check_retained_runner
  check_live_protocol
  [ "$RECONCILING_DRAIN" != 1 ] || NEEDS_OWNED_UPGRADE=1
@@GOAT_VERIFY_OWNED_BEFORE_PUBLICATION@@
  [ "$DEFER_NO_DRAIN" != 1 ] || emit_pending unknown drain-unavailable
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] && [ "$RECONCILING_DRAIN" != 1 ] && [ "$REPLACEMENT_REASON" != incompatible ] && [ "$DRAIN_FORCE" != 1 ]; then
    # An optional refresh waits for idle; launch probes again last, then the server drains.
    activity="$(read_refresh_activity)"
    [ "$activity" = idle ] || emit_pending "$activity"
  fi
else
  # Pairing/MCP reuse is read-only; only initial shared setup may publish.
  if [ -f "$RUNNER_FILE" ] && [ "$LIVE_STATUS" != none ]; then
    if ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
      secondary_sha="$(runner_sha256 "$RUNNER_FILE")" || exit 1
      cp "$RUNNER_FILE" "$RUNNER_NEXT"
      [ "$(runner_sha256 "$RUNNER_NEXT")" = "$secondary_sha" ] && [ "$(runner_sha256 "$RUNNER_FILE")" = "$secondary_sha" ] || exit 1
      cp "$RUNNER_NEXT" "$RUNNER_CANDIDATE_FILE.pin"
      CHECK_RUNNER="$RUNNER_CANDIDATE_FILE.pin"
      check_candidate_protocol
      check_live_protocol
    fi
    RUNNER_PUBLISHED=1
  else
    acquire_replacement_lock || { printf 'Another client is replacing the remote runtime.\n' >&2; exit 1; }
    check_live_protocol
    publish_selected_runner
  fi
fi

`;

// Legacy adoption reads only a pinned retained runner; never evaluate shell source.
const REMOTE_LEGACY_IDENTITY_SCRIPT = String.raw`capture_running_runner() {
  RETAINED_SNAPSHOT_FILE="$STATE_DIR/run-t3.retained.$$"
  if [ -f "$RUNNER_FILE" ]; then
    running_sha="$(runner_sha256 "$RUNNER_FILE")" || return 1
    if [ -n "$EXPECTED_LIVE_RUNNER_SHA256" ] && [ "$running_sha" != "$EXPECTED_LIVE_RUNNER_SHA256" ]; then return 1; fi
    cp "$RUNNER_FILE" "$RETAINED_SNAPSHOT_FILE"
    [ "$(runner_sha256 "$RETAINED_SNAPSHOT_FILE")" = "$running_sha" ] &&
      [ "$(runner_sha256 "$RUNNER_FILE")" = "$running_sha" ] || return 1
    EXPECTED_LIVE_RUNNER_SHA256="$running_sha"
  fi
}
decode_named_retained_assignment() {
  awk -v key="$1" '
    $0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {
      count++
      if (index($0, key "=") != 1) bad=1
      value=substr($0,length(key)+2)
    }
    END {
      if (bad || count != 1 || length(value)<2 || substr(value,1,1)!="\047" || substr(value,length(value),1)!="\047") exit 1
      text=substr(value,2,length(value)-2); decoded=""
      for (i=1;i<=length(text);i++) {
        c=substr(text,i,1)
        if (c=="\047") {
          if (substr(text,i,4)!="\047\\\047\047") exit 1
          decoded=decoded "\047"; i+=3
        } else decoded=decoded c
      }
      print decoded
    }' "$RETAINED_SNAPSHOT_FILE"
}
decode_retained_assignment() {
  if awk -v key="$1" '$0 ~ "^[[:space:]]*(export[[:space:]]+)?" key "[[:space:]]*=" {found=1} END {exit !found}' "$RETAINED_SNAPSHOT_FILE"; then
    decode_named_retained_assignment "$1"
  else
    decode_named_retained_assignment "$2"
  fi
}
legacy_files_regular() {
  for legacy_file in "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$RUNNER_FILE"; do
    [ -f "$legacy_file" ] && [ ! -L "$legacy_file" ] || return 1
  done
}
read_legacy_value() {
  awk 'NR==1 { value=$0 } END { if (NR!=1) exit 1; print value }' "$1"
}
verify_legacy_process() {
  legacy_files_regular || return 1
  legacy_uid="$(server_uid "$1")" || return 1
  legacy_uid="$(printf '%s\n' "$legacy_uid" | awk 'NF==1 { print $1 }')"
  [ "$legacy_uid" = "$(id -u)" ] || return 1
  legacy_start="$(server_start "$1")" || return 1
  [ -n "$legacy_start" ] || return 1
  case "$legacy_start" in *[[:cntrl:]]*) return 1 ;; esac
  legacy_command="$(server_command "$1")" || return 1
  [ "$legacy_command" = "$2" ] || return 1
  if [ "$LEGACY_PENDING" = 1 ]; then
    [ "$legacy_uid" = "$LEGACY_UID" ] && [ "$legacy_start" = "$LEGACY_START" ] || return 1
  fi
  if [ "$RUNNER_PUBLISHED" = 1 ]; then
    cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_FILE" || return 1
  else
    [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  fi
  legacy_files_regular
}
verify_legacy_identity() {
  [ "$ALLOW_LEGACY_ADOPTION" = 1 ] && [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ] || return 1
  legacy_files_regular || return 1
  [ -f "$RETAINED_SNAPSHOT_FILE" ] && [ -n "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] &&
    [ "$(runner_sha256 "$RETAINED_SNAPSHOT_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  legacy_pid="$(read_legacy_value "$PID_FILE")" || return 1
  legacy_port="$(read_legacy_value "$PORT_FILE")" || return 1
  [ "$(read_legacy_value "$MANAGED_FILE")" = managed ] &&
    valid_positive "$legacy_pid" && valid_positive "$legacy_port" && valid_port "$legacy_port" &&
    server_alive "$legacy_pid" || return 1
  legacy_version="$(decode_retained_assignment GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY})" || return 1
  legacy_entry="$(decode_retained_assignment GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY})" || return 1
  [ -z "$legacy_entry" ] || return 1
  case "$legacy_version" in ''|*[!0-9A-Za-z.-]*) return 1 ;; esac
  valid_version "$legacy_version" || return 1
  legacy_tail="$HOME/.goat/runtime/goat/versions/$legacy_version/goat serve --host 127.0.0.1 --port $legacy_port --base-dir $DEFAULT_SERVER_HOME"
  verify_legacy_process "$legacy_pid" "$legacy_tail" || return 1
  if [ "$LEGACY_PENDING" = 1 ]; then
    [ "$LEGACY_PID" = "$legacy_pid" ] && [ "$LEGACY_PORT" = "$legacy_port" ] &&
      [ "$LEGACY_IDENTITY" = "$legacy_tail" ] || return 1
  fi
  [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$legacy_pid" ] &&
    [ "$(cat "$PORT_FILE" 2>/dev/null || true)" = "$legacy_port" ] &&
    [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] &&
    [ ! -e "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ] &&
    [ "$(runner_sha256 "$RUNNER_FILE")" = "$EXPECTED_LIVE_RUNNER_SHA256" ] || return 1
  LEGACY_PID="$legacy_pid"; LEGACY_PORT="$legacy_port"; LEGACY_IDENTITY="$legacy_tail"
  LEGACY_VERSION="$legacy_version"; LEGACY_UID="$legacy_uid"; LEGACY_START="$legacy_start"; LEGACY_PENDING=1
}
commit_legacy_identity() {
  verify_legacy_identity || return 1
  legacy_next="$STATE_DIR/identity.next.$$"
  printf '%s\n' "$LEGACY_IDENTITY" >"$legacy_next"
  verify_legacy_identity || { rm -f "$legacy_next"; return 1; }
  # Atomic create, refusing a competing identity instead of overwriting it.
  if ! ln "$legacy_next" "$STATE_DIR/identity" 2>/dev/null; then rm -f "$legacy_next"; return 1; fi
  if ! verify_owned_identity "$LEGACY_PID" "$LEGACY_PORT"; then
    if [ "$legacy_next" -ef "$STATE_DIR/identity" ]; then rm -f "$STATE_DIR/identity"; fi
    rm -f "$legacy_next"; return 1
  fi
  # Keep a hard link so rollback removes only the identity created by this attempt.
  LEGACY_IDENTITY_LINK="$legacy_next"
  LEGACY_COMMITTED=1
}
rollback_legacy_switch() {
  # A failed switch must remain retryable while the legacy process is still alive.
  # Never overwrite runner bytes or an identity replaced by another actor.
  if [ "$LEGACY_PUBLICATION_STARTED" = 1 ] && [ -f "$RETAINED_SNAPSHOT_FILE" ] &&
     [ ! -L "$RUNNER_FILE" ] && cmp -s "$RUNNER_CANDIDATE_FILE.pin" "$RUNNER_FILE"; then
    if cp -p "$RETAINED_SNAPSHOT_FILE" "$RUNNER_CANDIDATE_FILE.restore" &&
       mv -f "$RUNNER_CANDIDATE_FILE.restore" "$RUNNER_FILE"; then :
    else printf 'Could not restore the retained GOAT runner after a failed switch.\n' >&2; fi
  fi
  if [ -n "$LEGACY_IDENTITY_LINK" ] && [ "$LEGACY_IDENTITY_LINK" -ef "$STATE_DIR/identity" ] &&
     [ "$(cat "$STATE_DIR/identity" 2>/dev/null)" = "$LEGACY_IDENTITY" ]; then
    rm -f "$STATE_DIR/identity"
  fi
}
read_refresh_activity() {
  activity_runner="$RUNNER_CANDIDATE_FILE.pin"
  if activity="$("$activity_runner" __ssh-helper activity --port "$LIVE_PORT" --pid "$LIVE_PID" --shell 2>/dev/null)"; then
    case "$activity" in idle|busy) printf '%s' "$activity"; return ;; esac
  fi
  printf unknown
}

`;

// PID existence and protocol metadata are not authority to signal a process.
// Both termination paths must corroborate the complete invocation we launch.
const REMOTE_OWNED_IDENTITY_SCRIPT = `verify_owned_identity() {
  owned_pid="$1"; owned_port="$2"
  valid_positive "$owned_pid" && valid_positive "$owned_port" && valid_port "$owned_port" || return 1
  [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] || return 1
  [ -f "$STATE_DIR/identity" ] && [ ! -L "$STATE_DIR/identity" ] || return 1
  owned_uid="$(server_uid "$owned_pid")" || return 1
  [ "$(printf '%s\\n' "$owned_uid" | awk 'NF==1 { print $1 }')" = "$(id -u)" ] || return 1
  owned_identity="$(cat "$STATE_DIR/identity" 2>/dev/null)" || return 1
  [ -n "$owned_identity" ] || return 1
  case "$owned_identity" in
    *" --port $owned_port --base-dir $DEFAULT_SERVER_HOME") ;;
    *) return 1 ;;
  esac
  owned_command="$(server_command "$owned_pid")" || return 1
  case "$owned_identity" in
    "$HOME/.goat/runtime/goat/versions/"*)
      # An archive's identity includes its executable, so no prefix is allowed.
      [ "$owned_command" = "$owned_identity" ] || return 1 ;;
    *)
      # Node shims can exec a different binary; the persisted entry and arguments own it.
      case "$owned_command" in *" $owned_identity") ;; *) return 1 ;; esac ;;
  esac
  # Ownership and the running server's identity must still match after inspection.
  [ "$(cat "$PID_FILE" 2>/dev/null || true)" = "$owned_pid" ] &&
    [ "$(cat "$PORT_FILE" 2>/dev/null || true)" = "$owned_port" ] &&
    [ "$(cat "$MANAGED_FILE" 2>/dev/null || true)" = managed ] &&
    [ "$(cat "$STATE_DIR/identity" 2>/dev/null || true)" = "$owned_identity" ]
}
`;

const VERIFY_OWNED_BEFORE_PUBLICATION = `if [ "$LEGACY_PENDING" = 1 ]; then
  verify_legacy_identity || ownership_unverified
elif [ "$LIVE_OWNED" = 1 ] && ! verify_owned_identity "$LIVE_PID" "$LIVE_PORT"; then
  printf 'GOAT ownership could not be verified for PID %s: persisted launch identity is missing or mismatched; process, runner and ownership files were preserved.\\n' "$LIVE_PID" >&2
  exit 1
fi`;

// Use the existing post-install round trip: young executables remain unkeyed everywhere else.
const REMOTE_RUNTIME_FACT_WARMUP_SCRIPT = String.raw`warm_runtime_facts() (
  [ -n "$GOAT_FACTS_DIR" ] || exit 0
  # Skip an observed rollback window; concurrent changes are covered by each fact's keys.
  [ ! -e "$STATE_DIR/run-t3.previous" ] && [ ! -L "$STATE_DIR/run-t3.previous" ] || exit 1
  warm_exe="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  warm_sig="$(file_sig "$warm_exe")" || exit 1
  warm_age=$(( $(date +%s) - ${"${warm_sig##*:}"} ))
  # A clock behind ctime is not a reason to extend the cleanup's deadline.
  [ "$warm_age" -ge 0 ] || exit 1
  if [ "$warm_age" -lt 2 ]; then sleep "$(( 2 - warm_age ))" || exit 1; fi
  exec_fact_key "$warm_exe" || exit 1
  warm_exe_key="$FACT_KEY"; warm_exe_name="$FACT_NAME"
  # Independent answers run side by side, so warming costs about two goat starts on a host
  # whose cleanup already used most of the deadline.
  exec_fact version "$warm_exe" --version >/dev/null 2>&1 &
  exec_fact own "$warm_exe" __ssh-helper protocol --shell >/dev/null 2>&1 &
  build_commit_time "$warm_exe" >/dev/null 2>&1 &
  lacks_memory_scopes "$warm_exe" >/dev/null 2>&1 &
  if warm_live="$(live_fact "$warm_exe" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 2>/dev/null)"; then
    (
      set -f; set -- $warm_live
      valid_live_tokens "$@" && [ "$1" = live ] && [ "$2" = "$SELECTED_VERSION" ] &&
        [ "$6" = "$REMOTE_PORT" ] &&
        compat_fact "$warm_exe" "$6" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" "$5" >/dev/null 2>&1
    ) || true
  fi
  wait || true
  # exec_fact_key keys a runner only when it is an archive runner that execs this executable
  # with the same arguments, so its answers are the executable's under the runner's key.
  exec_fact_key "$RUNNER_FILE" || exit 0
  # The runner may have been republished for another version while this ran.
  [ "${"${FACT_KEY% *}"}" = "${"${warm_exe_key% *}"}" ] || exit 0
  warm_runner_key="$FACT_KEY"; warm_runner_name="$FACT_NAME"
  exec_fact_key "$warm_exe" && [ "$FACT_KEY" = "$warm_exe_key" ] || exit 0
  for warm_kind in version own commit scopes live compat; do
    warm_file="$GOAT_FACTS_DIR/$warm_kind.$warm_exe_name"
    [ -f "$warm_file" ] && [ ! -L "$warm_file" ] || continue
    { IFS= read -r warm_key && IFS= read -r warm_value; } <"$warm_file" || continue
    case "$warm_key" in "$warm_exe_key"*) ;; *) continue ;; esac
    fact_valid "$warm_kind" "$warm_value" || continue
    fact_put "$warm_kind.$warm_runner_name" "$warm_runner_key${'${warm_key#"$warm_exe_key"}'}" "$warm_value"
  done
)
warm_runtime_facts >/dev/null 2>&1 || exit 0
`;

// The caller holds the replacement mutex after readiness, outside any supervisor trial.
export const REMOTE_RUNTIME_CLEANUP_SCRIPT = String.raw`cleanup_runtime_versions() {
  [ "$GOAT_HOST_WINDOWS" = 0 ] && [ "$GOAT_ARCHIVE_MODE" = 1 ] || return 0
  [ "$LOCK_HELD" = 1 ] && [ -z "${"${UPGRADE_VERSION:-}"}" ] || return 0
  [ "$(readlink "$LOCK" 2>/dev/null)" = "$OWNER" ] || return 1
  # A detached supervisor can outlive the SSH shell that owned the replacement lock.
  [ ! -e "$STATE_DIR/run-t3.previous" ] && [ ! -L "$STATE_DIR/run-t3.previous" ] || return 1
  for parent in "$HOME" "$HOME/.goat" "$HOME/.goat/runtime" "$HOME/.goat/runtime/goat" "$HOME/.goat/runtime/goat/versions"; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  done
  versions="$HOME/.goat/runtime/goat/versions"
  [ -d /proc/self ] && command -v flock >/dev/null 2>&1 || return 1
  [ ! -L "$versions/.maintenance.lock" ] || return 1
  exec 9>"$versions/.maintenance.lock" || return 1
  flock -n -x 9 || return 1
  set +f
  # Older clients do not take the maintenance mutex; their install locks still veto cleanup.
  for install in "$versions"/.*.install.lock*; do
    [ ! -e "$install" ] && [ ! -L "$install" ] || return 1
  done
  retained="$(read_runner_hint "$RUNNER_FILE" GOAT_ARCHIVE_VERSION T3_ARCHIVE_VERSION)" || return 1
  valid_version "$retained" && valid_version "$SELECTED_VERSION" || return 1
  live_binary="$versions/$SELECTED_VERSION/goat"
  [ ! -L "$versions/$SELECTED_VERSION" ] && [ ! -L "$live_binary" ] || return 1
  # Revalidate the descriptor under both mutexes, after the readiness handshake.
  live="$("$live_binary" __ssh-helper protocol --runtime-file "$DEFAULT_RUNTIME_FILE" --port-file "$PORT_FILE" --pid-file "$PID_FILE" --shell)" || return 1
  set -f; set -- $live; set +f
  valid_live_tokens "$@" && [ "$1" = live ] && [ "$2" = "$SELECTED_VERSION" ] &&
    [ "$6" = "$REMOTE_PORT" ] || return 1
  cleanup_process_paths() {
    # Only this user's processes can run from this user's runtime directory, and /proc
    # hides other users' executable and cwd links from an unprivileged reader.
    uid="$(id -u)" || return 1
    commands="$(ps -o command= -U "$uid")" && pids="$(ps -o pid= -U "$uid")" || return 1
    [ -n "$commands" ] && [ -n "$pids" ] || return 1
    paths="$commands"
    # ps alone misses chdir and exec with a custom argv[0]. An unreadable live process vetoes
    # deletion; one that exited since ps listed it has nothing left to protect.
    for pid in $pids; do
      case "$pid" in *[!0-9]*|'') return 1 ;; esac
      if executable="$(readlink "/proc/$pid/exe")" && cwd="$(readlink "/proc/$pid/cwd")"; then
        paths="$paths
$executable
$cwd"
      elif [ -e "/proc/$pid" ]; then
        return 1
      fi
    done
  }
  cleanup_process_paths || return 1
  cleanup_commit() {
    binary="$versions/$1/goat"
    [ ! -L "$binary" ] && [ ! -L "$versions/$1/.install-record" ] || return 1
    record="$(cat "$versions/$1/.install-record" 2>/dev/null)" || return 1
    set -f; set -- $record; set +f
    [ "$#" = 4 ] && [ "$versions/$1/goat" = "$binary" ] || return 1
    [ "$(runner_sha256 "$binary")" = "$3" ] || return 1
    build_commit_time "$binary"
  }
  cleanup_order() {
    first="$1"; second="$2"; set --
    if first_time="$(cleanup_commit "$first")" && second_time="$(cleanup_commit "$second")"; then
      set -- --live-commit-time "$first_time" --requested-commit-time "$second_time"
    fi
    "$live_binary" __ssh-helper compare-version "$@" "$first" "$second" 2>/dev/null
  }
  older=
  for dir in "$versions"/*; do
    [ -d "$dir" ] && [ ! -L "$dir" ] || continue
    [ -x "$dir/goat" ] && [ ! -L "$dir/goat" ] || continue
    version="${"${dir##*/}"}"
    valid_version "$version" || continue
    [ ! -L "$dir/.install-complete" ] &&
      [ "$(cat "$dir/.install-complete" 2>/dev/null)" = "$version" ] || continue
    [ "$version" != "$SELECTED_VERSION" ] || continue
    [ "$(cleanup_order "$SELECTED_VERSION" "$version")" = newer ] || continue
    older="$older $version"
  done
  for version in $older; do
    [ "$version" != "$retained" ] && [ "$version" != "$REQUESTED_VERSION" ] || continue
    # Preserve every maximal older build when the rollback candidates cannot be totally ordered.
    removable=0
    for other in $older; do
      if [ "$(cleanup_order "$other" "$version")" = newer ]; then removable=1; break; fi
    done
    [ "$removable" = 1 ] || continue
    dir="$versions/$version"
    cleanup_process_paths || return 1
    case "$paths" in *"$dir/"*|*"$dir
"*|*"$dir") continue ;; esac
    [ ! -L "$dir" ] || return 1
    [ ! -e "$versions/.$version.install.lock" ] && [ ! -L "$versions/.$version.install.lock" ] || return 1
    trash="$(mktemp -d "$versions/.trash-XXXXXXXX")" || return 1
    # Moving into an owned empty sibling keeps a failed recursive delete out of runtime discovery.
    mv "$dir" "$trash/runtime" || return 1
    rm -rf "$trash" || return 1
    printf 'ssh.runtime.cleanup.removed version=%s\n' "$version" >&2
  done
}
(cleanup_runtime_versions) || { printf 'ssh.runtime.cleanup.skipped inspection, lock, or cleanup failed\n' >&2 || true; }
`;

// Retained archives have a port-only wait-ready helper. Inspect the kernel's socket owner
// in the launch shell instead, without adding helper arguments or starts on reconnect.
export const REMOTE_LAUNCH_LISTENER_SCRIPT = String.raw`# macOS login shells often omit /usr/sbin, which is where lsof lives, and archive
# launches never call ensure_remote_node_path. Resolve lsof without that PATH.
ensure_listener_path() {
  prepend_path_if_dir "/usr/sbin"
  prepend_path_if_dir "/sbin"
  export PATH
}
listener_lsof() {
  if command -v lsof >/dev/null 2>&1; then
    command -v lsof
    return 0
  fi
  for candidate in /usr/sbin/lsof /sbin/lsof; do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}
listener_probe_available() {
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then return 0; fi
  if [ -d /proc/self/fd ]; then return 0; fi
  listener_lsof >/dev/null 2>&1
}
server_owns_listener() (
  # Protocol parsing leaves noglob enabled; socket fd discovery needs expansion.
  set +f
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    GOAT_PROCESS_ID="$1" GOAT_LISTEN_PORT="$2" MSYS2_ARG_CONV_EXCL='*' powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand("$ErrorActionPreference = 'Stop'; $connections = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:GOAT_LISTEN_PORT) -ErrorAction Stop); if ($connections | Where-Object { $_.OwningProcess -eq [int]$env:GOAT_PROCESS_ID -and $_.LocalAddress -eq '127.0.0.1' }) { exit 0 }; exit 1")}' </dev/null >/dev/null 2>&1
  elif [ -d /proc/self/fd ]; then
    listen_sockets=' '
    for listen_fd in /proc/"$1"/fd/*; do
      listen_socket="$(readlink "$listen_fd" 2>/dev/null)" || continue
      case "$listen_socket" in socket:*) listen_sockets="$listen_sockets$listen_socket " ;; esac
    done
    listen_address="$(printf '0100007F:%04X' "$2")" || return 1
    awk -v address="$listen_address" -v sockets="$listen_sockets" '
      $2 == address && $4 == "0A" && index(sockets, " socket:[" $10 "] ") { found=1 }
      END { exit !found }
    ' /proc/"$1"/net/tcp 2>/dev/null
  else
    lsof_bin="$(listener_lsof)" || return 1
    "$lsof_bin" -nP -a -p "$1" -iTCP@127.0.0.1:"$2" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$1"
  fi
)
wait_launched_listener() {
  listen_deadline=$(( $(date +%s) + (@@GOAT_READY_TIMEOUT_MS@@ + 999) / 1000 ))
  while server_alive "$REMOTE_PID" && [ "$(date +%s)" -lt "$listen_deadline" ]; do
    server_owns_listener "$REMOTE_PID" "$REMOTE_PORT" && return 0
    sleep 0.1
  done
  return 1
}
`;

const REMOTE_LAUNCH_SCRIPT = `set -eu
@@GOAT_NODE_ENV_SCRIPT@@
STATE_KEY="$1"
STATE_DIR="$HOME/.goat/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="$HOME/.goat"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
ownership_unverified() {
  printf 'GOAT ownership could not be verified; process and ownership files were preserved.\\n' >&2; exit 1
}
@@GOAT_OWNED_IDENTITY@@
@@GOAT_LEGACY_IDENTITY@@
@@GOAT_RUNNER_SETUP@@
IDENTITY_NEXT="$STATE_DIR/identity.next.$$"
trap 'runner_exit=$?; cleanup_runner_next; rm -f "$IDENTITY_NEXT"; exit "$runner_exit"' EXIT
GOAT_ARCHIVE_MODE=@@GOAT_ARCHIVE_MODE@@
GOAT_NODE_SCRIPT_PATH=@@GOAT_NODE_SCRIPT_PATH@@
if [ "$GOAT_ARCHIVE_MODE" = 0 ]; then
  # Protocol token parsing disabled globbing; version-manager discovery needs it.
  case "$-" in *f*) NODE_RESTORE_NOGLOB=1 ;; *) NODE_RESTORE_NOGLOB=0 ;; esac
  set +f
  ensure_remote_node_path || true
  [ "$NODE_RESTORE_NOGLOB" = 0 ] || set -f
fi
recheck_selected_before_use
pick_port() {
  if [ "$GOAT_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE" "@@GOAT_DEFAULT_REMOTE_PORT@@" "@@GOAT_REMOTE_PORT_SCAN_WINDOW@@"
    return
  fi
  node - "$PORT_FILE" "@@GOAT_DEFAULT_REMOTE_PORT@@" "@@GOAT_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@GOAT_PICK_PORT_SCRIPT@@
NODE
}
wait_ready() {
  if [ "$GOAT_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@GOAT_READY_PROBE_TIMEOUT_MS@@"
    return
  fi
  node - "$REMOTE_PORT" "$1" "@@GOAT_READY_PROBE_TIMEOUT_MS@@" <<'NODE'
@@GOAT_WAIT_READY_SCRIPT@@
NODE
}
${REMOTE_LAUNCH_LISTENER_SCRIPT}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_COUNT=0
  while server_alive "$PID_TO_WAIT" && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
reuse_live_server() {
    REMOTE_PORT="$LIVE_PORT"
    if ! wait_ready "@@GOAT_READY_TIMEOUT_MS@@"; then
      printf 'Selected live server did not answer; it was left running.\\n' >&2; exit 1
    fi
    recheck_selected_before_use
    if [ "$LIVE_COMPATIBLE" != 1 ]; then
      printf 'Live server compatibility changed during readiness; reconnect.\\n' >&2; exit 1
    fi
    if [ "$LIVE_OWNED" = 1 ]; then
      REMOTE_PID="$LIVE_PID"
      REMOTE_MANAGED=managed
    else
      REMOTE_MANAGED=external
      rm -f "$PID_FILE" "$STATE_DIR/identity"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    fi
}
recheck_selected_before_use
[ "\${RECONCILING_DRAIN:-0}" != 1 ] || NEEDS_OWNED_UPGRADE=1
[ "$DEFER_NO_DRAIN" != 1 ] || emit_pending unknown drain-unavailable
REMOTE_PID=""
REMOTE_PORT=""
REMOTE_MANAGED=""
# Refuse before drain or a fresh start. Stopping the server and then failing
# this check would leave the host with nothing to attach to.
ensure_listener_path
if ! listener_probe_available; then
  if [ "$NEEDS_OWNED_UPGRADE" = 1 ] || [ "$LIVE_STATUS" = live ]; then
    printf 'Cannot verify the launched GOAT listener: this host needs /proc or lsof. The existing server was left running.\\n' >&2
  else
    printf 'Cannot verify the launched GOAT listener: this host needs /proc or lsof.\\n' >&2
  fi
  exit 1
fi
if [ "$NEEDS_OWNED_UPGRADE" = 1 ]; then
  UPGRADE_PID="$LIVE_PID"; UPGRADE_PORT="$LIVE_PORT"; UPGRADE_VERSION="$LIVE_VERSION"
  UPGRADE_INSTANCE="$LIVE_INSTANCE_ID"
  if [ "$GOAT_HOST_WINDOWS" = 1 ] &&
     { [ "$GOAT_ARCHIVE_MODE" != 1 ] || [ ! -x "$HOME/.goat/runtime/goat/versions/$UPGRADE_VERSION/goat" ]; }; then
    # The Windows supervisor restarts installed release executables only.
    printf 'Live GOAT PID=%s port=%s can only be replaced by a GOAT release on this Windows host; it was left running. Stop it when its work is done, then reconnect.\\n' "$UPGRADE_PID" "$UPGRADE_PORT" >&2; exit 1
  fi
  # Validate bytes and authority before the final PID-validated idle probe.
  check_candidate_protocol
  check_retained_runner
  if [ "$LEGACY_PENDING" = 1 ] && [ "$LEGACY_COMMITTED" = 0 ]; then
    verify_legacy_identity || ownership_unverified
  else verify_owned_identity "$LIVE_PID" "$LIVE_PORT" || ownership_unverified; fi
  UPGRADE_START="$(server_start "$UPGRADE_PID")" || ownership_unverified
  [ -n "$UPGRADE_START" ] || ownership_unverified
  if [ "$RECONCILING_DRAIN" != 1 ] && [ "$REPLACEMENT_REASON" != incompatible ] && [ "$DRAIN_FORCE" != 1 ]; then
    # An optional refresh drains only an idle server, so its retries never hold up new turns.
    activity="$(read_refresh_activity)"
    [ "$activity" = idle ] || emit_pending "$activity"
  fi
  if [ "$LEGACY_PENDING" = 1 ] && [ "$LEGACY_COMMITTED" = 0 ]; then
    commit_legacy_identity || ownership_unverified
  fi
  verify_owned_identity "$UPGRADE_PID" "$UPGRADE_PORT" || ownership_unverified
  if [ "$LEGACY_PENDING" = 1 ]; then
    verify_legacy_process "$UPGRADE_PID" "$LEGACY_IDENTITY" || ownership_unverified
  fi
  [ "$(server_start "$UPGRADE_PID")" = "$UPGRADE_START" ] || ownership_unverified
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || ownership_unverified
  PREVIOUS_IDENTITY="$(cat "$STATE_DIR/identity")" || ownership_unverified
  PREVIOUS_RUNNER="$STATE_DIR/run-t3.previous"
  if [ -f "$RETAINED_SNAPSHOT_FILE" ]; then cp -p "$RETAINED_SNAPSHOT_FILE" "$PREVIOUS_RUNNER"
  else cp -p "$RUNNER_FILE" "$PREVIOUS_RUNNER"; fi
  # The server, not this script, stops itself: it refuses new turns, lets running work
  # finish within the grace window, and exits. Unconfirmed, an expired window cancels.
  drain_force=
  [ "$DRAIN_FORCE" != 1 ] || drain_force=--force
  # A lost response or a dead SSH owner cannot prove the server stopped draining.
  printf '%s\\n' "$UPGRADE_INSTANCE" > "$STATE_DIR/draining.next.$$"
  mv "$STATE_DIR/draining.next.$$" "$STATE_DIR/draining"
  # Only an automatic refresh of an older runtime is a request the runtime may arbitrate. A
  # reconciliation retry keeps the marker: the runtime joins a drain that is still active and
  # arbitrates only a request that would start a new one.
  drain_automatic=0
  if [ "$DRAIN_AUTOMATIC" = 1 ] && [ "$REPLACEMENT_REASON" = older ]; then drain_automatic=1; fi
  drain_result="$(GOAT_RUNTIME_DRAIN_AUTOMATIC="$drain_automatic" "$RUNNER_CANDIDATE_FILE.pin" __ssh-helper drain --port "$UPGRADE_PORT" --instance-id "$UPGRADE_INSTANCE" --target-version "$TARGET_VERSION" --grace-seconds "$DRAIN_GRACE_SECONDS" $drain_force --token-file "$DEFAULT_SERVER_HOME/userdata/runtime-control.token" 2>/dev/null || true)"
  case "$drain_result" in
    drained) ;;
    cancelled) rm -f "$STATE_DIR/draining" "$PREVIOUS_RUNNER"; DRAIN_UNCERTAIN=0; emit_pending busy ;;
    *) DRAIN_UNCERTAIN=1; rm -f "$PREVIOUS_RUNNER"; emit_pending unknown ;;
  esac
  LEGACY_TERMINATED=1
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
  publish_selected_runner
  if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then
    SPAWN_IDENTITY="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  else
    SPAWN_IDENTITY="$GOAT_NODE_SCRIPT_PATH"
  fi
  SUPERVISE_RESULT="$STATE_DIR/replacement.result.$$"
  rm -f "$SUPERVISE_RESULT"
  # Detached, so a dropped SSH session cannot leave the host without a server.
  trap '' HUP
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    # Windows OpenSSH ends every process left in the session, so the supervisor also starts
    # outside it and this script waits on its PID. Paths are native; identities stay POSIX.
    # cmd.exe cannot append to a log another cmd.exe holds, so the supervisor writes its own.
    SUPERVISE_LOG="$STATE_DIR/supervisor.log"
    SUPERVISE_PID="$(windows_spawn_detached "$SUPERVISE_LOG" "$(cygpath -w "$SPAWN_IDENTITY")" __ssh-helper supervise --old-pid "$UPGRADE_PID" --old-instance-id "$UPGRADE_INSTANCE" --port "$UPGRADE_PORT" --base-dir "$(cygpath -w "$DEFAULT_SERVER_HOME")" --state-dir "$(cygpath -w "$STATE_DIR")" --runner "$(cygpath -w "$RUNNER_FILE")" --previous-runner "$(cygpath -w "$PREVIOUS_RUNNER")" --executable "$(cygpath -w "$SPAWN_IDENTITY")" --previous-executable "$(cygpath -w "$HOME/.goat/runtime/goat/versions/$UPGRADE_VERSION/goat")" --target-version "$TARGET_VERSION" --previous-version "$UPGRADE_VERSION" --identity "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $UPGRADE_PORT --base-dir $DEFAULT_SERVER_HOME" --previous-identity "$PREVIOUS_IDENTITY" --ready-timeout-ms "@@GOAT_READY_TIMEOUT_MS@@" --log "$(cygpath -w "$LOG_FILE")" --result "$(cygpath -w "$SUPERVISE_RESULT")")" || SUPERVISE_PID=
    if valid_positive "$SUPERVISE_PID"; then
      while server_alive "$SUPERVISE_PID"; do sleep 1; done
    fi
    # A running replacement may hold server.log; then the supervisor log is kept beside it.
    if cat "$SUPERVISE_LOG" >>"$LOG_FILE" 2>/dev/null; then rm -f "$SUPERVISE_LOG"; fi
  else
    nohup "$RUNNER_FILE" __ssh-helper supervise --old-pid "$UPGRADE_PID" --old-instance-id "$UPGRADE_INSTANCE" --port "$UPGRADE_PORT" --base-dir "$DEFAULT_SERVER_HOME" --state-dir "$STATE_DIR" --runner "$RUNNER_FILE" --previous-runner "$PREVIOUS_RUNNER" --target-version "$TARGET_VERSION" --previous-version "$UPGRADE_VERSION" --identity "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $UPGRADE_PORT --base-dir $DEFAULT_SERVER_HOME" --previous-identity "$PREVIOUS_IDENTITY" --ready-timeout-ms "@@GOAT_READY_TIMEOUT_MS@@" --log "$LOG_FILE" --result "$SUPERVISE_RESULT" >/dev/null 2>>"$LOG_FILE" </dev/null &
    wait "$!" || true
  fi
  supervise_status=failed; supervise_pid=0; supervise_version=
  if [ -f "$SUPERVISE_RESULT" ]; then read -r supervise_status supervise_pid supervise_version <"$SUPERVISE_RESULT" || true; fi
  rm -f "$SUPERVISE_RESULT"
  case "$supervise_status" in
    replaced)
      REMOTE_PID="$supervise_pid"; REMOTE_PORT="$UPGRADE_PORT"; REMOTE_MANAGED=managed
      REFRESH_DECISION=replaced ;;
    rolled-back)
      if [ "$LIVE_COMPATIBLE" != 1 ]; then
        # The restored server is a new instance, so the fence for the drained one is done.
        rm -f "$STATE_DIR/draining"
        printf 'GOAT %s did not start on the remote host; GOAT %s was restored and is running, but this app cannot attach to it. See %s.\n' "$TARGET_VERSION" "$supervise_version" "$LOG_FILE" >&2; exit 1
      fi
      printf 'GOAT %s did not start on the remote host; GOAT %s was restored.\n' "$TARGET_VERSION" "$supervise_version" >&2
      REMOTE_PID="$supervise_pid"; REMOTE_PORT="$UPGRADE_PORT"; REMOTE_MANAGED=managed
      SELECTED_VERSION="$supervise_version" ;;
    old-alive)
      printf 'The drained GOAT %s server on the remote host did not exit, so it was left running and not replaced. Reconnect after it stops; see %s.\\n' "$UPGRADE_VERSION" "$LOG_FILE" >&2; exit 1 ;;
    *)
      printf 'Remote runtime replacement failed; see %s.\n' "$LOG_FILE" >&2; exit 1 ;;
  esac
  rm -f "$STATE_DIR/draining"
elif [ "$LIVE_STATUS" = live ]; then
  if [ "$LIVE_COMPATIBLE" != 1 ]; then
    printf 'Live GOAT compatibility changed; reconnect.\n' >&2; exit 1
  fi
  # A compatible live selection may be newer; preparation must pin that version.
  if [ -n "$SELECTED_VERSION" ] && [ "$LIVE_VERSION" != "$SELECTED_VERSION" ]; then
    printf 'Live GOAT version changed before reuse; reconnect without replacing it.\n' >&2; exit 1
  fi
  publish_selected_runner
  reuse_live_server
else
  if [ "@@GOAT_REQUIRE_FRESH_HOST@@" = 1 ]; then
    for fresh_db in "$DEFAULT_SERVER_HOME/userdata/statev2.sqlite" "$DEFAULT_SERVER_HOME/userdata/state.sqlite"; do
      if [ -e "$fresh_db" ] || [ -L "$fresh_db" ]; then
        printf 'GOAT data appeared on this host while it was being set up; reconnect.\\n' >&2; exit 1
      fi
    done
  fi
  publish_selected_runner
fi
# A runtime older than this host's database exits before ready on every start. The marker
# names that runtime, so later launches report it without starting it again, until another
# runtime is selected or a newer server writes the database.
DATABASE_AHEAD_FILE="$STATE_DIR/database-ahead"
database_ahead_exit() {
  printf 'GOAT %s on this host cannot open its data because a newer GOAT build already upgraded it. Update this app or the GOAT runtime on this host, then reconnect.\\n' "$SELECTED_VERSION" >&2
  exit 1
}
database_ahead_marked() {
  [ -f "$DATABASE_AHEAD_FILE" ] && [ "$(cat "$DATABASE_AHEAD_FILE" 2>/dev/null || true)" = "$SELECTED_VERSION" ] || return 1
  [ -z "$(find "$DEFAULT_SERVER_HOME/userdata" -maxdepth 1 -name 'statev2.sqlite*' -newer "$DATABASE_AHEAD_FILE" 2>/dev/null || true)" ]
}
LAUNCH_ATTEMPTS=0
while [ -z "$REMOTE_PORT" ]; do
  LAUNCH_ATTEMPTS=$((LAUNCH_ATTEMPTS + 1))
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    if [ "$GOAT_ARCHIVE_MODE" = "1" ]; then
      printf 'Failed to find an available port on the remote host.\\n' >&2
    else
      printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    fi
    exit 1
  fi
  recheck_selected_before_use
  if [ "$LIVE_STATUS" != none ]; then
    printf 'A server appeared before launch; reconnect without replacing it.\\n' >&2; exit 1
  fi
  if database_ahead_marked; then database_ahead_exit; fi
  if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then
    GOAT_RUNTIME_DIR="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION"
    SPAWN_IDENTITY="$GOAT_RUNTIME_DIR/goat"
  else
    SPAWN_IDENTITY="$GOAT_NODE_SCRIPT_PATH"
  fi
  touch "$LOG_FILE"
  LAUNCH_LOG_OFFSET="$(wc -c <"$LOG_FILE")"
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    # Windows OpenSSH ends every process left in the session, so the server starts outside it.
    if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then set -- "$(cygpath -w "$SPAWN_IDENTITY")"
    else set -- "$(cygpath -w "$(command -v node)")" "$(cygpath -w "$SPAWN_IDENTITY")"; fi
    REMOTE_PID="$(windows_spawn_detached "$LOG_FILE" "$@" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$(cygpath -w "$DEFAULT_SERVER_HOME")")" || REMOTE_PID=
    if ! valid_positive "$REMOTE_PID"; then
      printf 'Could not start the GOAT server outside the SSH session on this Windows host.\\n' >&2
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
      exit 1
    fi
  else
    nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
    REMOTE_PID="$!"
  fi
  printf '%s\\n' "$SPAWN_IDENTITY serve --host 127.0.0.1 --port $REMOTE_PORT --base-dir $DEFAULT_SERVER_HOME" >"$IDENTITY_NEXT"
  mv "$IDENTITY_NEXT" "$STATE_DIR/identity"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  if ! wait_launched_listener || ! wait_ready "@@GOAT_READY_TIMEOUT_MS@@" ||
     ! server_owns_listener "$REMOTE_PID" "$REMOTE_PORT"; then
    # Only this attempt's exited child and bind error authorize another port selection.
    # Never signal the listener that won the race between pick-port and serve.
    if ! server_alive "$REMOTE_PID" &&
       tail -c "+$((LAUNCH_LOG_OFFSET + 1))" "$LOG_FILE" | grep -q EADDRINUSE; then
      wait "$REMOTE_PID" 2>/dev/null || true
      rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
      if [ "$LAUNCH_ATTEMPTS" -lt @@GOAT_LAUNCH_ATTEMPTS@@ ]; then
        printf 'Remote GOAT port %s was taken during launch; retrying.\\n' "$REMOTE_PORT" >&2
        REMOTE_PORT=
        continue
      fi
    fi
    database_ahead=0
    if ! server_alive "$REMOTE_PID"; then
      launch_exit=0
      if [ "$GOAT_HOST_WINDOWS" = 0 ]; then wait "$REMOTE_PID" 2>/dev/null || launch_exit=$?; fi
      # Windows launches and runtimes that predate the exit code only leave these errors in the log.
      if [ "$launch_exit" = ${SERVER_EXIT_CODE_DATABASE_AHEAD} ] ||
         tail -c "+$((LAUNCH_LOG_OFFSET + 1))" "$LOG_FILE" 2>/dev/null |
           grep -q -e 'upgraded by a newer GOAT build' -e 'Cannot move GOAT migrations onto ids another migration recorded' -e 'would skip required schema migrations'; then
        database_ahead=1
      fi
    fi
    printf 'Remote GOAT server did not become ready with its own listener on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    if [ -s "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    else
      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' "$LOG_FILE" >&2
    fi
    if server_alive "$REMOTE_PID"; then server_kill "$REMOTE_PID" || true; fi
    wait_for_pid_exit "$REMOTE_PID"
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
    if [ "$database_ahead" = 1 ]; then
      printf '%s\\n' "$SELECTED_VERSION" >"$DATABASE_AHEAD_FILE.next.$$"
      mv "$DATABASE_AHEAD_FILE.next.$$" "$DATABASE_AHEAD_FILE"
      database_ahead_exit
    fi
    exit 1
  fi
  rm -f "$DATABASE_AHEAD_FILE"
  # A held published fallback becomes an ordinary runtime only once its own server is ready
  # and owns the port, so it serves this host's data.
  if [ "@@GOAT_REQUIRE_FRESH_HOST@@" = 1 ]; then rm -f "$HOME/.goat/runtime/goat/held/$SELECTED_VERSION"; fi
done
refresh_fields=
[ "$REFRESH_DECISION" != replaced ] || refresh_fields=',"refresh":"replaced"'
if [ "$OWNING_LAUNCH" = 1 ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" != "$OWNER" ]; then
  printf 'Replacement lock ownership changed before attachment.\\n' >&2; exit 1
fi
@@GOAT_READY_BASELINE@@printf '{"status":"ready","remotePort":%s,"serverKind":"%s","selectedVersion":"%s"%s}\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}" "$SELECTED_VERSION" "$refresh_fields"

`;

const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@GOAT_RUNNER_SETUP@@
PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
recheck_selected_before_use
"$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json
`;

const REPLACE_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ] && cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  rm -f "$RUNNER_NEXT"
else
  mv "$RUNNER_NEXT" "$RUNNER_FILE"
  RUNNER_CHANGED=1
fi`;
const KEEP_EXISTING_RUNNER_INSTALL = `if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  printf 'Selected retained runner changed before publication; reconnect.\\n' >&2; exit 1
fi
rm -f "$RUNNER_NEXT"`;

// Issues an `mcp-client` bearer session, the only kind the remote's `/mcp`
// admits from outside a thread. `--runtime-mode-ceiling` is newer than some
// remotes, so an older CLI is retried without it and reports the default.
// Memory grants are explicit consent, so they are never dropped: a CLI that cannot issue
// them refuses with a GOAT_SESSION_ERROR line, and every CLI that can also applies a ceiling.
const REMOTE_MCP_SESSION_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@GOAT_RUNNER_SETUP@@
set -- auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject mcp-client --scope orchestration:read --scope orchestration:operate @@GOAT_EXTRA_SCOPES@@--ttl @@GOAT_TTL@@ --label @@GOAT_LABEL@@ --json
CEILING=@@GOAT_CEILING@@
MEMORY_SCOPES=@@GOAT_MEMORY_SCOPES@@
recheck_selected_before_use
if [ "$MEMORY_SCOPES" = required ]; then
  if lacks_memory_scopes "$RUNNER_FILE"; then
    runtime="$("$RUNNER_FILE" --version 2>/dev/null || true)"; runtime="\${runtime#goat v}"
    printf 'GOAT_SESSION_ERROR=memory_scopes_unsupported runtime=%s\\n' "\${runtime:-unknown}"
    printf 'GOAT %s on this host cannot grant memory access to tasks.\\n' "\${runtime:-unknown}" >&2
    exit 1
  fi
  CEILING_RESULT=default
  if [ -n "$CEILING" ]; then set -- "$@" --runtime-mode-ceiling "$CEILING"; CEILING_RESULT=applied; fi
  OUTPUT="$("$RUNNER_FILE" "$@")"
  printf 'GOAT_CEILING=%s\\n%s\\n' "$CEILING_RESULT" "$OUTPUT"
elif [ -n "$CEILING" ] && OUTPUT="$("$RUNNER_FILE" "$@" --runtime-mode-ceiling "$CEILING" 2>/dev/null)"; then
  printf 'GOAT_CEILING=applied\\n%s\\n' "$OUTPUT"
else
  recheck_selected_before_use
  OUTPUT="$("$RUNNER_FILE" "$@")"
  printf 'GOAT_CEILING=default\\n%s\\n' "$OUTPUT"
fi
`;

const REMOTE_CLIENT_SESSION_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
DEFAULT_SERVER_HOME="$HOME/.goat"
@@GOAT_RUNNER_SETUP@@
recheck_selected_before_use
"$RUNNER_FILE" auth session issue --base-dir "$DEFAULT_SERVER_HOME" --subject @@GOAT_SUBJECT@@ @@GOAT_SCOPES@@ --ttl @@GOAT_TTL@@ --label @@GOAT_LABEL@@ --json
`;

const REMOTE_STOP_SCRIPT = `set -eu
DEFAULT_SERVER_HOME="$HOME/.goat"
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
PID_FILE="$STATE_DIR/pid"
PORT_FILE="$STATE_DIR/port"
MANAGED_FILE="$STATE_DIR/managed"
mkdir -p "$STATE_DIR"
@@GOAT_PROTOCOL_TOKENS@@
@@GOAT_REPLACEMENT_LOCK@@
trap 'release_recovery_lock; release_replacement_lock' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
acquire_replacement_lock || { printf 'Another client is replacing the remote runtime.\\n' >&2; exit 1; }
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
# Forget may stop only an owned runtime; external/unknown state belongs to another owner.
if [ @@GOAT_STOP_OWNED_ONLY@@ = 1 ] && [ "$REMOTE_MANAGED" != managed ]; then
  printf '{"stopped":false,"activity":"unknown"}\\n'
  exit 0
fi
ownership_unverified() {
  printf 'GOAT ownership could not be verified for PID %s; process and ownership files were preserved.\\n' "$REMOTE_PID" >&2
  exit 1
}
@@GOAT_OWNED_IDENTITY@@
if [ "$REMOTE_MANAGED" = managed ] && [ -n "$REMOTE_PID" ]; then
  valid_positive "$REMOTE_PID" || ownership_unverified
  if server_alive "$REMOTE_PID"; then
    verify_owned_identity "$REMOTE_PID" "$REMOTE_PORT" || ownership_unverified
    # Other clients share this server, and its threads outlive any one tunnel:
    # stopping is only safe when the server itself reports no active work.
    STOP_ACTIVITY=unknown
    if [ -x "$STATE_DIR/run-t3.sh" ]; then
      STOP_ACTIVITY="$("$STATE_DIR/run-t3.sh" __ssh-helper activity --port "$REMOTE_PORT" --pid "$REMOTE_PID" --shell 2>/dev/null || true)"
    fi
    if [ "$STOP_ACTIVITY" != idle ]; then
      case "$STOP_ACTIVITY" in busy) ;; *) STOP_ACTIVITY=unknown ;; esac
      printf '{"stopped":false,"activity":"%s"}\\n' "$STOP_ACTIVITY"
      exit 0
    fi
    verify_owned_identity "$REMOTE_PID" "$REMOTE_PORT" || ownership_unverified
    server_kill "$REMOTE_PID" || true
    STOP_WAIT_ATTEMPTS=@@GOAT_STOP_WAIT_ATTEMPTS@@
    STOP_WAIT_INTERVAL=@@GOAT_STOP_WAIT_INTERVAL@@
    WAIT_COUNT=0
    while server_alive "$REMOTE_PID" && [ "$WAIT_COUNT" -lt "$STOP_WAIT_ATTEMPTS" ]; do
      WAIT_COUNT=$((WAIT_COUNT + 1))
      sleep "$STOP_WAIT_INTERVAL"
    done
    if server_alive "$REMOTE_PID"; then
      printf 'Remote GOAT server with PID %s did not stop within @@GOAT_STOP_WAIT_LABEL@@. Its ownership files were kept.\\n' "$REMOTE_PID" >&2
      exit 1
    fi
  fi
elif [ "$REMOTE_MANAGED" != external ] && [ -n "$REMOTE_PID" ]; then
  valid_positive "$REMOTE_PID" || ownership_unverified
  if server_alive "$REMOTE_PID"; then ownership_unverified; fi
fi
rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
printf '{"stopped":true}\\n'
`;

const REMOTE_LOG_TAIL_SCRIPT = `set -eu
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
LOG_FILE="$STATE_DIR/server.log"
if [ -f "$LOG_FILE" ]; then
  tail -n 80 "$LOG_FILE" 2>/dev/null || true
fi
`;

export class SshInvalidArchiveVersionError extends Schema.TaggedError<SshInvalidArchiveVersionError>()(
  "SshInvalidArchiveVersionError",
  { archiveVersion: Schema.String },
) {
  override get message(): string {
    return `'${this.archiveVersion}' is not an exact GOAT version and cannot name a runtime directory.`;
  }
}

// The version becomes a directory name the runner removes and recreates, so
// it must be one exact SemVer segment: no separators, no `..`, no shell
// metacharacters beyond what SemVer allows.
const EXACT_ARCHIVE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class SshMissingRunnerError extends Schema.TaggedError<SshMissingRunnerError>()(
  "SshMissingRunnerError",
  {},
) {
  override get message(): string {
    return "A remote goat runner needs an archive version or a node script path.";
  }
}

export function buildRemoteGoatRunnerScript(input?: RemoteGoatRunnerOptions): string {
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  const archiveVersion = input?.archiveVersion?.trim() || "";
  if (nodeScriptPath === "" && archiveVersion === "") {
    throw new SshMissingRunnerError();
  }
  if (archiveVersion !== "" && !EXACT_ARCHIVE_VERSION.test(archiveVersion)) {
    throw new SshInvalidArchiveVersionError({ archiveVersion });
  }
  const releaseBaseUrl = cliReleaseDownloadBaseUrl("", input?.releaseBaseUrl ?? undefined).replace(
    /\/v$/u,
    "",
  );
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      GOAT_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      GOAT_ARCHIVE_VERSION: shellSingleQuote(archiveVersion),
      GOAT_RELEASE_BASE_URL: shellSingleQuote(releaseBaseUrl),
      GOAT_DOWNLOAD_SOURCE: input?.releaseBaseUrl?.trim() ? "mirror" : "https",
      GOAT_ARCHIVE_LOCK_WAIT_SECONDS: String(REMOTE_ARCHIVE_LOCK_WAIT_SECONDS),
      GOAT_ARCHIVE_DOWNLOAD_SECONDS: String(REMOTE_ARCHIVE_DOWNLOAD_SECONDS),
      GOAT_ARCHIVE_CHECKSUMS_SECONDS: String(REMOTE_ARCHIVE_CHECKSUMS_SECONDS),
      GOAT_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    }),
  );
}

export function buildRemoteNodeEnvScript(input?: RemoteGoatRunnerOptions): string {
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_NODE_ENV_SCRIPT, {
      GOAT_NODE_ENGINE_RANGE: shellSingleQuote(input?.nodeEngineRange?.trim() || ""),
      GOAT_NODE_ENGINE_CHECK_SCRIPT: REMOTE_NODE_ENGINE_CHECK_SCRIPT,
    }),
  );
}

function buildRemoteRunnerSetupScript(
  input: RemoteGoatRunnerOptions | undefined,
  selection: PreparedRemoteRuntime,
  verifyOwnedBeforePublication = false,
  reconnect = false,
  captureBaseline = false,
): string {
  const preserve = selection.source === "retained";
  return applyScriptPlaceholders(REMOTE_RUNNER_SETUP_SCRIPT, {
    GOAT_OWNING_LAUNCH: verifyOwnedBeforePublication ? "1" : "0",
    GOAT_DRAIN_FORCE: input?.confirmReplacement === true ? "1" : "0",
    GOAT_DRAIN_AUTOMATIC:
      input?.confirmReplacement !== true && input?.manualRefresh !== true ? "1" : "0",
    GOAT_DRAIN_GRACE_SECONDS: String(
      Math.min(
        Math.max(
          0,
          Math.trunc(input?.replacementGraceSeconds ?? RUNTIME_DRAIN_DEFAULT_GRACE_SECONDS),
        ),
        RUNTIME_DRAIN_MAX_GRACE_SECONDS,
      ),
    ),
    GOAT_REPLACEMENT_LOCK:
      REMOTE_REPLACEMENT_LOCK_SCRIPT +
      (reconnect
        ? `
# The outer folded command holds this exact owner link across probe and attachment.
OWNER="\${2:-}"
acquire_replacement_lock() {
  [ -n "$OWNER" ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || return 1
  LOCK_HELD=1
}
release_replacement_lock() { LOCK_HELD=0; }
# The outer command already spent the lock wait budget. A borrowed owner cannot be reacquired.
wait_for_replacement_lock() { return 1; }
`
        : "") +
      (captureBaseline
        ? `
${buildReconnectProbeScript(selection)}
capture_reconnect_baseline() {
  if [ "$LOCK_HELD" = 1 ] && [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] &&
     probe_output="$(reconnect_probe capture)"; then printf 'GOAT_RECONNECT_PROBE=%s\\n' "$probe_output"; fi
}
`
        : ""),
    GOAT_READY_BASELINE: captureBaseline ? "capture_reconnect_baseline\n" : "",
    GOAT_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    GOAT_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
    GOAT_REQUESTED_RUNNER: shellSingleQuote(
      isNodeScriptRunner(input)
        ? `Node script ${input?.nodeScriptPath?.trim()}`
        : `GOAT ${selection.requestedVersion}`,
    ),
    GOAT_EXPECTED_ARCHIVE_VERSION: shellSingleQuote(selection.version ?? ""),
    GOAT_SELECTED_VERSION: shellSingleQuote(selection.version ?? ""),
    GOAT_REQUESTED_VERSION: shellSingleQuote(selection.requestedVersion ?? ""),
    GOAT_REQUIRE_INSTALLED: selection.requireInstalled ? "1" : "0",
    GOAT_PRESERVE_SELECTED_RUNNER: preserve ? "1" : "0",
    GOAT_ALLOW_OWNED_UPGRADE:
      verifyOwnedBeforePublication && selection.mayUpgradeOwnedServer ? "1" : "0",
    GOAT_ALLOW_LEGACY_ADOPTION:
      verifyOwnedBeforePublication && selection.mayUpgradeOwnedServer && !isNodeScriptRunner(input)
        ? "1"
        : "0",
    GOAT_REFRESH_IF_IDLE:
      verifyOwnedBeforePublication && selection.mayUpgradeOwnedServer && selection.refreshIfIdle
        ? "1"
        : "0",
    GOAT_REFRESH_LIVE_VERSION: shellSingleQuote(selection.expectedLiveVersion ?? ""),
    GOAT_LIVE_RUNNER_SHA256: shellSingleQuote(selection.expectedLiveRunnerSha256 ?? ""),
    GOAT_CAPTURE_RUNNING_RUNNER: verifyOwnedBeforePublication
      ? 'if [ "$ALLOW_LEGACY_ADOPTION" = 1 ] || [ "$REFRESH_IF_IDLE" = 1 ]; then capture_running_runner || ownership_unverified; fi'
      : "",
    GOAT_RETAINED_RUNNER_SHA256: shellSingleQuote(selection.retainedRunnerSha256 ?? ""),
    GOAT_INSTALLED_EXECUTABLE_SHA256: shellSingleQuote(selection.installedExecutableSha256 ?? ""),
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteGoatRunnerScript(input)),
    GOAT_PROTOCOL_GUARD: applyScriptPlaceholders(REMOTE_PROTOCOL_GUARD_SCRIPT, {
      GOAT_SSH_PROTOCOL: String(input?.candidateProtocol?.ssh ?? SSH_RUNTIME_PROTOCOL_VERSION),
      GOAT_ORCHESTRATION_PROTOCOL: String(
        input?.candidateProtocol?.orchestration ?? ORCHESTRATION_PROTOCOL_VERSION,
      ),
      GOAT_RECONNECT_LIVE_GUARD: reconnect
        ? `  # A folded reconnect may only attach to the owned selection; a race must re-enter preparation.
  if [ "$LIVE_STATUS" != live ] || [ "$LIVE_VERSION" != "$SELECTED_VERSION" ] ||
     [ "$LIVE_OWNED" != 1 ] || ! verify_owned_identity "$LIVE_PID" "$LIVE_PORT"; then
    printf 'Cached GOAT selection changed; reconnect.\\n' >&2; exit ${REMOTE_RECONNECT_REPROBE_EXIT_CODE}
  fi
`
        : "",
    }),
    GOAT_VERIFY_OWNED_BEFORE_PUBLICATION: verifyOwnedBeforePublication
      ? VERIFY_OWNED_BEFORE_PUBLICATION + "\n"
      : "",
    GOAT_RUNNER_INSTALL: preserve ? KEEP_EXISTING_RUNNER_INSTALL : REPLACE_RUNNER_INSTALL,
  });
}

export function buildRemoteLaunchScript(
  input?: RemoteGoatRunnerOptions,
  selection = requestedRuntime(input),
  reconnect = false,
  captureBaseline = false,
): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    GOAT_ARCHIVE_MODE: isNodeScriptRunner(input) ? "0" : "1",
    GOAT_NODE_SCRIPT_PATH: shellSingleQuote(input?.nodeScriptPath?.trim() || ""),
    GOAT_OWNED_IDENTITY: REMOTE_OWNED_IDENTITY_SCRIPT,
    GOAT_LEGACY_IDENTITY: REMOTE_LEGACY_IDENTITY_SCRIPT,
    GOAT_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(
      input,
      selection,
      true,
      reconnect,
      captureBaseline,
    ),
    GOAT_READY_BASELINE: captureBaseline ? "capture_reconnect_baseline\n" : "",
    GOAT_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    GOAT_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    GOAT_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    GOAT_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    GOAT_LAUNCH_ATTEMPTS: String(REMOTE_LAUNCH_ATTEMPTS),
    GOAT_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    GOAT_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    GOAT_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
    GOAT_REQUIRE_FRESH_HOST: selection.requireFreshHost === true ? "1" : "0",
  });
}

export function buildRemoteMcpSessionScript(
  stateKey: string,
  options: RemoteMcpClientSessionOptions,
  input?: RemoteGoatRunnerOptions,
  selection = requestedRuntime(input),
): string {
  return applyScriptPlaceholders(REMOTE_MCP_SESSION_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_TTL: shellSingleQuote(options.ttl),
    GOAT_LABEL: shellSingleQuote(options.label),
    GOAT_CEILING: shellSingleQuote(options.runtimeModeCeiling ?? ""),
    GOAT_MEMORY_SCOPES: (options.memoryScopes?.length ?? 0) > 0 ? "required" : "none",
    GOAT_EXTRA_SCOPES:
      (options.approvals === true ? "--scope orchestration:approve " : "") +
      (options.providersManage === true ? "--scope providers:manage " : "") +
      (options.memoryScopes ?? []).map((scope) => `--scope ${shellSingleQuote(scope)} `).join(""),
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, {
      ...selection,
      mayUpgradeOwnedServer: false,
    }),
  });
}

export function buildRemoteClientSessionScript(
  stateKey: string,
  options: RemoteClientSessionOptions,
  input?: RemoteGoatRunnerOptions,
  selection = requestedRuntime(input),
): string {
  if (options.scopes.length === 0) {
    throw new Error("A remote client session requires explicit scopes.");
  }
  if (options.subject === "mcp-client") {
    throw new Error("The mcp-client subject cannot access client HTTP or WebSocket endpoints.");
  }
  return applyScriptPlaceholders(REMOTE_CLIENT_SESSION_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_SUBJECT: shellSingleQuote(options.subject),
    GOAT_SCOPES: options.scopes.map((scope) => `--scope ${shellSingleQuote(scope)}`).join(" "),
    GOAT_TTL: shellSingleQuote(options.ttl),
    GOAT_LABEL: shellSingleQuote(options.label),
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, {
      ...selection,
      mayUpgradeOwnedServer: false,
    }),
  });
}

export const decodeRemoteClientSessionOutput = Effect.fn(
  "ssh/tunnel.decodeRemoteClientSessionOutput",
)(function* (stdout: string, requestedScopes: ReadonlyArray<AuthEnvironmentScope>) {
  const session = yield* decodeRemoteJsonOutput(stdout, decodeRemoteClientSessionResult).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "The remote GOAT CLI did not return a client session with explicit scopes.",
          stdout,
          cause,
        }),
    ),
  );
  if (session.token.trim().length === 0) {
    return yield* new SshPairingError({
      message: "The remote GOAT CLI returned an empty client session token.",
      stdout,
    });
  }
  const requested = new Set(requestedScopes);
  const granted = new Set(session.scopes);
  if (
    requested.size === 0 ||
    granted.size !== requested.size ||
    !session.scopes.every((scope) => requested.has(scope))
  ) {
    return yield* new SshPairingError({
      message: "The remote GOAT CLI returned client session scopes that differ from the request.",
      stdout,
    });
  }
  return {
    token: session.token,
    expiresAt: session.expiresAt ?? null,
    scopes: session.scopes,
  } satisfies RemoteClientSession;
});

/** The session script's refusal when the remote CLI cannot issue requested memory scopes. */
const MEMORY_SCOPES_UNSUPPORTED = /^GOAT_SESSION_ERROR=memory_scopes_unsupported runtime=(\S+)$/m;

/** Turns that refusal into the error a user reads, with what will or should happen next. */
const memoryScopesUnsupportedError = (stdout: string, alias: string, remedy: string) => {
  const runtime = MEMORY_SCOPES_UNSUPPORTED.exec(stdout)?.[1];
  return runtime === undefined
    ? undefined
    : new SshPairingError({
        reason: "memory-scopes-unsupported",
        message: `GOAT ${runtime} on ${alias} cannot grant memory access to tasks. ${remedy}`,
        stdout,
      });
};

/** Reads the remote session script's output: a ceiling marker line, then the CLI's JSON. */
export const decodeRemoteMcpSessionOutput = Effect.fn("ssh/tunnel.decodeRemoteMcpSessionOutput")(
  function* (stdout: string) {
    const marker = /^(?:GOAT|T3)_CEILING=(applied|default)$/mu.exec(stdout);
    const session = yield* decodeRemoteJsonOutput(
      marker === null ? stdout : stdout.slice(marker.index + marker[0].length),
      decodeRemoteMcpSessionResult,
    );
    return {
      token: session.token,
      expiresAt: session.expiresAt ?? null,
      runtimeModeCeilingApplied: marker?.[1] === "applied",
    } satisfies RemoteMcpClientSession;
  },
);

export function buildRemotePairingScript(
  stateKey: string,
  input?: RemoteGoatRunnerOptions,
  selection = requestedRuntime(input),
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_RUNNER_SETUP: buildRemoteRunnerSetupScript(input, {
      ...selection,
      mayUpgradeOwnedServer: false,
    }),
  });
}

/**
 * Installers are transient copies of the runner with its fetch block swapped out, so the
 * managed run-t3.sh bytes (and the retained-runner identity built on them) never change.
 */
function replaceRunnerAcquisitionBlock(script: string, replace: (block: string) => string): string {
  const startAnchor = '  goat_fetch "$GOAT_RELEASE_BASE_URL/v$GOAT_ARCHIVE_VERSION/SHA256SUMS"';
  const endAnchor = "  if command -v sha256sum >/dev/null 2>&1; then";
  const start = script.indexOf(startAnchor);
  const end = script.indexOf(endAnchor);
  if (
    start < 0 ||
    end <= start ||
    script.indexOf(startAnchor, start + 1) !== -1 ||
    script.indexOf(endAnchor, end + 1) !== -1
  ) {
    throw new SshLaunchError({ message: "acquisition block no longer matches", stdout: "" });
  }
  return script.slice(0, start) + replace(script.slice(start, end)) + script.slice(end);
}

export function buildRemoteGoatUploadInstallerScript(
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

// curl --retry and wget --tries back off only on transient failures (timeouts, 408, 429,
// 5xx), so a 404 or a host without DNS fails at once and the client uploads instead.
const REMOTE_HOST_FETCH_FUNCTION = `  goat_host_fetch() {
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --connect-timeout 10 --retry 2 --max-time "$3" "$1" -o "$2" && return 0
    elif command -v wget >/dev/null 2>&1; then
      if wget --help 2>&1 | grep -q -- --retry-on-http-error; then
        wget -q --timeout=30 --tries=3 --waitretry=2 --retry-on-http-error=408,429,500,502,503,504 "$1" -O "$2" && return 0
      else
        wget -q --timeout=30 --tries=3 --waitretry=2 "$1" -O "$2" && return 0
      fi
    else
      printf 'Remote host needs curl or wget to download %s.\\n' "$GOAT_ARCHIVE" >&2
      return 1
    fi
    printf 'Remote host could not download %s.\\n' "$1" >&2
    return 1
  }
`;

/**
 * Installs the requested published release on the host from its own network, verified
 * against the release's SHA256SUMS like every HTTPS acquisition, and exits after
 * `goat --version` without starting a server. Launch then finds the runtime ready.
 */
export function buildRemoteHostDownloadScript(input: RemoteGoatRunnerOptions): string {
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

export function buildRemoteUploadScript(input: RemoteGoatRunnerOptions, sha256: string): string {
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
 * The SSH invocation that runs the upload script with the archive on stdin. Windows OpenSSH
 * truncates a remote command near 8 KiB, so a Windows host reads the script from the front of
 * stdin, ahead of the archive. dd reads it a byte at a time: a buffered reader such as BSD head
 * would also consume the start of the archive.
 */
export function remoteUploadCommand(
  script: string,
  archive: Uint8Array,
  platform: "darwin" | "linux" | "win32",
): {
  readonly remoteCommandArgs: ReadonlyArray<string>;
  readonly stdin: Uint8Array;
  readonly archiveOffset: number;
  readonly archiveLength: number;
} {
  if (platform !== "win32") {
    return {
      remoteCommandArgs: ["sh", "-c", shellSingleQuote(script)],
      stdin: archive,
      archiveOffset: 0,
      archiveLength: archive.byteLength,
    };
  }
  const scriptBytes = new TextEncoder().encode(script);
  const stdin = new Uint8Array(scriptBytes.byteLength + archive.byteLength);
  stdin.set(scriptBytes);
  stdin.set(archive, scriptBytes.byteLength);
  const bootstrap = `upload_script="$(mktemp)" && dd bs=1 count=${scriptBytes.byteLength} of="$upload_script" 2>/dev/null && sh "$upload_script"; upload_status=$?; rm -f "$upload_script"; exit "$upload_status"`;
  return {
    remoteCommandArgs: ["sh", "-c", shellSingleQuote(bootstrap)],
    stdin,
    archiveOffset: scriptBytes.byteLength,
    archiveLength: archive.byteLength,
  };
}

export function buildRemoteRuntimeProbeScript(
  version: string,
  stateKey?: string,
  _keepExistingRunner = false,
  recordReconnect = false,
): string {
  return `set -eu
V=${shellSingleQuote(version)}
state_key=${shellSingleQuote(stateKey ?? "")}
state="$HOME/.goat/ssh-launch/$state_key"
runtime_file="$HOME/.goat/userdata/server-runtime.json"
${REMOTE_PROTOCOL_TOKEN_SCRIPT}
prune_removed_facts
ready_version() {
  valid_version "$1" && [ -x "$HOME/.goat/runtime/goat/versions/$1/goat" ] &&
    [ "$(cat "$HOME/.goat/runtime/goat/versions/$1/.install-complete" 2>/dev/null)" = "$1" ]
}
signals_json() {
  # Positional parameters are scoped to this function, not the enclosing script.
  version="$1"; ssh="$2"; orch="$3"
  valid_version "$version" || return 1
  fields=
  for pair in "sshRuntimeProtocolVersion:$ssh" "orchestrationProtocolVersion:$orch"; do
    key="\${pair%%:*}"; value="\${pair#*:}"
    if [ "$value" = unknown ]; then continue; fi
    case "$value" in ''|*[!0-9]*) return 1 ;; esac
    valid_positive "$value" || return 1
    fields="$fields,\\"$key\\":$value"
  done
  printf '{"serverVersion":"%s"%s}' "$version" "$fields"
}
binary_json() {
  v="$1"; exe="$HOME/.goat/runtime/goat/versions/$v/goat"
  if ! ready_version "$v" || [ "$(exec_fact version "$exe" --version 2>/dev/null || true)" != "goat v$v" ]; then return 1; fi
  if own="$(exec_fact own "$exe" __ssh-helper protocol --shell 2>/dev/null)"; then
    set -f; set -- $own
    if ! valid_own_tokens "$@" || [ "$1" != "$v" ]; then printf '{"serverVersion":"%s","invalid":true}' "$v"; return; fi
    if signals="$(signals_json "$1" "$2" "$3")"; then printf '%s' "$signals";
    else printf '{"serverVersion":"%s","invalid":true}' "$v"; fi
  else
    # Exact legacy fallback has independent --version evidence above.
    printf '{"serverVersion":"%s"}' "$v"
  fi
}
${REMOTE_RUNNER_HINT_SCRIPT}
${
  recordReconnect
    ? `# Capturing a baseline cannot help until the executable and live process can be keyed.
if [ "\${1:-}" = capture ] &&
   { [ ! -f "$state/identity" ] || ! live_fact_key "$state/run-t3.sh" "$runtime_file" "$state/port" "$state/pid"; }; then
  exit 1
fi
`
    : ""
}
retained_version=
retained_sha256=
if [ -n "$state_key" ] && [ -f "$state/run-t3.sh" ]; then
  retained_sha256="$(runner_sha256 "$state/run-t3.sh")" || exit 1
  node_path="$(read_runner_hint "$state/run-t3.sh" GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY})"
  if [ -z "$node_path" ]; then
    retained_version="$(read_runner_hint "$state/run-t3.sh" GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY})"
  fi
fi
retained_fields=
# A published fallback that has not yet served (pending) or failed verification (rejected).
# Any marker GOAT cannot read still holds the version.
held_of() {
  held_file="$HOME/.goat/runtime/goat/held/$1"
  [ -e "$held_file" ] || [ -L "$held_file" ] || return 1
  case "$(cat "$held_file" 2>/dev/null || true)" in rejected) printf rejected ;; *) printf pending ;; esac
}
if [ -n "$retained_sha256" ]; then
  retained_fields="$(printf ',"retainedRunnerSha256":"%s"' "$retained_sha256")"
fi
if ready_version "$retained_version"; then
  retained_signals="$(binary_json "$retained_version" || true)"
  if [ -n "$retained_signals" ]; then
    [ "$(runner_sha256 "$state/run-t3.sh")" = "$retained_sha256" ] || {
      printf 'Retained GOAT runner changed during probe; reconnect.\\n' >&2; exit 1;
    }
    retained_fields="$(printf ',"retained":"ready","retainedVersion":"%s","retainedSignals":%s,"retainedRunnerSha256":"%s"' "$retained_version" "$retained_signals" "$retained_sha256")"
    if retained_commit="$(build_commit_time "$HOME/.goat/runtime/goat/versions/$retained_version/goat")"; then
      retained_fields="$retained_fields,\\"retainedCommitTime\\":$retained_commit"
    fi
    if [ "$retained_version" != "$V" ] && lacks_memory_scopes "$HOME/.goat/runtime/goat/versions/$retained_version/goat"; then
      retained_fields="$retained_fields,\\"retainedLacksMemoryScopes\\":true"
    fi
    if retained_held="$(held_of "$retained_version")"; then
      retained_fields="$retained_fields,\\"retainedHeld\\":\\"$retained_held\\""
    fi
  fi
fi
# Records pin executable identity. Unrecorded installs must prove their exact version and both
# protocols themselves; launch re-verifies the executable SHA captured by this probe.
installed_candidates=
installed_versions=
installed_collected=0
# Discovery used to run here; it keeps the glob setting it would have had at this point.
case "$-" in *f*) installed_noglob=1 ;; *) installed_noglob=0 ;; esac
# Hashing and asking every recorded install costs seconds, and only a host with no live server
# uses the result (to fall back when this app's runtime cannot be installed), so it runs on demand.
collect_installed_candidates() {
  [ "$installed_collected" = 0 ] || return 0
  installed_collected=1
  case "$-" in *f*) caller_noglob=1 ;; *) caller_noglob=0 ;; esac
  if [ "$installed_noglob" = 1 ]; then set -f; else set +f; fi
  record_list="$(ls -t "$HOME/.goat/runtime/goat/versions/"*/.install-record 2>/dev/null | head -n 8)"
  old_ifs="$IFS"; IFS='
'
  for record in $record_list; do
    IFS="$old_ifs"
    dir="\${record%/.install-record}"; recorded_version="\${dir##*/}"
    valid_version "$recorded_version" || continue
    [ "$recorded_version" != "$retained_version" ] || continue
    [ ! -L "$dir" ] && [ ! -L "$record" ] && [ ! -L "$dir/goat" ] || continue
    read -r record_version archive_sha executable_sha record_source record_extra < "$record" || continue
    [ "$record_version" = "$recorded_version" ] && [ -z "$record_extra" ] || continue
    case "$record_source" in bundle|cache|mirror|https|gh) ;; *) continue ;; esac
    printf '%s\\n' "$archive_sha" "$executable_sha" | LC_ALL=C grep -Eqv '^[0-9a-f]{64}$' && continue
    [ "$(runner_sha256 "$dir/goat")" = "$executable_sha" ] || continue
    candidate_signals="$(binary_json "$recorded_version" || true)"
    [ -n "$candidate_signals" ] || continue
    candidate_fields="$(printf '{"version":"%s","signals":%s,"executableSha256":"%s"' "$recorded_version" "$candidate_signals" "$executable_sha")"
    if candidate_commit="$(build_commit_time "$dir/goat")"; then
      candidate_fields="$candidate_fields,\\"commitTime\\":$candidate_commit"
    fi
    if held_state="$(held_of "$recorded_version")"; then
      candidate_fields="$candidate_fields,\\"held\\":\\"$held_state\\""
    fi
    installed_versions="$installed_versions $recorded_version"
    installed_candidates="$installed_candidates\${installed_candidates:+,}$candidate_fields}"
  done
  if [ "$installed_noglob" = 1 ]; then set -f; else set +f; fi
  marker_list="$(ls -t "$HOME/.goat/runtime/goat/versions/"*/.install-complete 2>/dev/null || true)"
  IFS='
'
  eligible=0
  for marker in $marker_list; do
    IFS="$old_ifs"
    dir="\${marker%/.install-complete}"; candidate_version="\${dir##*/}"
    [ ! -e "$dir/.install-record" ] && [ ! -L "$dir/.install-record" ] || continue
    [ ! -L "$dir" ] && [ ! -L "$marker" ] && [ ! -L "$dir/goat" ] || continue
    [ "$candidate_version" != "$retained_version" ] || continue
    # Builtin exclusions first: valid_version spawns grep, and recorded installs can be numerous.
    valid_version "$candidate_version" || continue
    ready_version "$candidate_version" || continue
    case " $installed_versions " in *" $candidate_version "*) continue ;; esac
    [ "$eligible" -lt 8 ] || break
    eligible=$((eligible + 1))
    candidate_signals="$(binary_json "$candidate_version" || true)"
    case "$candidate_signals" in *'"sshRuntimeProtocolVersion"'*'"orchestrationProtocolVersion"'*) ;; *) continue ;; esac
    case "$candidate_signals" in *'"invalid"'*) continue ;; esac
    executable_sha="$(runner_sha256 "$dir/goat")" || continue
    candidate_fields="$(printf '{"version":"%s","signals":%s,"executableSha256":"%s","unrecorded":true' "$candidate_version" "$candidate_signals" "$executable_sha")"
    if candidate_commit="$(build_commit_time "$dir/goat")"; then
      candidate_fields="$candidate_fields,\\"commitTime\\":$candidate_commit"
    fi
    if held_state="$(held_of "$candidate_version")"; then
      candidate_fields="$candidate_fields,\\"held\\":\\"$held_state\\""
    fi
    installed_versions="$installed_versions $candidate_version"
    installed_candidates="$installed_candidates\${installed_candidates:+,}$candidate_fields}"
  done
  IFS="$old_ifs"
  if [ "$caller_noglob" = 1 ]; then set -f; else set +f; fi
}
# Persisted version is a path hint only. The live descriptor proves identity.
live_hint="$(sed -n 's/.*"serverVersion"[[:space:]]*:[[:space:]]*"\\([^" ]*\\)".*/\\1/p' "$runtime_file" 2>/dev/null || true)"
live_fields=
live_owned=false
live_status=
identity_absent=false
if [ -n "$state_key" ] && [ ! -e "$state/identity" ] && [ ! -L "$state/identity" ]; then identity_absent=true; fi
# Succeeds once the helper of installed version $1 answered for the live server.
probe_live() {
  candidate="$1"
  ready_version "$candidate" || return 1
  exe="$HOME/.goat/runtime/goat/versions/$candidate/goat"
  live="$(live_fact "$exe" "$runtime_file" "$state/port" "$state/pid" 2>/dev/null)" || return 1
  set -f; set -- $live
  if ! valid_live_tokens "$@"; then
    printf 'Malformed live GOAT protocol tokens; fix the remote helper and reconnect.\\n' >&2; exit 1
  fi
  live_status="$1"
  live_fields="$(printf ',"liveStatus":"%s"' "$1")"
  if [ "$1" = live ] && valid_positive "$5" &&
     [ "$(cat "$state/managed" 2>/dev/null || true)" = managed ] &&
     [ "$(cat "$state/pid" 2>/dev/null || true)" = "$5" ] &&
     [ "$(cat "$state/port" 2>/dev/null || true)" = "$6" ]; then live_owned=true; fi
  if [ "$1" = live ] && valid_version "$2"; then
    live_version="$2"
    live_fields="$live_fields$(printf ',"livePort":%s' "$6")"
    live_signals="$(signals_json "$2" "$3" "$4" || true)"
    live_binary="$(binary_json "$live_version" || true)"
    if [ -n "$live_signals" ]; then
      live_fields="$live_fields$(printf ',"liveVersion":"%s","liveSignals":%s' "$live_version" "$live_signals")"
      if [ -n "$live_binary" ]; then
        live_fields="$live_fields$(printf ',"liveBinarySignals":%s' "$live_binary")"
        if live_commit="$(build_commit_time "$HOME/.goat/runtime/goat/versions/$live_version/goat")"; then
          live_fields="$live_fields,\\"liveCommitTime\\":$live_commit"
        fi
        if [ "$live_version" != "$V" ] && lacks_memory_scopes "$HOME/.goat/runtime/goat/versions/$live_version/goat"; then
          live_fields="$live_fields,\\"liveLacksMemoryScopes\\":true"
        fi
      fi
    fi
    # Only a server that drains for its own replacement may be replaced; others are attach-only.
    if valid_port "$6" && live_compat="$(compat_fact "$exe" "$6" "$runtime_file" "$state/port" "$state/pid" "$5" 2>/dev/null)"; then
      set -f; set -- $live_compat
      if [ "$#" = 3 ] && [ "$2" = 1 ]; then live_fields="$live_fields,\\"liveDrain\\":true"; fi
    fi
  fi
}
live_answered=0
for candidate in "$live_hint" "$retained_version" "$V"; do
  if probe_live "$candidate"; then live_answered=1; break; fi
done
if [ "$live_answered" = 0 ]; then
  collect_installed_candidates
  for candidate in $installed_versions; do
    if probe_live "$candidate"; then break; fi
  done
fi
[ "$live_status" != none ] || collect_installed_candidates
case "$(uname -s)" in
  Darwin) platform=darwin ;; Linux) platform=linux ;; MINGW*|MSYS*|CYGWIN*) platform=win32 ;;
  *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;;
  *) printf 'Remote host %s has no GOAT release archive.\\n' "$(uname -m)" >&2; exit 1 ;;
esac
ready=false
if ready_version "$V"; then ready=true; fi
${
  recordReconnect
    ? `# A byte-identical answer alone would miss a rebuilt binary or a changed ownership record.
reconnect_key=
if [ "$platform" != win32 ] && live_fact_key "$HOME/.goat/runtime/goat/versions/\${live_version:-}/goat" "$runtime_file" "$state/port" "$state/pid"; then
  reconnect_live_key="$FACT_KEY"
  if reconnect_runner="$(runner_sha256 "$state/run-t3.sh")" &&
     reconnect_identity="$(runner_sha256 "$state/identity")" &&
     reconnect_managed="$(runner_sha256 "$state/managed")"; then
    reconnect_key="$(printf '%s' "$reconnect_live_key|$reconnect_runner|$reconnect_identity|$reconnect_managed" | runner_sha256 /dev/stdin)" || reconnect_key=
  fi
fi
[ -z "$reconnect_key" ] || live_fields="$live_fields,\\"reconnectKey\\":\\"$reconnect_key\\""
`
    : ""
}
printf '{"platform":"%s","arch":"%s","ready":%s,"liveOwned":%s,"identityAbsent":%s,"installedCandidates":[%s]%s%s}\\n' "$platform" "$arch" "$ready" "$live_owned" "$identity_absent" "$installed_candidates" "$retained_fields" "$live_fields"
`;
}

const decodeRemoteRuntimeProbe = Schema.decodeEffect(
  fromLenientJson(
    Schema.Struct({
      platform: Schema.Literals(["darwin", "linux", "win32"]),
      arch: Schema.Literals(["arm64", "x64"]),
      ready: Schema.Boolean,
      reconnectKey: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
      installedCandidates: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            version: Schema.String,
            signals: RuntimeSignals,
            commitTime: Schema.optionalKey(Schema.Int),
            unrecorded: Schema.optionalKey(Schema.Boolean),
            /** A published fallback still being verified (`pending`) or refused (`rejected`). */
            held: Schema.optionalKey(Schema.Literals(["pending", "rejected"])),
            executableSha256: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
          }),
        ),
      ),
      retained: Schema.optionalKey(Schema.Literals(["ready", "missing"])),
      retainedVersion: Schema.optionalKey(Schema.String),
      retainedSignals: Schema.optionalKey(RuntimeSignals),
      retainedRunnerSha256: Schema.optionalKey(
        Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)),
      ),
      /** Commit times of the installed retained and live builds; absent for unstamped builds. */
      retainedCommitTime: Schema.optionalKey(Schema.Int),
      /** The installed build's CLI cannot issue memory scopes; absent when it can or is unknown. */
      retainedLacksMemoryScopes: Schema.optionalKey(Schema.Boolean),
      /** The retained runtime is a held published fallback; see `REMOTE_PUBLISHED_RUNTIME_GATE_SCRIPT`. */
      retainedHeld: Schema.optionalKey(Schema.Literals(["pending", "rejected"])),
      liveStatus: Schema.optionalKey(Schema.Literals(["none", "live", "unknown"])),
      liveOwned: Schema.optionalKey(Schema.Boolean),
      identityAbsent: Schema.optionalKey(Schema.Boolean),
      liveVersion: Schema.optionalKey(Schema.String),
      livePort: Schema.optionalKey(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 })),
      ),
      liveSignals: Schema.optionalKey(RuntimeSignals),
      liveBinarySignals: Schema.optionalKey(RuntimeSignals),
      liveCommitTime: Schema.optionalKey(Schema.Int),
      liveLacksMemoryScopes: Schema.optionalKey(Schema.Boolean),
      /** The live server drains for a replacement. Without it the client only attaches. */
      liveDrain: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

/**
 * SSH failures (an unreachable host, a timeout, rejected authentication) keep their own error
 * and message, so they never read as a missing runtime archive. Anything else is wrapped with
 * its message attached.
 */
const runtimePreparationError = (cause: unknown) =>
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
const archiveSupplyError = (cause: unknown, action?: string) => {
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

/**
 * `compareRuntimeBuilds` for runtimes found on a host. Between a plain release and a prerelease
 * the commit time decides, and a plain build without one predates stamping, so it is older.
 * GOAT has only published prereleases, so a plain `0.1.1` on a host is a leftover from an older
 * install. It sorts above every `0.1.0-nightly.*` yet lacks their migrations, so starting it
 * against their database fails every launch.
 */
export const compareHostRuntimeBuilds = (
  left: RuntimeBuild,
  right: RuntimeBuild,
): number | undefined => {
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

export const prepareRemoteRuntime = (
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
      (probe.liveStatus === "unknown" || (probe.liveStatus === "live" && probe.liveOwned === true));
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
          (from.liveOwned !== true ||
            liveOrder === undefined ||
            liveOrder > 0 ||
            (selectedVersion !== version && from.liveDrain !== true))
            ? {
                updateBlocked:
                  liveOrder !== undefined && liveOrder > 0
                    ? `${target.alias} runs a newer GOAT (${selectedVersion}). Update this app from the update button above Settings.`
                    : `A GOAT server that this app didn't start or cannot replace is running on ${target.alias}. Stop it on the host, then reconnect.`,
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
            : yield* source("cache", readLocalRuntimeArchive(directory, version, platformKey)).pipe(
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
                  downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand),
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
                          : missAction("none", cliArchiveFileName(version, platformKey), directory),
                        cause,
                      }),
                  ),
                ),
              RuntimeArchiveNetworkError: () =>
                source(
                  "gh",
                  downloadRuntimeArchiveWithGh(directory, version, platformKey, runner?.ghCommand),
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
          return yield* giveUp("none", "The host has GOAT data but no runtime this app can start.");
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
              runtime.held === "rejected" && runtime.version !== undefined ? [runtime.version] : [],
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

/**
 * `fresh`: prints yes when the host has no GOAT database. `capable <version>`: prints yes
 * when that installed runtime's `auth session issue --help` succeeds and lists `memory:read`
 * (#285); partial output from a failing command is not evidence.
 * `hold <version>` / `reject <version>`: marks it held (`pending`) or refused for good. The
 * probe reports the mark, installed and retained recovery skip held runtimes, and launch
 * clears a `pending` mark once the server it started on a host without data is ready.
 * Marks change only under the launch's replacement lock and only while the host has no data,
 * so a setup that lost a race to another client can never hold or reject the runtime that
 * client started.
 */
const REMOTE_PUBLISHED_RUNTIME_GATE_SCRIPT = `set -u
DEFAULT_SERVER_HOME="$HOME/.goat"
STATE_DIR="$HOME/.goat/ssh-launch/@@GOAT_STATE_KEY@@"
has_data() {
  for db in "$DEFAULT_SERVER_HOME/userdata/statev2.sqlite" "$DEFAULT_SERVER_HOME/userdata/state.sqlite"; do
    if [ -e "$db" ] || [ -L "$db" ]; then return 0; fi
  done
  return 1
}
case "$1" in
  fresh)
    if has_data; then echo no; else echo yes; fi ;;
  capable)
    exe="$HOME/.goat/runtime/goat/versions/$2/goat"
    [ -x "$exe" ] || { echo no; exit 0; }
    scope_help="$("$exe" auth session issue --help 2>/dev/null)" || { echo no; exit 0; }
    case "$scope_help" in *memory:read*) echo yes ;; *) echo no ;; esac ;;
  hold | reject)
    case "$2" in '' | */* | . | ..) exit 2 ;; esac
    if [ "$1" = hold ]; then state=pending; else state=rejected; fi
    mkdir -p "$STATE_DIR"
@@GOAT_PROTOCOL_TOKENS@@
@@GOAT_REPLACEMENT_LOCK@@
    trap 'release_recovery_lock; release_replacement_lock' EXIT
    if ! acquire_replacement_lock; then
      if ! wait_for_replacement_lock || ! acquire_replacement_lock; then echo busy; exit 0; fi
    fi
    if has_data; then echo no; exit 0; fi
    held_dir="$HOME/.goat/runtime/goat/held"
    # Replace atomically: a torn write must never read as anything but held.
    mkdir -p "$held_dir" &&
      printf '%s\\n' "$state" > "$held_dir/.$2.$$" &&
      mv -f "$held_dir/.$2.$$" "$held_dir/$2" && echo yes ;;
  *) exit 2 ;;
esac
`;

function buildPublishedRuntimeGateScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_PUBLISHED_RUNTIME_GATE_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_REPLACEMENT_LOCK: REMOTE_REPLACEMENT_LOCK_SCRIPT,
  });
}

/** The single next step for a host that has no runtime this app can start. */
function missAction(miss: PublishedRuntimeMiss, asset: string, directory: string): string {
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
function archiveUnavailableText(alias: string, error: SshLaunchError, directory: string) {
  const acquisition = error.acquisition!;
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

const DEFAULT_STOP_WAIT_ATTEMPTS = 20;
const DEFAULT_STOP_WAIT_INTERVAL_SECONDS = "0.1";
const STOP_WAIT_INTERVAL_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Production waits 20×0.1s. Tests pass interval `0` so the loop follows process exit. */
function stopWaitPlaceholders(options: {
  readonly stopWaitAttempts?: number;
  readonly stopWaitIntervalSeconds?: string;
}): {
  readonly GOAT_STOP_WAIT_ATTEMPTS: string;
  readonly GOAT_STOP_WAIT_INTERVAL: string;
  readonly GOAT_STOP_WAIT_LABEL: string;
} {
  const attempts = options.stopWaitAttempts ?? DEFAULT_STOP_WAIT_ATTEMPTS;
  const interval = options.stopWaitIntervalSeconds ?? DEFAULT_STOP_WAIT_INTERVAL_SECONDS;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 1_000_000) {
    throw new Error(`stopWaitAttempts must be an integer from 1 to 1000000, got ${attempts}`);
  }
  if (!STOP_WAIT_INTERVAL_PATTERN.test(interval)) {
    throw new Error(`stopWaitIntervalSeconds must be a non-negative decimal, got ${interval}`);
  }
  return {
    GOAT_STOP_WAIT_ATTEMPTS: String(attempts),
    GOAT_STOP_WAIT_INTERVAL: interval,
    GOAT_STOP_WAIT_LABEL:
      attempts === DEFAULT_STOP_WAIT_ATTEMPTS && interval === DEFAULT_STOP_WAIT_INTERVAL_SECONDS
        ? "2 seconds"
        : "the stop deadline",
  };
}

export function buildRemoteStopScript(
  stateKey: string,
  options: {
    readonly ownedOnly?: boolean;
    readonly stopWaitAttempts?: number;
    readonly stopWaitIntervalSeconds?: string;
  } = {},
): string {
  return applyScriptPlaceholders(REMOTE_STOP_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
    GOAT_STOP_OWNED_ONLY: options.ownedOnly === true ? "1" : "0",
    GOAT_PROTOCOL_TOKENS: REMOTE_PROTOCOL_TOKEN_SCRIPT,
    GOAT_REPLACEMENT_LOCK: REMOTE_REPLACEMENT_LOCK_SCRIPT,
    GOAT_OWNED_IDENTITY: REMOTE_OWNED_IDENTITY_SCRIPT,
    ...stopWaitPlaceholders(options),
  });
}

function buildRemoteLogTailScript(stateKey: string): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    GOAT_STATE_KEY: stateKey,
  });
}

// Keep the probe in its own shell: its exit paths and shell options must not affect launch.
function buildReconnectProbeScript(selected: PreparedRemoteRuntime) {
  return `reconnect_probe() {
sh -s -- "\${1:-}" <<'GOAT_RECONNECT_PROBE_SCRIPT'
${buildRemoteRuntimeProbeScript(selected.requestedVersion ?? "", REMOTE_RUNTIME_STATE_KEY, false, true)}
GOAT_RECONNECT_PROBE_SCRIPT
}`;
}

function buildReconnectLaunchScript(selected: PreparedRemoteRuntime, expectedProbe?: string) {
  const pending = selected.reconnectPending ?? {
    reason: "contended" as const,
    replacement: "incompatible" as const,
    requestedVersion: selected.requestedVersion ?? "",
    liveVersion: selected.version ?? "unknown",
  };
  const successor = {
    ...selected,
    version: selected.requestedVersion,
    source: "installed" as const,
    runner: { ...selected.runner, archiveVersion: selected.requestedVersion },
    retainedRunnerSha256: null,
    mayUpgradeOwnedServer: false,
    refreshIfIdle: false,
  };
  delete successor.installedExecutableSha256;
  delete successor.expectedLiveRunnerSha256;
  delete successor.expectedLiveVersion;
  return `set -eu
${
  expectedProbe === undefined
    ? ""
    : `STATE_DIR="$HOME/.goat/ssh-launch/$1"
DEFAULT_SERVER_HOME="$HOME/.goat"
${REMOTE_PROTOCOL_TOKEN_SCRIPT}
${REMOTE_REPLACEMENT_LOCK_SCRIPT}
trap 'release_recovery_lock; release_replacement_lock' EXIT
trap 'exit 1' HUP INT TERM
if ! acquire_replacement_lock; then
  if ! wait_for_replacement_lock || ! acquire_replacement_lock; then
    ${
      selected.reconnectPending === undefined
        ? ": # Launch revalidates lock-only reuse, including the drain fence."
        : `${buildRemoteContendedOutput({
            replacement: pending.replacement,
            requestedVersion: pending.requestedVersion,
            liveVersion: pending.liveVersion,
          })}
    exit 0`
    }
  fi
fi
${buildReconnectProbeScript(selected)}
probe_output="$(reconnect_probe)"
reconnect_successor=0
if [ "$probe_output" != ${shellSingleQuote(expectedProbe)} ]; then
  case "$probe_output" in
    *${shellSingleQuote(`"liveVersion":"${selected.requestedVersion}"`)}*)
      ${selected.version !== selected.requestedVersion ? "reconnect_successor=1" : ":"} ;;
  esac
  if [ "$reconnect_successor" = 0 ]; then
    printf 'GOAT_RECONNECT_PROBE=%s\\n' "$probe_output"
    printf '{"status":"reprobe"}\\n'
    exit 0
  fi
fi`
}
reconnect_launch() {
sh -s -- "$1" "\${OWNER:-}" <<'GOAT_RECONNECT_LAUNCH_SCRIPT'
${buildRemoteLaunchScript(selected.runner, expectedProbe === undefined ? selected : { ...selected, mayUpgradeOwnedServer: false }, expectedProbe !== undefined, expectedProbe === undefined)}
GOAT_RECONNECT_LAUNCH_SCRIPT
}
${
  expectedProbe !== undefined && selected.version !== selected.requestedVersion
    ? `if [ "$reconnect_successor" = 1 ]; then
reconnect_launch() {
sh -s -- "$1" "$OWNER" <<'GOAT_RECONNECT_SUCCESSOR_SCRIPT'
${buildRemoteLaunchScript(successor.runner, successor, true)}
GOAT_RECONNECT_SUCCESSOR_SCRIPT
}
fi`
    : ""
}
if launch_output="$(reconnect_launch "$1")"; then
  :
else
  launch_status=$?
  if [ "$launch_status" -ne ${REMOTE_RECONNECT_REPROBE_EXIT_CODE} ]; then exit "$launch_status"; fi
  # A guard can fail after the probe; selection must observe that race afresh.
  printf '{"status":"reprobe"}\\n'
  exit 0
fi
${expectedProbe === undefined ? "" : "printf 'GOAT_RECONNECT_PROBE=%s\\n' \"$probe_output\""}
printf '%s\\n' "$launch_output"
`;
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuth.SshAuthOptions,
    runner?: RemoteGoatRunnerOptions,
    onPhase?: SshRuntimeProgressCallback,
    previousSelection?: PreparedRemoteRuntime,
    onLaunched?: (launch: {
      readonly status: "ready" | "pending";
      readonly pending?: SshRuntimePendingReplacement;
    }) => Effect.Effect<
      void,
      never,
      ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
    >,
  ): Effect.fn.Return<
    | {
        readonly status: "ready";
        readonly remotePort: number;
        readonly remoteServerKind: "external" | "managed" | null;
        readonly selectedRuntime: PreparedRemoteRuntime;
        readonly refresh?: "replaced";
        readonly pending?: SshRuntimePendingReplacement;
      }
    | { readonly status: "pending"; readonly pending: SshRuntimePendingReplacement },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const stateKey = REMOTE_RUNTIME_STATE_KEY;
        yield* Effect.logInfo("ssh.remoteServer.launch.start", {
          ...sshTargetLogFields(target),
          ...sshRunnerLogFields(runner),
          stateKey,
        });
        const canFoldProbe =
          previousSelection?.reconnectProbe !== undefined &&
          previousSelection.requestedVersion === runner?.archiveVersion?.trim() &&
          previousSelection.runner.archiveCommitTime === runner?.archiveCommitTime &&
          (previousSelection.runner.keepExistingRunner === true) ===
            (runner?.keepExistingRunner === true) &&
          previousSelection.upgradeFailure === undefined &&
          previousSelection.updateBlocked === undefined &&
          !isNodeScriptRunner(runner) &&
          runner?.refreshOwnedRuntimeOnFirstConnection !== true &&
          runner?.confirmReplacement !== true;
        const launch = (selected: PreparedRemoteRuntime, expectedProbe?: string) => {
          const command = runSshCommand(target, {
            remoteCommandArgs: ["sh", "-l", "-s", "--", stateKey],
            stdin:
              isNodeScriptRunner(selected.runner) || selected.hostPlatform === "win32"
                ? buildRemoteLaunchScript(selected.runner, selected)
                : buildReconnectLaunchScript(selected, expectedProbe),
            timeoutStage: "runtime-launch",
            timeoutMs: isNodeScriptRunner(selected.runner)
              ? REMOTE_LAUNCH_TIMEOUT_MS
              : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
            ...input,
          });
          return onLaunched === undefined ? restore(command) : command;
        };
        let folded = canFoldProbe
          ? yield* measureSshReconnectStep(
              "runtime-probe-folded",
              launch(
                { ...previousSelection, uploaded: false, requireInstalled: true },
                previousSelection.reconnectProbe,
              ),
            )
          : undefined;
        const observedProbe = folded?.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("GOAT_RECONNECT_PROBE="))
          ?.slice("GOAT_RECONNECT_PROBE=".length);
        if (
          folded !== undefined &&
          getLastNonEmptyOutputLine(folded.stdout) === '{"status":"reprobe"}'
        ) {
          yield* Effect.logDebug("ssh.runtime.reconnect.reprobe", sshTargetLogFields(target));
          folded = undefined;
        }
        const selected =
          folded !== undefined && previousSelection !== undefined
            ? { ...previousSelection, uploaded: false, requireInstalled: true }
            : yield* restore(
                prepareRemoteRuntime(
                  target,
                  input ?? {},
                  runner,
                  stateKey,
                  true,
                  onPhase,
                  observedProbe,
                ),
              );
        yield* Effect.annotateCurrentSpan("goat.runtime.selectedVersion", selected.version);
        yield* Effect.annotateCurrentSpan(
          "goat.runtime.requestedVersion",
          selected.requestedVersion,
        );
        const result = folded ?? (yield* launch(selected));
        if (!getLastNonEmptyOutputLine(result.stdout)) {
          return yield* new SshLaunchError({
            message: "SSH launch did not return a remote port.",
            stdout: result.stdout,
          });
        }
        const parsed = yield* decodeRemoteLaunchOutput(
          result.stdout
            .split(/\r?\n/u)
            .filter((line) => !line.startsWith("GOAT_RECONNECT_PROBE="))
            .join("\n"),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new SshLaunchError({
                message: "SSH launch returned unparseable output.",
                stdout: result.stdout,
                cause,
              }),
          ),
        );
        if (parsed.status === "pending") return parsed;
        const pending =
          parsed.pending ??
          (folded !== undefined && parsed.selectedVersion === previousSelection?.version
            ? previousSelection?.reconnectPending
            : undefined);
        if (!Number.isInteger(parsed.remotePort)) {
          return yield* new SshLaunchError({
            message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
            stdout: result.stdout,
          });
        }
        // The response and cleanup ownership must be atomic with respect to interruption.
        if (onLaunched !== undefined)
          yield* onLaunched({ status: "ready", ...(pending === undefined ? {} : { pending }) });
        yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
          ...sshTargetLogFields(target),
          remotePort: parsed.remotePort,
          remoteServerKind: parsed.serverKind ?? null,
          selectedVersion: parsed.selectedVersion ?? selected.version,
          requestedVersion: selected.requestedVersion,
          refresh: parsed.refresh ?? null,
          stateKey,
        });
        let probeOutput = result.stdout
          .split(/\r?\n/u)
          .find((line) => line.startsWith("GOAT_RECONNECT_PROBE="))
          ?.slice("GOAT_RECONNECT_PROBE=".length);
        if (
          !isNodeScriptRunner(selected.runner) &&
          // Garbage appears only when this launch installed a runtime; skip the round trip otherwise.
          (selected.uploaded === true || !selected.requireInstalled) &&
          parsed.pending === undefined &&
          parsed.refresh === undefined &&
          parsed.selectedVersion === selected.version
        ) {
          // A separate round trip makes even a hung cleanup or a dropped SSH connection best-effort.
          yield* restore(
            Effect.gen(function* () {
              const cleanup = yield* runSshCommand(target, {
                ...input,
                // The trailing word is only $1 to the script; it names this call in traces and tests.
                remoteCommandArgs: ["sh", "-l", "-s", "goat-runtime-cleanup"],
                timeoutMs: runner?.cleanupTimeoutMs ?? 10_000,
                stdin: `set -eu
DEFAULT_SERVER_HOME="$HOME/.goat"
STATE_DIR="$DEFAULT_SERVER_HOME/ssh-launch/${stateKey}"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PID_FILE="$STATE_DIR/pid"; PORT_FILE="$STATE_DIR/port"; RUNNER_FILE="$STATE_DIR/run-t3.sh"
SELECTED_VERSION=${shellSingleQuote(selected.version ?? "")}
REQUESTED_VERSION=${shellSingleQuote(selected.requestedVersion ?? "")}
REMOTE_PORT=${parsed.remotePort}; GOAT_ARCHIVE_MODE=1
${REMOTE_PROTOCOL_TOKEN_SCRIPT}
${REMOTE_RUNNER_HINT_SCRIPT}
${REMOTE_REPLACEMENT_LOCK_SCRIPT}
trap 'release_recovery_lock; release_replacement_lock' EXIT
trap 'exit 1' HUP INT TERM
if [ "$GOAT_HOST_WINDOWS" = 1 ]; then exit 0; fi
if [ -e "$LOCK" ] || [ -L "$LOCK" ] || ! acquire_replacement_lock; then
  printf 'ssh.runtime.cleanup.skipped replacement lock held\\n' >&2
  exit 0
fi
${REMOTE_RUNTIME_CLEANUP_SCRIPT}
release_recovery_lock
release_replacement_lock
# Cleanup gets the full deadline under the mutex; only optional fact warming uses what remains.
${REMOTE_RUNTIME_FACT_WARMUP_SCRIPT}
# A fresh install could not be keyed before warm-up; return its baseline in this round trip.
${buildReconnectProbeScript(selected)}
if probe_output="$(reconnect_probe capture)"; then printf 'GOAT_RECONNECT_PROBE=%s\\n' "$probe_output"; fi`,
              });
              probeOutput =
                cleanup.stdout
                  .split(/\r?\n/u)
                  .find((line) => line.startsWith("GOAT_RECONNECT_PROBE="))
                  ?.slice("GOAT_RECONNECT_PROBE=".length) ?? probeOutput;
              for (const line of cleanup.stderr.split(/\r?\n/u)) {
                if (line.startsWith("ssh.runtime.cleanup.")) {
                  yield* Effect.logInfo("ssh.runtime.cleanup.result", {
                    ...sshTargetLogFields(target),
                    detail: line,
                  });
                }
              }
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("ssh.runtime.cleanup.failed", {
                  ...sshTargetLogFields(target),
                  cause,
                }),
              ),
            ),
          );
        }
        const reusedVersion = parsed.selectedVersion;
        const cachedSelection: PreparedRemoteRuntime =
          reusedVersion === selected.version || isNodeScriptRunner(selected.runner)
            ? selected
            : {
                ...selected,
                version: reusedVersion,
                source: parsed.pending === undefined ? "live" : "retained",
                runner: {
                  ...selected.runner,
                  archiveVersion: reusedVersion,
                  refreshOwnedRuntimeOnFirstConnection: false,
                },
                retainedRunnerSha256: selected.expectedLiveRunnerSha256 ?? null,
                refreshIfIdle: false,
              };
        const durableSelection = {
          ...cachedSelection,
          runner: { ...cachedSelection.runner, confirmReplacement: false },
        };
        delete durableSelection.refreshIfIdle;
        delete durableSelection.expectedLiveVersion;
        delete durableSelection.expectedLiveRunnerSha256;
        delete durableSelection.reconnectProbe;
        delete durableSelection.reconnectPending;
        if (pending !== undefined) durableSelection.reconnectPending = pending;
        if (
          probeOutput !== undefined &&
          selected.upgradeFailure === undefined &&
          selected.updateBlocked === undefined &&
          parsed.selectedVersion === cachedSelection.version
        ) {
          const probe = yield* decodeRemoteRuntimeProbe(probeOutput).pipe(Effect.option);
          if (
            Option.isSome(probe) &&
            probe.value.reconnectKey !== undefined &&
            probe.value.platform !== "win32" &&
            probe.value.liveStatus === "live" &&
            probe.value.liveOwned === true &&
            probe.value.identityAbsent === false &&
            probe.value.liveVersion === cachedSelection.version &&
            probe.value.retainedVersion === cachedSelection.version &&
            (cachedSelection.source !== "retained" ||
              cachedSelection.retainedRunnerSha256 === null ||
              probe.value.retainedRunnerSha256 === cachedSelection.retainedRunnerSha256) &&
            probe.value.liveSignals !== undefined &&
            probe.value.liveBinarySignals !== undefined &&
            matchesSignals(probe.value.liveSignals, selected.requestedVersion ?? "") &&
            matchesSignals(probe.value.liveBinarySignals, selected.requestedVersion ?? "")
          ) {
            durableSelection.reconnectProbe = probeOutput;
            durableSelection.source = "retained";
            durableSelection.retainedRunnerSha256 = probe.value.retainedRunnerSha256 ?? null;
          }
        }
        notifyRuntimePhase(target, "starting", onPhase);
        return {
          status: "ready" as const,
          remotePort: parsed.remotePort,
          remoteServerKind: parsed.serverKind ?? null,
          selectedRuntime: {
            ...durableSelection,
            requireInstalled: !isNodeScriptRunner(selected.runner),
          },
          ...(parsed.refresh === undefined ? {} : { refresh: parsed.refresh }),
          ...(pending === undefined ? {} : { pending }),
        };
      }),
    );
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
  runner?: RemoteGoatRunnerOptions,
  prepared?: PreparedRemoteRuntime,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const stateKey = REMOTE_RUNTIME_STATE_KEY;
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  const selected =
    prepared ??
    (yield* prepareRemoteRuntime(
      target,
      input ?? {},
      { ...runner, keepExistingRunner: true },
      stateKey,
    ));
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    timeoutStage: "pairing",
    stdin: buildRemotePairingScript(stateKey, selected.runner, {
      ...selected,
      mayUpgradeOwnedServer: false,
    }),
    ...(isNodeScriptRunner(selected.runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    selectedVersion: selected.version,
    requestedVersion: selected.requestedVersion,
    source: selected.source,
    ...sshTargetLogFields(target),
    stateKey,
  });
  return {
    credential: parsed.credential,
  };
});

export const issueRemoteMcpClientSession = Effect.fn("ssh/tunnel.issueRemoteMcpClientSession")(
  function* (
    target: DesktopSshEnvironmentTarget,
    sessionOptions: RemoteMcpClientSessionOptions,
    input?: SshAuth.SshAuthOptions,
    runner?: RemoteGoatRunnerOptions,
    prepared?: PreparedRemoteRuntime,
  ): Effect.fn.Return<
    RemoteMcpClientSession,
    SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
  > {
    const stateKey = REMOTE_RUNTIME_STATE_KEY;
    const selected =
      prepared ??
      (yield* prepareRemoteRuntime(
        target,
        input ?? {},
        { ...runner, keepExistingRunner: true },
        stateKey,
      ));
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s"],
      timeoutStage: "pairing",
      stdin: buildRemoteMcpSessionScript(stateKey, sessionOptions, selected.runner, {
        ...selected,
        mayUpgradeOwnedServer: false,
      }),
      // Like pairing, this may be the first command on a cold remote.
      ...(isNodeScriptRunner(selected.runner)
        ? {}
        : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    }).pipe(
      Effect.catchTags({
        SshCommandError: (error) =>
          Effect.fail(
            memoryScopesUnsupportedError(
              error.stdout ?? "",
              target.alias,
              `Stop it on the remote host when its work is done, then reconnect so ${
                selected.requestedVersion ? `GOAT ${selected.requestedVersion}` : "this app's GOAT"
              } replaces it.`,
            ) ?? error,
          ),
      }),
    );
    const session = yield* decodeRemoteMcpSessionOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshPairingError({
            message: "The remote GOAT CLI did not return an MCP session.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (session.token.trim().length === 0) {
      return yield* new SshPairingError({
        message: "The remote GOAT CLI returned an empty MCP session token.",
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.mcpSession.issued", {
      selectedVersion: selected.version,
      requestedVersion: selected.requestedVersion,
      source: selected.source,
      ...sshTargetLogFields(target),
      stateKey,
      runtimeModeCeilingApplied: session.runtimeModeCeilingApplied,
    });
    return session;
  },
);

export const issueRemoteClientSession = Effect.fn("ssh/tunnel.issueRemoteClientSession")(function* (
  target: DesktopSshEnvironmentTarget,
  sessionOptions: RemoteClientSessionOptions,
  input?: SshAuth.SshAuthOptions,
  runner?: RemoteGoatRunnerOptions,
  prepared?: PreparedRemoteRuntime,
): Effect.fn.Return<
  RemoteClientSession,
  SshCommandError | SshInvalidTargetError | SshPairingError | SshLaunchError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const stateKey = REMOTE_RUNTIME_STATE_KEY;
  const selected =
    prepared ??
    (yield* prepareRemoteRuntime(
      target,
      input ?? {},
      { ...runner, keepExistingRunner: true },
      stateKey,
    ));
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    timeoutStage: "pairing",
    stdin: buildRemoteClientSessionScript(stateKey, sessionOptions, selected.runner, {
      ...selected,
      mayUpgradeOwnedServer: false,
    }),
    ...(isNodeScriptRunner(selected.runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  const session = yield* decodeRemoteClientSessionOutput(result.stdout, sessionOptions.scopes);
  yield* Effect.logInfo("ssh.remoteServer.clientSession.issued", {
    selectedVersion: selected.version,
    requestedVersion: selected.requestedVersion,
    source: selected.source,
    ...sshTargetLogFields(target),
    stateKey,
  });
  return session;
});

const stopRemoteServer = Effect.fn("ssh/tunnel.stopRemoteServer")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions & { readonly ownedOnly?: boolean },
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const stateKey = REMOTE_RUNTIME_STATE_KEY;
  yield* Effect.logInfo("ssh.remoteServer.stop.start", {
    ...sshTargetLogFields(target),
    stateKey,
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteStopScript(stateKey, { ownedOnly: input?.ownedOnly === true }),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  }).pipe(
    Effect.tapError((cause) =>
      Effect.logWarning("ssh.remoteServer.stop.failed", {
        ...sshTargetLogFields(target),
        stateKey,
        message: cause.message,
      }),
    ),
  );
  const preserved = /"stopped":false,"activity":"(busy|unknown)"/.exec(result.stdout)?.[1];
  if (preserved !== undefined) {
    yield* Effect.logInfo("ssh.remoteServer.stop.preserved", {
      ...sshTargetLogFields(target),
      stateKey,
      activity: preserved,
    });
    return;
  }
  yield* Effect.logInfo("ssh.remoteServer.stop.succeeded", {
    ...sshTargetLogFields(target),
    stateKey,
  });
});

const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuth.SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(REMOTE_RUNTIME_STATE_KEY),
    timeoutMs: 10_000,
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  return result.stdout.trim();
});

export interface SshReadinessBudget {
  /** Bound on the first forwarded probe; each timed-out probe doubles it up to 5 s. */
  readonly probeTimeoutMs: number;
  /** Overall wait for the forward to answer. */
  readonly timeoutMs: number;
}

/**
 * Readiness budget for a forward to a host whose remote launch took `launchMs`.
 * A launch is one SSH connection plus several remote round trips, so a quarter
 * of it estimates one forwarded HTTP exchange. A fast host keeps the 1 s / 20 s
 * defaults; a slow link gets longer probes and up to 60 s overall.
 */
export function sshReadinessBudget(launchMs: number): SshReadinessBudget {
  const clamp = (value: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.ceil(Number.isFinite(value) ? value : 0)));
  return {
    probeTimeoutMs: clamp(launchMs / 4, SSH_READY_PROBE_TIMEOUT_MS, SSH_READY_MAX_PROBE_TIMEOUT_MS),
    timeoutMs: clamp(launchMs * 5, SSH_READY_TIMEOUT_MS, SSH_READY_MAX_TIMEOUT_MS),
  };
}

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly maxProbeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    maxProbeTimeoutMs: input.maxProbeTimeoutMs ?? SSH_READY_MAX_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            reason: "slow",
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly attempts: number;
            readonly probeTimeouts: number;
            readonly otherFailures: number;
            readonly lastProbeTimeoutMs: number;
            readonly lastFailure: unknown;
          };
          // Every check timing out means requests reached a server that answered
          // too late; refused or failed checks mean nothing answered at all.
          const slow = overall.probeTimeouts > 0 && overall.otherFailures === 0;
          return new SshReadinessError({
            reason: slow ? "slow" : "unreachable",
            message: slow
              ? `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}. The SSH tunnel is open, but the GOAT server answered none of ${overall.attempts} checks within ${overall.lastProbeTimeoutMs}ms. The network to this host is too slow (high latency); GOAT will keep retrying.`
              : `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}. The GOAT server did not answer through the SSH tunnel; it may have stopped on the remote host.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        reason: "unreachable",
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }
        const baseUrl = new URL(rawHttpBaseUrl);
        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }
        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService.NetService;
  return yield* net.reserveLoopbackPort();
});

/**
 * Liveness check for an open forward. On a slow link a healthy forward needs
 * longer than the fast-host window, or every reconnect would tear it down, so
 * the window covers at least two of the forward's own probes.
 */
const existingTunnelCheck = (entry: SshTunnelEntry, minimumMs: number) => ({
  baseUrl: entry.httpBaseUrl,
  timeoutMs: Math.max(minimumMs, entry.readiness.probeTimeoutMs * 2),
  probeTimeoutMs: entry.readiness.probeTimeoutMs,
});

const startSshTunnelAttempt = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly selectedRuntime: PreparedRemoteRuntime;
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuth.SshAuthOptions;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly scope: Scope.Closeable;
  readonly readiness: SshReadinessBudget;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* SshAuth.buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.provideService(Scope.Scope, input.scope),
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  let master = yield* healthySshMaster(input.resolvedTarget);
  const platform = yield* HostProcess.Platform;
  const args = [
    ...SSH_DIAGNOSTIC_ARGS,
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    ...SSH_KEEPALIVE_ARGS,
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    "--",
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const authDirectory = ownedAuthDirectory(childEnvironment.SSH_ASKPASS);
  const tunnelCommand = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { scope } = input;
  yield* Effect.logDebug("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    httpBaseUrl: input.httpBaseUrl,
  });
  if (master !== undefined) {
    const connection = master;
    const forward = `${input.localPort}:127.0.0.1:${input.remotePort}`;
    const added = yield* runSshCommand(input.resolvedTarget, {
      ...input.authOptions,
      preHostArgs: [
        "-S",
        connection.socket,
        "-O",
        "forward",
        "-o",
        "ExitOnForwardFailure=yes",
        "-L",
        forward,
      ],
      timeoutMs: 5_000,
    }).pipe(Effect.result);
    if (added._tag === "Failure") {
      yield* Scope.close(connection.scope, Exit.void);
      master = undefined;
    } else {
      const services = yield* Effect.context<
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      >();
      yield* Scope.addFinalizer(
        scope,
        runSshCommand(input.resolvedTarget, {
          ...input.authOptions,
          preHostArgs: ["-S", connection.socket, "-O", "cancel", "-L", forward],
          timeoutMs: 2_000,
        }).pipe(Effect.provideContext(services), Effect.ignore),
      );
    }
  }
  const child =
    master !== undefined
      ? { ...master.process, stderr: Stream.empty, kill: () => Effect.void }
      : yield* spawner
          .spawn(
            makeOwnedSshTunnelCommand(
              platform,
              sshCommand,
              args,
              {
                // Spawn can be interrupted before the handle's explicit kill finalizer is installed.
                forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
                env: childEnvironment,
                extendEnv: true,
                stdin: {
                  stream: Stream.empty,
                  endOnDone: true,
                },
              },
              authDirectory,
            ),
          )
          .pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new SshCommandError({
                  command: tunnelCommand,
                  exitCode: null,
                  stderr: "",
                  message:
                    cause instanceof Error
                      ? cause.message
                      : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
                  cause,
                }),
            ),
          );
  const cost = yield* SshReconnectCost;
  if (cost?.active && master === undefined) cost.spawns++;
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    ...(master === undefined ? {} : { master }),
    selectedRuntime: input.selectedRuntime,
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
    readiness: input.readiness,
  };
  // Readiness cancels the exit waiter, but diagnostics must drain until the tunnel closes.
  let stderrTail = "";
  const stderrDrain = yield* sshDiagnosticChunks(child.stderr).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        stderrTail = (stderrTail + chunk).slice(-TUNNEL_STDERR_TAIL_CHARS);
      }),
    ),
    // Diagnostics are best-effort: a failed read must not hide the real exit.
    Effect.ignore,
    Effect.forkIn(scope),
  );
  const exitFailure = Effect.all(
    [Fiber.join(stderrDrain), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([, exitCode]) => {
      const stderr = stderrTail;
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      });
      return Effect.logWarning("ssh.tunnel.process.exited", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: input.readiness.timeoutMs,
      probeTimeoutMs: input.readiness.probeTimeoutMs,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const processRunningExit = yield* Effect.exit(child.isRunning);
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, "127.0.0.1"),
        );
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, input.authOptions),
        );
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null;
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null;
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null;
        yield* Effect.logWarning("ssh.tunnel.ready.failed", {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          readiness: input.readiness,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        });
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const startSshTunnel = (input: Parameters<typeof startSshTunnelAttempt>[0]) =>
  measureSshReconnectStep("ssh/tunnel.startSshTunnel", startSshTunnelAttempt(input));

function archiveFailure(error: SshLaunchError): SshHostFailure | undefined {
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

// A timeout headline and a local proxy diagnosis outrank incidental warnings
// and OpenSSH's trailing generic closure. Only one sanitized line is public.
function publicSshDiagnostic(error: SshEnvironmentEffectError) {
  return (
    sshFailureDiagnostic(
      error.message,
      error instanceof SshCommandError ? error.stderr : error.message,
    )
      // oxlint-disable-next-line no-control-regex -- strips ANSI escape sequences
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, "$1[redacted]@")
      .replace(
        /((?:token|password|secret|credential|authorization|api[_-]?key)[\w-]*[\s"']*[:=][\s"']*)[^\s"'&,;]+/giu,
        "$1[redacted]",
      )
      .replace(
        /((?:--)?(?:token|password|secret|credential|api[_-]?key)[\w-]*\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/giu,
        "$1[redacted]",
      )
      .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
      .replace(/\b(?:sk-|gh[opusr]_|github_pat_)[A-Za-z0-9_-]+/gu, "[redacted]")
      .slice(0, 500)
  );
}

function runtimeFailureResult(
  host: string,
  requestedVersion: string,
  runtimeVersion: string | null,
  error: SshEnvironmentEffectError,
): SshHostResult {
  const base = { host, requestedVersion, runtimeVersion };
  const diagnostic = publicSshDiagnostic(error);
  const evidence = error instanceof SshCommandError ? error.stderr : error.message;
  const failed = (failure: SshHostFailure): SshHostResult => ({
    kind: "ok",
    status: { ...base, state: "failed", failure },
  });
  if (error instanceof SshLaunchError) {
    const failure = archiveFailure(error);
    if (failure !== undefined) return failed(failure);
    if (error.reason === "runtime-newer") {
      return { kind: "ok", status: { ...base, state: "update_blocked", detail: diagnostic } };
    }
  }
  if (/cannot open its data because a newer GOAT build already upgraded it/iu.test(diagnostic)) {
    return {
      kind: "ok",
      status: {
        ...base,
        state: "failed",
        detail: diagnostic,
        failure: {
          reason: "operation_failed",
          fix: {
            actor: "human",
            instruction: `Update this app or the GOAT runtime on ${host}, then reconnect.`,
          },
        },
      },
    };
  }
  const source = `${error.message}\n${evidence}`;
  const proxy = sshLocalProxyFailure(source);
  if (proxy !== undefined) {
    return {
      kind: "error",
      code: "operation_failed",
      message: `${host}: ${diagnostic}`,
      fix: { actor: "human", instruction: proxy.fix },
    };
  }
  if (
    /REMOTE HOST IDENTIFICATION HAS CHANGED|host key.*changed|offending .* key/iu.test(evidence)
  ) {
    return failed({
      reason: "host_key_changed",
      fix: {
        actor: "human",
        instruction: "Forget the host, then add it again to review its new fingerprint.",
        path: "ssh.host_forget",
      },
    });
  }
  if (
    /host key verification failed|no .* host key is known|authenticity of host/iu.test(evidence)
  ) {
    return { kind: "ok", status: { ...base, state: "untrusted", detail: diagnostic } };
  }
  if (
    error instanceof SshPasswordPromptError ||
    sshAuthenticationFailure(source) !== undefined ||
    /permission denied|authentication failed|SSH authentication timed out for /iu.test(diagnostic)
  ) {
    return { kind: "ok", status: { ...base, state: "auth_failed", detail: diagnostic } };
  }
  if (
    error instanceof SshReadinessError ||
    /GOAT.*(?:did not become ready|(?:start|launch).*timed out)/iu.test(diagnostic)
  ) {
    return failed({ reason: "start_timeout", fix: { actor: "agent", instruction: "Try again" } });
  }
  if (/Remote host .+ has no GOAT release archive\./iu.test(diagnostic)) {
    return failed({
      reason: "unsupported_platform",
      fix: { actor: "human", instruction: "Use Linux, an Apple Silicon Mac, or Windows." },
    });
  }
  if (
    /Remote host is missing node on PATH|Install shasum or sha256sum|Remote host needs curl or wget|tar(?:\.exe)?:.*(?:not found|not recognized)|[/\\]tar\.exe:\s*No such file or directory|'sh' is not recognized as an internal or external command|\bsh\s*:\s*The term 'sh' is not recognized/iu.test(
      source,
    )
  ) {
    const instruction = /missing node/iu.test(source)
      ? `Install Node on ${host} for the source runtime, then try again.`
      : /curl or wget/iu.test(source)
        ? `Install curl or wget on ${host}, then try again.`
        : /'sh' is not recognized|\bsh\s*:\s*The term 'sh' is not recognized/iu.test(source)
          ? `Install Git for Windows on ${host} and set Git Bash as the OpenSSH DefaultShell, then try again.`
          : /tar(?:\.exe)?:/iu.test(source)
            ? `Install tar on ${host}, then try again.`
            : `Install sha256sum (coreutils) on ${host}, then try again.`;
    return failed({ reason: "missing_tools", fix: { actor: "human", instruction } });
  }
  return {
    kind: "error",
    code:
      error instanceof SshCommandError && isSshHostUnreachable(source)
        ? "host_unreachable"
        : "operation_failed",
    message: `${host}: ${diagnostic}`,
    fix: { actor: "agent", instruction: "Try again" },
  };
}

const withSshCost = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  message: string,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const current = yield* SshReconnectCost;
    if (current?.active) return yield* effect;
    const cost = {
      active: true,
      spawns: 0,
      authentications: 0,
      mastersStarted: 0,
      controlCommands: 0,
      steps: {},
    };
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* effect.pipe(
      Effect.provideService(SshReconnectCost, cost),
      Effect.ensuring(
        Effect.gen(function* () {
          const wallMs = (yield* Clock.currentTimeMillis) - startedAt;
          // A retained tunnel's diagnostic drain must not mutate an already emitted summary.
          cost.active = false;
          yield* Effect.logInfo(message).pipe(
            Effect.annotateLogs({
              spawns: cost.spawns,
              authentications: cost.authentications,
              mastersStarted: cost.mastersStarted,
              controlCommands: cost.controlCommands,
              wallMs,
              steps: cost.steps,
            }),
          );
        }),
      ),
    );
  });

const withReconnectCost = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  withSshCost(effect, "ssh.reconnect.cost");

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const sharing = {
    configurations: new Map<string, string>(),
    masters: new Map<string, SshMasterConnection>(),
  };
  const tunnels = new Map<string, SshTunnelEntry>();
  // One slot per target, consumed by the next ensure attempt.
  const reconnectSelections = new Map<string, ReconnectSelection>();
  const selectionRevisions = new Map<string, number>();
  const takeReconnectSelection = (key: string) => {
    const selection = reconnectSelections.get(key);
    reconnectSelections.delete(key);
    return selection;
  };
  const invalidateReconnectSelection = (key: string) => {
    selectionRevisions.set(key, (selectionRevisions.get(key) ?? 0) + 1);
    reconnectSelections.delete(key);
    const entry = tunnels.get(key);
    if (entry !== undefined) delete entry.reconnectSelection;
    const intent = pendingReplacements.get(key);
    if (intent !== undefined) intent.reconnectSelection = undefined;
  };
  interface Attachment {
    readonly id: string;
    readonly operationId: string;
    readonly generation: number;
    readonly selection: PreparedRemoteRuntime;
    readonly localPort: number;
    readonly remotePort: number;
    readonly version: string | null;
    readonly pin: ManagedPin | undefined;
  }
  interface PreparedEnsure {
    readonly operationId: string;
    readonly key: string;
    readonly generation: number;
    readonly runner: RemoteGoatRunnerOptions | undefined;
    readonly result: SshTunnelEntry | DesktopSshRuntimePendingResult;
    readonly attachment?: Attachment;
  }
  const attachments = new WeakMap<SshTunnelEntry, Attachment>();
  const flights = yield* makeEnsureFlights<PreparedEnsure, SshEnvironmentEffectError>({
    scope: managerScope,
  });
  const firstConnectionDecisions = new Set<string>();
  const generations = new Map<string, number>();
  const resolvedTargets = new Map<string, DesktopSshEnvironmentTarget>();
  const statuses = new Map<string, SshHostResult>();
  const acquisitionFailures = new Map<string, SshHostFailure>();
  const setupOperations = new Map<
    string,
    SshHostSetupProgress & { readonly diagnosisRequired?: boolean }
  >();
  const forgotten = new Set<string>();
  const setupFields = (key: string, stage?: SshHostSetupProgress["stage"]) => {
    const previous = setupOperations.get(key);
    if (previous === undefined) return {};
    const setup = { ...previous, stage: stage ?? previous.stage };
    setupOperations.set(key, setup);
    return {
      setup: { operationId: setup.operationId, generation: setup.generation, stage: setup.stage },
    };
  };
  const managedAliases = new Set<string>();
  const observedPins = new Map<string, string>();
  const managedDirectory = Effect.gen(function* () {
    const path = yield* Path.Path;
    const env = yield* Config.all({
      home: Config.String("HOME").pipe(Config.option),
      profile: Config.String("USERPROFILE").pipe(Config.option),
    });
    const home = Option.getOrUndefined(env.home) ?? Option.getOrUndefined(env.profile);
    return home === undefined ? undefined : path.join(home, ".ssh", "goat-hosts");
  }).pipe(Effect.orElseSucceed(() => undefined));
  const pinError = (changed = false) =>
    new SshCommandError({
      command: ["ssh", "-G"],
      exitCode: null,
      message: changed
        ? "Managed SSH host key changed."
        : "Host key verification failed. Add this host again to review its fingerprint.",
      stderr: changed
        ? "Managed SSH host key changed."
        : "Host key verification failed. Add this host again to review its fingerprint.",
    });
  const readManagedPin = Effect.fn("ssh/tunnel.readManagedPin")(
    function* (target: DesktopSshEnvironmentTarget) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(target.alias)) return undefined;
      const directory = yield* managedDirectory;
      if (directory === undefined) return undefined;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const confPath = path.join(directory, `${target.alias}.conf`);
      if (!(yield* fs.exists(confPath))) {
        if (managedAliases.has(target.alias)) return yield* pinError();
        return undefined;
      }
      managedAliases.add(target.alias);
      for (const file of [
        directory,
        confPath,
        path.join(directory, `${target.alias}.known_hosts`),
      ]) {
        const linked = yield* fs.readLink(file).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        if (linked) return yield* pinError();
      }
      const conf = yield* fs.readFileString(confPath);
      const knownHostsFile = path.join(directory, `${target.alias}.known_hosts`);
      const pin = (yield* fs.readFileString(knownHostsFile)).trim();
      const parts = pin.split(/\s+/u);
      if (
        parts.length !== 3 ||
        parts[0] !== target.alias ||
        !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/u.test(parts[1]!) ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(parts[2]!)
      )
        return yield* pinError();
      const stat = yield* fs.stat(confPath);
      const mtime = Option.getOrUndefined(stat.mtime);
      if (mtime === undefined) return yield* pinError();
      const crypto = yield* Crypto.Crypto;
      const digest = yield* crypto.digest("SHA-256", Buffer.from(parts[2]!, "base64"));
      return {
        alias: target.alias,
        confMtimeMs: mtime.getTime(),
        fingerprint: `SHA256:${Buffer.from(digest).toString("base64").replace(/=+$/u, "")}`,
        conf,
        knownHostsFile,
        algorithm: parts[1]!,
      };
    },
    Effect.mapError((error) => (error instanceof SshCommandError ? error : pinError())),
  );
  type ManagedPin = NonNullable<Effect.Success<ReturnType<typeof readManagedPin>>>;
  const reconnectIdentity = (
    target: DesktopSshEnvironmentTarget,
    runner: RemoteGoatRunnerOptions | undefined,
    pin: ManagedPin | undefined,
  ) =>
    JSON.stringify([
      targetConnectionKey(target),
      sharing.configurations.get(target.alias),
      pin,
      runner?.archiveVersion?.trim(),
      runner?.archiveCommitTime,
      runner?.nodeScriptPath,
      runner?.keepExistingRunner === true,
    ]);
  const samePin = (left: ManagedPin | undefined, right: ManagedPin | undefined) =>
    left === undefined
      ? right === undefined
      : right !== undefined &&
        left.alias === right.alias &&
        left.fingerprint === right.fingerprint &&
        left.confMtimeMs === right.confMtimeMs &&
        left.conf === right.conf;
  const validateManagedPin = Effect.fn("ssh/tunnel.validateManagedPin")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const pin = yield* readManagedPin(target);
    if (pin === undefined) return undefined;
    const output = yield* runSshCommand(target, {
      preHostArgs: ["-G"],
      batchMode: "yes",
      interactiveAuth: false,
    });
    const values = new Map<string, string[]>();
    for (const line of output.stdout.split(/\r?\n/u)) {
      const [name, ...rest] = line.trim().split(/\s+/u);
      if (name)
        values.set(name.toLowerCase(), [...(values.get(name.toLowerCase()) ?? []), rest.join(" ")]);
    }
    const value = (name: string) => values.get(name)?.[0];
    const confValue = (name: string) =>
      new RegExp(`^\\s*${name}\\s+(.+)$`, "imu").exec(pin.conf)?.[1]?.replace(/^"|"$/gu, "");
    const algorithms = pin.algorithm === "ssh-rsa" ? "rsa-sha2-512,rsa-sha2-256" : pin.algorithm;
    if (
      value("hostkeyalias") !== target.alias ||
      value("userknownhostsfile") !== pin.knownHostsFile ||
      value("globalknownhostsfile") !== "/dev/null" ||
      !["yes", "true"].includes(value("stricthostkeychecking") ?? "") ||
      !["no", "false"].includes(value("updatehostkeys") ?? "") ||
      value("hostkeyalgorithms") !== algorithms ||
      (confValue("ProxyJump") !== undefined && value("proxyjump") !== confValue("ProxyJump")) ||
      (confValue("ProxyCommand") !== undefined &&
        value("proxycommand") !== confValue("ProxyCommand")) ||
      value("hostname") !== confValue("HostName") ||
      value("port") !== confValue("Port") ||
      value("user") !== confValue("User") ||
      (confValue("IdentityFile") !== undefined &&
        (value("identityfile") !== confValue("IdentityFile") ||
          !["yes", "true"].includes(value("identitiesonly") ?? "")))
    )
      return yield* pinError();
    const previous = observedPins.get(pin.alias);
    if (previous !== undefined && previous !== pin.fingerprint) return yield* pinError(true);
    observedPins.set(pin.alias, pin.fingerprint);
    return pin;
  });
  const enrichFailure = Effect.fn("ssh/tunnel.enrichFailure")(function* (
    target: DesktopSshEnvironmentTarget,
    result: SshHostResult,
  ) {
    if (result.status?.failure?.reason === "missing_tools") {
      const snapshot = result.status;
      const failure = snapshot.failure!;
      const tools = failure.fix.instruction.includes("curl")
        ? "curl"
        : failure.fix.instruction.includes("Node")
          ? "nodejs"
          : failure.fix.instruction.includes("Install tar")
            ? "tar"
            : "coreutils";
      const probe = yield* runSshCommand(target, {
        batchMode: "yes",
        interactiveAuth: false,
        preHostArgs: ["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"],
        remoteCommandArgs: ["sh", "-s"],
        timeoutMs: 10_000,
        stdin:
          "GOAT_TOOL_FIX_PROBE=1\nid -u\nuname -s\nif [ -r /etc/os-release ]; then cat /etc/os-release; fi\n",
      }).pipe(Effect.option);
      if (Option.isSome(probe)) {
        const [uid, os, ...release] = probe.value.stdout.trim().split(/\r?\n/u);
        const id = /^ID=["']?([a-z0-9-]+)["']?$/mu.exec(release.join("\n"))?.[1];
        const command =
          uid === "0" && os === "Linux"
            ? id === "debian" || id === "ubuntu"
              ? `apt-get update && apt-get install -y ${tools}`
              : id === "alpine"
                ? `apk add ${tools}`
                : id === "fedora" || id === "rhel" || id === "rocky"
                  ? `dnf install -y ${tools}`
                  : undefined
            : undefined;
        if (command !== undefined)
          return {
            ...result,
            status: { ...snapshot, failure: { ...failure, fix: { ...failure.fix, command } } },
          };
      }
      return result;
    }
    if (
      result.status?.state !== "auth_failed" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(target.alias)
    )
      return result;
    // Expose only GOAT's generated public key; an arbitrary IdentityFile is never disclosed.
    const directory = yield* managedDirectory;
    if (directory === undefined) return result;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const name of ["goat-hosts", "goat-cloud"]) {
      const dir = path.join(path.dirname(directory), name);
      const conf = yield* fs
        .readFileString(path.join(dir, `${target.alias}.conf`))
        .pipe(Effect.orElseSucceed(() => ""));
      const identity = /^\s*IdentityFile\s+"?(.+?)"?\s*$/imu.exec(conf)?.[1];
      if (identity === undefined) continue;
      const expandedIdentity = identity.replace(
        /^~(?=[/\\])/u,
        path.dirname(path.dirname(directory)),
      );
      const publicPath = expandedIdentity.endsWith(".pub")
        ? expandedIdentity
        : `${expandedIdentity}.pub`;
      const linked = yield* fs.readLink(publicPath).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (linked) continue;
      const key = (yield* fs
        .readFileString(publicPath)
        .pipe(Effect.orElseSucceed(() => ""))).trim();
      if (
        !/^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}( .*)?$/u.test(
          key,
        )
      )
        continue;
      const generatedKey = expandedIdentity === path.join(dir, "id_ed25519");
      const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
      const resolved =
        known.username === null
          ? yield* resolveSshTarget(target.alias, target).pipe(Effect.option)
          : Option.none();
      const user =
        /^\s*User\s+(.+?)\s*$/imu.exec(conf)?.[1] ??
        known.username ??
        (Option.isSome(resolved) ? resolved.value.username : null);
      const port = Number(
        /^\s*Port\s+(\d+)\s*$/imu.exec(conf)?.[1] ??
          known.port ??
          (Option.isSome(resolved) ? resolved.value.port : null) ??
          22,
      );
      if (user === null) {
        if (generatedKey) return { ...result, status: { ...result.status, publicKey: key } };
        continue;
      }
      const keyAuth = buildSshKeyAuthInstructions({
        originLabel: "the computer that owns this SSH connection",
        host: target.alias,
        user,
        port,
        publicKeyPath: publicPath,
        generatedKey,
        ...(generatedKey ? { publicKey: key } : {}),
      });
      return {
        ...result,
        status: { ...result.status, ...(generatedKey ? { publicKey: key } : {}), keyAuth },
      };
    }
    return result;
  });
  const setupTerminalFailure = (key: string) => {
    const current = statuses.get(key)?.status;
    return (
      current?.setup?.stage === "complete" &&
      current.state === "failed" &&
      [
        "diagnosis_failed",
        "approval_expired",
        "authorization_revoked",
        "operation_failed",
      ].includes(current.failure?.reason ?? "")
    );
  };
  const publishPhase = (
    key: string,
    target: DesktopSshEnvironmentTarget,
    requestedVersion: string,
    phase: SshRuntimePhase,
    onPhase?: SshRuntimeProgressCallback,
    upload?: SshHostStatus["upload"],
  ) => {
    if (setupTerminalFailure(key)) return;
    const previous = statuses.get(key);
    const previousUpload = previous?.status?.upload;
    if (
      upload !== undefined &&
      previousUpload !== undefined &&
      upload.totalBytes === previousUpload.totalBytes &&
      upload.sentBytes >= previousUpload.sentBytes &&
      upload.sentBytes - previousUpload.sentBytes < 1024 * 1024 &&
      upload.sentBytes !== upload.totalBytes
    )
      return;
    statuses.set(key, {
      kind: "ok",
      status: {
        host: target.alias || target.hostname,
        requestedVersion,
        runtimeVersion: previous?.status?.runtimeVersion ?? null,
        state: "preparing",
        phase,
        ...(upload === undefined ? {} : { upload }),
        ...setupFields(key, "runtime"),
      },
    });
    notifyRuntimePhase(target, phase, onPhase, upload);
  };
  const deferredArchiveRefresh = (requestedVersion: string) => ({
    reason: "archive_unavailable" as const,
    requestedVersion,
    detail: `Upgrade to ${requestedVersion} deferred`,
  });
  const deferredDrainRefresh = (requestedVersion: string) => ({
    reason: "archive_unavailable" as const,
    refreshCause: "drain_unavailable" as const,
    requestedVersion,
    detail: "Refresh deferred: this runtime could not drain for the refresh",
  });
  const publishResult = Effect.fn("ssh/tunnel.publishResult")(function* (
    key: string,
    target: DesktopSshEnvironmentTarget,
    result: SshTunnelEntry | DesktopSshRuntimePendingResult,
    runner?: RemoteGoatRunnerOptions,
  ) {
    if (closed || setupTerminalFailure(key)) return;
    const generation = generations.get(key) ?? 0;
    const intent = pendingReplacements.get(key);
    const pending = "type" in result ? result.pending : intent?.pending;
    const host = target.alias || target.hostname;
    const runtimeVersion =
      "type" in result ? result.pending.liveVersion : result.selectedRuntime.version;
    const requestedVersion = pending?.requestedVersion ?? runner?.archiveVersion?.trim() ?? "";
    const base = { host, runtimeVersion, requestedVersion };
    const observed = statuses.get(key);
    const drainAttached =
      !("type" in result) &&
      result.attachmentInvalidated !== true &&
      result.uncertainDrain !== true &&
      pending?.refreshCause === "drain_unavailable" &&
      (pending.replacement === "older" || pending.replacement === "capability") &&
      pending.liveVersion === runtimeVersion &&
      result.selectedRuntime.requestedVersion === requestedVersion &&
      intent?.requestedRunner.archiveVersion?.trim() === requestedVersion &&
      intent.generation === generation &&
      tunnels.get(key) === result &&
      (yield* result.process.isRunning.pipe(Effect.orElseSucceed(() => false)));
    if (
      closed ||
      (generations.get(key) ?? 0) !== generation ||
      pendingReplacements.get(key) !== intent ||
      (!("type" in result) && tunnels.get(key) !== result) ||
      (drainAttached &&
        (result.attachmentInvalidated === true || statuses.get(key) !== observed)) ||
      setupTerminalFailure(key)
    )
      return;
    let snapshot: SshHostStatus;
    if (drainAttached) {
      const refreshDeferred = deferredDrainRefresh(requestedVersion);
      snapshot = { ...base, state: "ready", refreshDeferred, detail: refreshDeferred.detail };
      acquisitionFailures.delete(key);
    } else if (pending !== undefined) {
      const detail =
        pending.detail === "recovery-stale"
          ? "Check that no other GOAT client is updating this host before clearing the stale lock."
          : pending.reason === "contended"
            ? `Another computer is updating ${host}. GOAT will retry.`
            : pending.reason === "unknown"
              ? `GOAT can't tell whether ${host} is busy. It retries every 10 minutes.`
              : `Update to ${requestedVersion} waits for running work`;
      snapshot = { ...base, state: "update_waiting", waitingReason: pending.reason, detail };
    } else if (!("type" in result) && result.selectedRuntime.upgradeFailure !== undefined) {
      const refreshDeferred = deferredArchiveRefresh(requestedVersion);
      snapshot = { ...base, state: "ready", refreshDeferred, detail: refreshDeferred.detail };
      acquisitionFailures.set(key, result.selectedRuntime.upgradeFailure);
    } else if (!("type" in result) && result.selectedRuntime.updateBlocked !== undefined) {
      snapshot = { ...base, state: "update_blocked", detail: result.selectedRuntime.updateBlocked };
    } else {
      snapshot = { ...base, state: "ready" };
      if (runtimeVersion === requestedVersion) acquisitionFailures.delete(key);
    }
    const setup = setupOperations.get(key);
    const providers = statuses.get(key)?.status?.providers;
    if (snapshot.state === "ready" && setup?.stage === "complete" && providers !== undefined)
      snapshot = {
        ...snapshot,
        state: providers.ready ? "ready" : "providers_not_ready",
        providers,
      };
    snapshot = {
      ...snapshot,
      ...setupFields(
        key,
        snapshot.state === "ready" &&
          setup?.stage !== "complete" &&
          setup?.diagnosisRequired !== false
          ? "diagnosis"
          : "complete",
      ),
    };
    statuses.set(key, { kind: "ok", status: snapshot });
  });
  const publishFailure = Effect.fn("ssh/tunnel.publishFailure")(function* (
    key: string,
    target: DesktopSshEnvironmentTarget,
    runner: RemoteGoatRunnerOptions | undefined,
    error: SshEnvironmentEffectError,
  ) {
    if (error instanceof SshEnsureSupersededError) return;
    const generation = generations.get(key) ?? 0;
    let result = runtimeFailureResult(
      target.alias || target.hostname,
      runner?.archiveVersion?.trim() ?? "",
      statuses.get(key)?.status?.runtimeVersion ?? null,
      error,
    );
    if (
      result.status?.failure?.reason === "archive_unavailable" ||
      result.status?.failure?.reason === "unsupported_platform"
    )
      acquisitionFailures.set(key, result.status.failure);
    result = yield* enrichFailure(target, result);
    if (closed || (generations.get(key) ?? 0) !== generation) return;
    if (result.status !== undefined)
      result = { ...result, status: { ...result.status, ...setupFields(key, "complete") } };
    statuses.set(key, result);
  });
  // A disconnect waits on the target lock, then acts on the completed launch result.
  const cancelledLaunches = new Map<string, boolean>();
  const pendingReplacements = new Map<
    string,
    {
      target: DesktopSshEnvironmentTarget;
      requestedRunner: RemoteGoatRunnerOptions;
      generation: number;
      managedPin?: ManagedPin;
      nextAttemptAt: number;
      reconnectSelection: ReconnectSelection | undefined;
    } & (
      | { pending: SshRuntimePendingReplacement; archiveFailure?: never }
      | { pending?: never; archiveFailure: SshHostFailure }
    )
  >();
  const takePendingReconnectSelection = (key: string) => {
    const intent = pendingReplacements.get(key);
    const selection = intent?.reconnectSelection;
    if (intent !== undefined) intent.reconnectSelection = undefined;
    return selection;
  };
  let retryStarted = false;
  let closed = false;
  const pendingResult = (
    target: DesktopSshEnvironmentTarget,
    pending: SshRuntimePendingReplacement,
  ): DesktopSshRuntimePendingResult => ({
    type: "ssh-runtime-pending",
    target,
    pending,
  });
  const targetLocks = yield* KeyedLock.make<string>();
  const authSecrets = new Map<string, string>();
  // Ensure and disconnect requests for one target are ordered by arrival. Both
  // resolve the alias before taking the target lock, so a reconnect sent after a
  // disconnect can reach the lock first. Tickets let each request see whether a
  // newer one has replaced its intent: a disconnect yields to any newer request,
  // and an ensure yields to a newer disconnect.
  let requestSequence = 0;
  const latestRequest = new Map<string, number>();
  const latestDisconnect = new Map<string, number>();
  interface RequestTicket {
    readonly key: string;
    readonly sequence: number;
  }
  const takeRequestTicket = (target: DesktopSshEnvironmentTarget, kind: "ensure" | "disconnect") =>
    Effect.sync((): RequestTicket => {
      const key = targetConnectionKey(target);
      const sequence = ++requestSequence;
      latestRequest.set(key, sequence);
      if (kind === "disconnect") latestDisconnect.set(key, sequence);
      return { key, sequence };
    });
  const disconnectSuperseded = (ticket: RequestTicket) =>
    latestRequest.get(ticket.key) !== ticket.sequence;
  const ensureSuperseded = (ticket: RequestTicket) =>
    (latestDisconnect.get(ticket.key) ?? 0) > ticket.sequence;

  const lockUsers = new Map<string, number>();
  const releaseLockUser = (key: string) =>
    Effect.sync(() => {
      const count = lockUsers.get(key) ?? 0;
      if (count <= 1) lockUsers.delete(key);
      else lockUsers.set(key, count - 1);
    });
  // Count admission before any yield, so ready-only requests never queue behind installation.
  const withTargetLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        lockUsers.set(key, (lockUsers.get(key) ?? 0) + 1);
      }),
      () => targetLocks.withLock(key, effect),
      () => releaseLockUser(key),
    );
  const notReady = (target: DesktopSshEnvironmentTarget) =>
    new SshLaunchError({
      message: `Call goat_ssh_host_prepare for ${target.alias}, then call goat_ssh_host_status until setup completes; retry goat_provider_diagnose.`,
      stdout: "",
    });
  const withIdleTargetLock = <A, E, R>(
    key: string,
    target: DesktopSshEnvironmentTarget,
    effect: Effect.Effect<A, E, R>,
  ) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        if (lockUsers.has(key)) return false;
        lockUsers.set(key, 1);
        return true;
      }),
      (acquired): Effect.Effect<A, E | SshLaunchError, R> =>
        acquired ? targetLocks.withLock(key, effect) : Effect.fail(notReady(target)),
      (acquired) => (acquired ? releaseLockUser(key) : Effect.void),
    );

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    attachments.delete(entry);
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    if (entry.master !== undefined)
      yield* Scope.close(entry.master.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => {
      closed = true;
      reconnectSelections.clear();
      resolvedTargets.clear();
      statuses.clear();
      acquisitionFailures.clear();
      cancelledLaunches.clear();
      // Pending shutdown only closes local forwards; the remote may still be working.
      const entries = [...tunnels.values()];
      for (const key of pendingReplacements.keys()) tunnels.delete(key);
      pendingReplacements.clear();
      return entries;
    }).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<
    string,
    SshInvalidTargetError | SshPasswordPromptError,
    SshAuth.SshPasswordPrompt
  > {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password or verification code for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!SshAuth.isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      if (input.keyOnly === true) {
        return yield* new SshPasswordPromptError({
          message: `Key-based login failed for ${input.target.alias || input.target.hostname}; agents use only SSH keys or ssh-agent.`,
          cause: input.error,
        });
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshAuth.SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshAuth.SshPasswordPrompt;
    const authOptions =
      input.keyOnly === true
        ? { batchMode: "yes" as const, interactiveAuth: false }
        : input.authSecret === null
          ? {
              batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
              interactiveAuth: !promptService.isAvailable,
            }
          : {
              authSecret: input.authSecret,
              batchMode: "no" as const,
              interactiveAuth: true,
            };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: input.keyOnly === true ? null : (authSecrets.get(input.key) ?? null),
    });
  });

  const backgroundAuth = (key: string): SshAuth.SshAuthOptions => {
    const authSecret = authSecrets.get(key);
    return authSecret === undefined
      ? { batchMode: "yes", interactiveAuth: false }
      : { authSecret, batchMode: "no", interactiveAuth: true };
  };

  const createTunnel = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly keyOnly?: boolean;
    readonly runner?: RemoteGoatRunnerOptions;
    readonly previous?: SshTunnelEntry;
    readonly previousLocalPort?: number;
    readonly previousSelection?: ReconnectSelection;
    readonly background?: boolean;
    readonly onPhase?: SshRuntimeProgressCallback;
  }): Effect.fn.Return<
    SshTunnelEntry | DesktopSshRuntimePendingResult,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext | Scope.Scope
  > {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const generation = generations.get(input.key) ?? 0;
    const previousSelection =
      input.previousSelection?.revision === (selectionRevisions.get(input.key) ?? 0)
        ? input.previousSelection
        : undefined;
    invalidateReconnectSelection(input.key);
    const revision = selectionRevisions.get(input.key) ?? 0;
    const managedPin = yield* validateManagedPin(input.resolvedTarget);
    const identity = reconnectIdentity(input.resolvedTarget, input.runner, managedPin);
    if (closed || (generations.get(input.key) ?? 0) !== generation)
      return yield* supersededPreparation();
    const phase: SshRuntimeProgressCallback = ({ phase, upload }) => {
      // A background refresh of a host whose forward still works keeps its published status;
      // "preparing" would drop provider diagnosis and flap a healthy host every ten minutes.
      if (input.background === true && tunnels.has(input.key)) return;
      if (!closed && (generations.get(input.key) ?? 0) === generation) {
        publishPhase(
          input.key,
          input.resolvedTarget,
          input.runner?.archiveVersion?.trim() ?? "",
          phase,
          input.onPhase,
          upload,
        );
      }
    };
    const launchScope = yield* Scope.Scope;
    let launchTransferred = false;
    const operation = (authOptions: SshAuth.SshAuthOptions) =>
      Effect.gen(function* () {
        yield* ensureSshMaster(input.resolvedTarget, authOptions, managerScope);
        const currentPin = yield* readManagedPin(input.resolvedTarget);
        // Preparation is cancellable; launch registers cleanup before restoring interruption.
        return yield* Effect.interruptible(
          launchOrReuseRemoteServer(
            input.resolvedTarget,
            authOptions,
            input.runner,
            phase,
            (selectionRevisions.get(input.key) ?? 0) === revision &&
              previousSelection?.generation === (generations.get(input.key) ?? 0) &&
              previousSelection.identity ===
                reconnectIdentity(input.resolvedTarget, input.runner, currentPin)
              ? previousSelection.runtime
              : undefined,
            (launch) =>
              Effect.addFinalizer(() =>
                Effect.gen(function* () {
                  if (
                    launchTransferred ||
                    launch.status !== "ready" ||
                    launch.pending !== undefined ||
                    options.leaveRemoteServerRunning === true ||
                    pendingReplacements.has(input.key) ||
                    tunnels.has(input.key)
                  )
                    return;
                  yield* stopRemoteServer(input.resolvedTarget, authOptions).pipe(Effect.ignore);
                }),
              ).pipe(Effect.provideService(Scope.Scope, launchScope)),
          ),
        );
      });
    const launchStartedAt = yield* Clock.currentTimeMillis;
    const observedLaunch = yield* (
      input.background
        ? operation(backgroundAuth(input.key))
        : runWithSshAuth({
            key: input.key,
            keyOnly: input.keyOnly === true,
            target: input.resolvedTarget,
            operation,
          })
    ).pipe(
      Effect.catchTags({
        SshLaunchError: (error) => {
          if (error.reason === "runtime-newer") pendingReplacements.delete(input.key);
          return Effect.fail(error);
        },
        SshCommandError: (error) => {
          // A newer runtime appearing after preparation is refused by the pinned helper's shell guard.
          if (error.stderr.includes("Remote runtime is newer than this app; update the app."))
            pendingReplacements.delete(input.key);
          return Effect.fail(error);
        },
      }),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : Effect.sync(() => {
              const previous = input.previous ?? tunnels.get(input.key);
              if (previous !== undefined) {
                previous.uncertainDrain = true;
                attachments.delete(previous);
              }
            }),
      ),
    );
    const deferredIntent = pendingReplacements.get(input.key);
    const retainedPending = deferredIntent?.pending;
    const remoteLaunch =
      observedLaunch.status === "ready" &&
      observedLaunch.pending === undefined &&
      retainedPending !== undefined &&
      deferredIntent !== undefined &&
      deferredIntent.generation === generation &&
      observedLaunch.selectedRuntime.requestedVersion === retainedPending.requestedVersion &&
      observedLaunch.selectedRuntime.version === retainedPending.liveVersion &&
      observedLaunch.selectedRuntime.version !== retainedPending.requestedVersion &&
      observedLaunch.selectedRuntime.updateBlocked === undefined &&
      observedLaunch.selectedRuntime.upgradeFailure === undefined
        ? {
            ...observedLaunch,
            pending: retainedPending,
            selectedRuntime: {
              ...observedLaunch.selectedRuntime,
              reconnectPending: retainedPending,
            },
          }
        : observedLaunch;
    const currentPin = yield* readManagedPin(input.resolvedTarget).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    if (
      !closed &&
      (generations.get(input.key) ?? 0) === generation &&
      !samePin(managedPin, currentPin)
    ) {
      generations.set(input.key, (generations.get(input.key) ?? 0) + 1);
      invalidateReconnectSelection(input.key);
      pendingReplacements.delete(input.key);
      setupOperations.delete(input.key);
      const error = pinError(
        managedPin !== undefined &&
          currentPin !== undefined &&
          managedPin.fingerprint !== currentPin.fingerprint,
      );
      yield* publishFailure(input.key, input.resolvedTarget, input.runner, error);
      return yield* error;
    }
    // The launch round trip measures this link; the forward's readiness budget scales with it.
    const launchMs = (yield* Clock.currentTimeMillis) - launchStartedAt;
    if (closed || (generations.get(input.key) ?? 0) !== generation) {
      const stop = remoteLaunch.status === "ready" && remoteLaunch.pending === undefined;
      if (!closed) {
        cancelledLaunches.set(input.key, stop);
        launchTransferred = true;
      }
      return yield* supersededPreparation();
    }
    const archiveFailure =
      remoteLaunch.status === "ready" ? remoteLaunch.selectedRuntime.upgradeFailure : undefined;
    const needsArchiveRetry = archiveFailure?.reason === "archive_unavailable";
    if ((remoteLaunch.pending !== undefined || needsArchiveRetry) && input.runner !== undefined) {
      const previousIntent = pendingReplacements.get(input.key);
      const sameIntent =
        previousIntent !== undefined &&
        previousIntent.generation === generation &&
        previousIntent.requestedRunner.archiveVersion === input.runner.archiveVersion;
      const intent = {
        target: input.resolvedTarget,
        // A person's request stays manual on every retry, so the runtime never arbitrates it.
        requestedRunner: sameIntent
          ? {
              ...previousIntent.requestedRunner,
              ...(input.runner.manualRefresh === true ? { manualRefresh: true } : {}),
            }
          : { ...input.runner, confirmReplacement: false },
        generation,
        ...(managedPin === undefined ? {} : { managedPin }),
        nextAttemptAt: sameIntent
          ? previousIntent.nextAttemptAt
          : (yield* Clock.currentTimeMillis) + 600_000,
        reconnectSelection:
          remoteLaunch.status === "ready"
            ? { runtime: remoteLaunch.selectedRuntime, generation, revision, identity }
            : undefined,
      };
      if (remoteLaunch.pending !== undefined) {
        yield* Effect.logWarning("ssh.runtime.refresh.deferred", {
          ...sshTargetLogFields(input.resolvedTarget),
          liveVersion: remoteLaunch.pending.liveVersion,
          requestedVersion: remoteLaunch.pending.requestedVersion,
          reason: remoteLaunch.pending.reason,
          replacement: remoteLaunch.pending.replacement,
          detail: remoteLaunch.pending.detail,
          retryInMinutes: 10,
        });
        pendingReplacements.set(input.key, { ...intent, pending: remoteLaunch.pending });
      } else if (needsArchiveRetry) {
        yield* Effect.logWarning("ssh.runtime.refresh.deferred", {
          ...sshTargetLogFields(input.resolvedTarget),
          actualVersion:
            remoteLaunch.status === "ready" ? remoteLaunch.selectedRuntime.version : null,
          requestedVersion: archiveFailure.archive?.requestedVersion,
          reason: archiveFailure.reason,
          sourcesTried: archiveFailure.archive?.sourcesTried,
          retryInMinutes: 10,
        });
        pendingReplacements.set(input.key, { ...intent, archiveFailure });
      }
    }
    if (setupTerminalFailure(input.key)) pendingReplacements.delete(input.key);
    if (remoteLaunch.status === "pending") {
      const previous = input.previous ?? tunnels.get(input.key);
      if (previous !== undefined) {
        previous.attachmentInvalidated = true;
        attachments.delete(previous);
      }
      return pendingResult(input.resolvedTarget, remoteLaunch.pending);
    }
    const reconnectSelection = {
      runtime: remoteLaunch.selectedRuntime,
      generation,
      revision,
      identity,
    };
    if (
      input.previous !== undefined &&
      remoteLaunch.refresh !== "replaced" &&
      input.previous.remotePort === remoteLaunch.remotePort &&
      input.previous.selectedRuntime.version === remoteLaunch.selectedRuntime.version
    ) {
      if (remoteLaunch.pending === undefined && !needsArchiveRetry)
        pendingReplacements.delete(input.key);
      // Keep the forward's identity for its finalizer while updating the latest selection.
      input.previous.selectedRuntime = remoteLaunch.selectedRuntime;
      input.previous.attachmentInvalidated = false;
      input.previous.uncertainDrain = false;
      input.previous.reconnectSelection = reconnectSelection;
      launchTransferred = true;
      return input.previous;
    }
    if (input.previous !== undefined) {
      const previous = input.previous;
      // Remove ownership before scope closure so the old finalizer cannot stop the successor.
      yield* Effect.gen(function* () {
        tunnels.delete(input.key);
        yield* closeTunnelEntry(previous);
      }).pipe(Effect.uninterruptible);
    }
    const remotePort = remoteLaunch.remotePort;
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
    });
    const localPort =
      input.previous?.localPort ?? input.previousLocalPort ?? (yield* reserveLocalTunnelPort());
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    // Shutdown also owns forwards still awaiting readiness, before they enter the tunnel map.
    const entryScope = yield* Scope.fork(managerScope, "sequential");
    const start = (authOptions: SshAuth.SshAuthOptions) =>
      Effect.gen(function* () {
        if (input.previous?.master !== undefined)
          yield* ensureSshMaster(input.resolvedTarget, authOptions, managerScope);
        return yield* startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
          remoteServerKind: remoteLaunch.remoteServerKind,
          selectedRuntime: remoteLaunch.selectedRuntime,
          scope: entryScope,
          readiness: sshReadinessBudget(launchMs),
        });
      });
    const tunnelEntry = yield* (
      input.background
        ? start(backgroundAuth(input.key))
        : runWithSshAuth({
            key: input.key,
            keyOnly: input.keyOnly === true,
            target: input.resolvedTarget,
            operation: start,
          })
    ).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    if (closed || (generations.get(input.key) ?? 0) !== generation) {
      yield* Scope.close(entryScope, Exit.void);
      if (!closed) {
        cancelledLaunches.set(input.key, remoteLaunch.pending === undefined);
        launchTransferred = true;
      }
      return yield* supersededPreparation();
    }
    yield* Effect.gen(function* () {
      tunnels.set(input.key, tunnelEntry);
      tunnelEntry.reconnectSelection = reconnectSelection;
      if (remoteLaunch.pending === undefined && !needsArchiveRetry)
        pendingReplacements.delete(input.key);
      const spawnerService = yield* ChildProcessSpawner.ChildProcessSpawner;
      const cryptoService = yield* Crypto.Crypto;
      const fileSystemService = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      yield* Scope.addFinalizer(
        entryScope,
        Effect.gen(function* () {
          const stopRemote = tunnels.get(tunnelEntry.key) === tunnelEntry;
          if (stopRemote) {
            tunnels.delete(tunnelEntry.key);
          }
          yield* tunnelEntry.process
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore);
          if (
            !stopRemote ||
            options.leaveRemoteServerRunning === true ||
            pendingReplacements.has(tunnelEntry.key)
          ) {
            return;
          }
          yield* Effect.logDebug("ssh.environment.tunnel.finalizer.start", {
            ...sshTargetLogFields(tunnelEntry.target),
            key: tunnelEntry.key,
            localPort: tunnelEntry.localPort,
            remotePort: tunnelEntry.remotePort,
          });
          const authSecret =
            input.keyOnly === true ? null : (authSecrets.get(tunnelEntry.key) ?? null);
          yield* stopRemoteServer(
            tunnelEntry.target,
            authSecret === null
              ? {
                  batchMode: "yes",
                  interactiveAuth: false,
                }
              : {
                  authSecret,
                  batchMode: "no",
                  interactiveAuth: true,
                },
          ).pipe(
            Effect.provideService(SshConnectionSharing, sharing),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerService),
            Effect.provideService(Crypto.Crypto, cryptoService),
            Effect.provideService(FileSystem.FileSystem, fileSystemService),
            Effect.provideService(Path.Path, pathService),
          );
          yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
            ...sshTargetLogFields(tunnelEntry.target),
            key: tunnelEntry.key,
            localPort: tunnelEntry.localPort,
            remotePort: tunnelEntry.remotePort,
          });
        }).pipe(Effect.ignore),
      );
      launchTransferred = true;
    }).pipe(Effect.uninterruptible);
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  }, withReconnectCost);

  const createTunnelEntry = (input: Parameters<typeof createTunnel>[0]) =>
    createTunnel(input).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.gen(function* () {
          const master = sharing.masters.get(input.key);
          if (master !== undefined && tunnels.get(input.key)?.master !== master)
            yield* Scope.close(master.scope, Exit.void);
        }),
      ),
    );

  /**
   * Whether an open local forward still reaches its remote server. One that
   * does not answer within the check window is closed here; the caller opens
   * a new one. A failed local forward is not authority to stop its remote
   * server, so ownership is removed before closing and the scope finalizer
   * stays local.
   */
  const keepAnsweringTunnel = Effect.fn("ssh/tunnel.keepAnsweringTunnel")(function* (
    key: string,
    entry: SshTunnelEntry,
    retainSelection = false,
  ) {
    const logFields = {
      ...sshTargetLogFields(entry.target),
      key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    };
    yield* Effect.logDebug("ssh.environment.tunnel.existing.check", logFields);
    // A forward whose ssh process already exited (after sleep, or a keepalive timeout) cannot
    // answer, so skip the readiness window. An unreadable state falls back to the HTTP check.
    const forwardRunning = yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => true));
    if (!forwardRunning) {
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...logFields,
        reason: "forward-exited",
      });
    } else {
      const readinessExit = yield* Effect.exit(
        waitForHttpReady(existingTunnelCheck(entry, EXISTING_TUNNEL_CHECK_TIMEOUT_MS)),
      );
      if (Exit.isSuccess(readinessExit)) {
        yield* Effect.logDebug("ssh.environment.tunnel.reused", logFields);
        return true;
      }
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...logFields,
        cause: readinessExit.cause,
      });
    }
    yield* Effect.gen(function* () {
      if (tunnels.get(key) === entry) {
        const selection = entry.reconnectSelection;
        // Wake cleanup may finish before reconnect reaches the lock. Keep only launch proof,
        // whose host-side fingerprint is still checked by the folded command.
        if (
          retainSelection &&
          !closed &&
          !forgotten.has(key) &&
          entry.attachmentInvalidated !== true &&
          entry.uncertainDrain !== true &&
          selection !== undefined &&
          selection.revision === (selectionRevisions.get(key) ?? 0) &&
          selection.generation === (generations.get(key) ?? 0)
        )
          reconnectSelections.set(key, selection);
        if (entry.attachmentInvalidated === true || entry.uncertainDrain === true)
          invalidateReconnectSelection(key);
        tunnels.delete(key);
      }
      yield* closeTunnelEntry(entry);
    }).pipe(Effect.uninterruptible);
    return false;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteGoatRunnerOptions,
    background: boolean = false,
    keyOnly: boolean = false,
    reuseWhileRefreshPending: boolean = false,
    onPhase?: SshRuntimeProgressCallback,
    allowFoldedProbe = true,
    capturedSelection?: ReconnectSelection,
  ): Effect.fn.Return<
    SshTunnelEntry | DesktopSshRuntimePendingResult,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const entry = tunnels.get(key);
    const retainedSelection = takeReconnectSelection(key);
    const pendingSelection = takePendingReconnectSelection(key);
    const selection =
      entry?.reconnectSelection ?? retainedSelection ?? capturedSelection ?? pendingSelection;
    if (entry !== undefined) delete entry.reconnectSelection;
    const managedPin = yield* validateManagedPin(resolvedTarget);
    keyOnly = keyOnly || managedPin !== undefined;
    const previousSelection =
      allowFoldedProbe &&
      entry?.attachmentInvalidated !== true &&
      entry?.uncertainDrain !== true &&
      runner?.refreshOwnedRuntimeOnFirstConnection !== true &&
      selection?.revision === (selectionRevisions.get(key) ?? 0) &&
      selection?.generation === (generations.get(key) ?? 0) &&
      selection.identity === reconnectIdentity(resolvedTarget, runner, managedPin)
        ? selection
        : undefined;
    if (entry !== undefined) {
      if (entry.attachmentInvalidated === true || entry.uncertainDrain === true)
        allowFoldedProbe = false;
      // The background retry owns a deferred refresh; this caller only needs a forward.
      if (
        reuseWhileRefreshPending &&
        pendingReplacements.has(key) &&
        entry.attachmentInvalidated !== true &&
        entry.uncertainDrain !== true
      ) {
        if (yield* keepAnsweringTunnel(key, entry)) {
          if (
            previousSelection !== undefined &&
            selection !== undefined &&
            selection.revision === (selectionRevisions.get(key) ?? 0)
          )
            entry.reconnectSelection = selection;
          return entry;
        }
        // The stale forward is closed; connect anew, refreshing if the host is idle now.
        return yield* createTunnelEntry({
          key,
          resolvedTarget,
          keyOnly,
          ...(runner === undefined ? {} : { runner }),
          previousLocalPort: entry.localPort,
          ...(previousSelection === undefined ? {} : { previousSelection }),
          background,
          ...(onPhase === undefined ? {} : { onPhase }),
        });
      }
      if (
        allowFoldedProbe &&
        pendingReplacements.has(key) &&
        runner?.refreshOwnedRuntimeOnFirstConnection !== true
      ) {
        if (yield* keepAnsweringTunnel(key, entry)) {
          if (
            previousSelection !== undefined &&
            selection !== undefined &&
            selection.revision === (selectionRevisions.get(key) ?? 0)
          )
            entry.reconnectSelection = selection;
          return entry;
        }
        return yield* createTunnelEntry({
          key,
          resolvedTarget,
          keyOnly,
          ...(runner === undefined ? {} : { runner }),
          previousLocalPort: entry.localPort,
          ...(previousSelection === undefined ? {} : { previousSelection }),
          background,
          ...(onPhase === undefined ? {} : { onPhase }),
        });
      }
      const replace =
        entry.attachmentInvalidated === true ||
        entry.uncertainDrain === true ||
        pendingReplacements.has(key) ||
        runner?.refreshOwnedRuntimeOnFirstConnection === true;
      if (!replace && (yield* keepAnsweringTunnel(key, entry))) {
        if (
          previousSelection !== undefined &&
          selection !== undefined &&
          selection.revision === (selectionRevisions.get(key) ?? 0)
        )
          entry.reconnectSelection = selection;
        return entry;
      }
      if (replace) {
        const readiness = yield* Effect.exit(waitForHttpReady(existingTunnelCheck(entry, 2_000)));
        if (Exit.isSuccess(readiness)) {
          return yield* createTunnelEntry({
            key,
            resolvedTarget,
            ...(runner === undefined ? {} : { runner }),
            previous: entry,
            background,
            keyOnly,
            ...(onPhase === undefined ? {} : { onPhase }),
          });
        }
        yield* Effect.gen(function* () {
          if (tunnels.get(key) === entry) tunnels.delete(key);
          yield* closeTunnelEntry(entry);
        }).pipe(Effect.uninterruptible);
      }
    }
    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      keyOnly: keyOnly === true,
      ...(runner === undefined ? {} : { runner }),
      ...(entry === undefined ? {} : { previousLocalPort: entry.localPort }),
      ...(previousSelection === undefined ||
      selection?.revision !== (selectionRevisions.get(key) ?? 0)
        ? {}
        : { previousSelection }),
      background,
      ...(onPhase === undefined ? {} : { onPhase }),
    });
  });

  const startRetry = Effect.gen(function* () {
    if (retryStarted) return;
    retryStarted = true;
    const context = (yield* Effect.context<SshEnvironmentEffectContext>()).pipe(
      Context.omit(Scope.Scope, SshHostAnswered, SshReconnectCost),
    );
    yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep("1 minute");
        if (closed) return;
        const now = yield* Clock.currentTimeMillis;
        for (const [key, intent] of pendingReplacements) {
          if (intent.nextAttemptAt > now) continue;
          const retryRunner = {
            ...intent.requestedRunner,
            refreshOwnedRuntimeOnFirstConnection: true,
            confirmReplacement: false,
          };
          yield* Effect.scoped(
            flights.join({
              key,
              generation: intent.generation,
              intent: preparationIntent(retryRunner, { keyOnly: true, refreshRuntime: true }, true),
              terminal: preparationTerminal,
              prepare: (report) =>
                withTargetLock(
                  key,
                  Effect.gen(function* () {
                    if (
                      closed ||
                      pendingReplacements.get(key) !== intent ||
                      (generations.get(key) ?? 0) !== intent.generation
                    )
                      return yield* supersededPreparation();
                    if (intent.managedPin !== undefined) {
                      const current = yield* readManagedPin(intent.target).pipe(
                        Effect.orElseSucceed(() => undefined),
                      );
                      if (!samePin(intent.managedPin, current)) {
                        pendingReplacements.delete(key);
                        generations.set(key, (generations.get(key) ?? 0) + 1);
                        invalidateReconnectSelection(key);
                        setupOperations.delete(key);
                        acquisitionFailures.delete(key);
                        forgotten.add(key);
                        const error = pinError(
                          current !== undefined &&
                            current.fingerprint !== intent.managedPin.fingerprint,
                        );
                        yield* publishFailure(key, intent.target, intent.requestedRunner, error);
                        const entry = tunnels.get(key);
                        if (entry !== undefined) {
                          tunnels.delete(key);
                          yield* closeTunnelEntry(entry);
                        }
                        authSecrets.delete(key);
                        return yield* error;
                      }
                    }
                    intent.nextAttemptAt = (yield* Clock.currentTimeMillis) + 600_000;
                    const result = yield* ensureTunnelEntry(
                      key,
                      intent.target,
                      retryRunner,
                      true,
                      true,
                      false,
                      ({ phase, upload }) => report.onPhase(phase, upload),
                    );
                    if (closed || (generations.get(key) ?? 0) !== intent.generation)
                      return yield* supersededPreparation();
                    yield* publishResult(key, intent.target, result, intent.requestedRunner);
                    if (!("type" in result) && !pendingReplacements.has(key)) {
                      firstConnectionDecisions.add(
                        `${key}:${intent.requestedRunner.archiveVersion ?? intent.requestedRunner.nodeScriptPath ?? ""}`,
                      );
                    }
                    const pin = yield* readManagedPin(intent.target);
                    return {
                      key,
                      operationId: report.operationId,
                      generation: intent.generation,
                      runner: retryRunner,
                      result,
                      ...("type" in result
                        ? {}
                        : {
                            attachment: rememberAttachment(
                              result,
                              intent.generation,
                              report.operationId,
                              pin,
                            ),
                          }),
                    };
                  }),
                ).pipe(
                  withReconnectCost,
                  Effect.provideService(SshReconnectCost, null),
                  Effect.provideService(SshHostAnswered, report.onHostAnswered),
                  Effect.annotateLogs({
                    key,
                    generation: intent.generation,
                    operationId: report.operationId,
                  }),
                ),
            }),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.gen(function* () {
                if (!closed && (generations.get(key) ?? 0) === intent.generation)
                  yield* publishFailure(key, intent.target, intent.requestedRunner, cause);
                yield* Effect.logWarning("ssh.runtime.retry.failed", {
                  alias: intent.target.alias,
                  cause,
                });
              }),
            ),
            Effect.ignore,
          );
        }
      }
    }).pipe(
      Effect.provide(context),
      // Deferred preparations own their cost even when the initiating ensure is still running.
      Effect.provideService(SshReconnectCost, null),
      Effect.forkIn(managerScope),
    );
  });

  // Only preparation policy participates: tokens, callbacks and request identity are per waiter.
  const preparationIntent = (
    runner: RemoteGoatRunnerOptions | undefined,
    requestOptions: SshEnvironmentEnsureOptions | undefined,
    background = false,
  ) =>
    JSON.stringify({
      background,
      keyOnly: requestOptions?.keyOnly === true,
      refreshRuntime: requestOptions?.refreshRuntime === true,
      confirmReplacement: requestOptions?.confirmReplacement === true,
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
  const preparationTerminal = (prepared: PreparedEnsure) => {
    if (
      closed ||
      (generations.get(prepared.key) ?? 0) !== prepared.generation ||
      (!("type" in prepared.result) && tunnels.get(prepared.key) !== prepared.result)
    )
      return { outcome: "superseded" as const };
    const runtimeStatus = statuses.get(prepared.key)?.status;
    return prepared.attachment !== undefined &&
      runtimeStatus !== undefined &&
      (runtimeStatus.state === "ready" || runtimeStatus.state === "providers_not_ready") &&
      !("type" in prepared.result) &&
      prepared.result.attachmentInvalidated !== true &&
      prepared.result.uncertainDrain !== true
      ? { outcome: "ready" as const, attachmentId: prepared.attachment.id, runtimeStatus }
      : { outcome: "pending" as const };
  };
  const rememberAttachment = (
    entry: SshTunnelEntry,
    generation: number,
    operationId: string,
    pin: ManagedPin | undefined,
  ): Attachment => {
    const previous = attachments.get(entry);
    if (
      previous !== undefined &&
      previous.generation === generation &&
      previous.selection === entry.selectedRuntime &&
      samePin(previous.pin, pin)
    )
      return previous;
    const attachment = {
      id: `${operationId}-attachment`,
      operationId,
      generation,
      selection: entry.selectedRuntime,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
      version: entry.selectedRuntime.version,
      pin,
    };
    attachments.set(entry, attachment);
    return attachment;
  };
  const validatePreparedAttachment = Effect.fn("ssh/tunnel.validatePreparedAttachment")(function* (
    key: string,
    entry: SshTunnelEntry,
    attachment: Attachment,
  ) {
    if (
      closed ||
      (generations.get(key) ?? 0) !== attachment.generation ||
      tunnels.get(key) !== entry ||
      attachments.get(entry) !== attachment ||
      attachment.selection !== entry.selectedRuntime ||
      attachment.localPort !== entry.localPort ||
      attachment.remotePort !== entry.remotePort ||
      attachment.version !== entry.selectedRuntime.version ||
      entry.attachmentInvalidated === true ||
      entry.uncertainDrain === true
    )
      return yield* supersededPreparation();
    const pin = yield* readManagedPin(entry.target).pipe(
      Effect.mapError(() => {
        attachments.delete(entry);
        return supersededPreparation();
      }),
    );
    if (!samePin(attachment.pin, pin)) {
      attachments.delete(entry);
      return yield* supersededPreparation();
    }
    if (!(yield* keepAnsweringTunnel(key, entry))) {
      attachments.delete(entry);
      return yield* supersededPreparation();
    }
    if (
      closed ||
      (generations.get(key) ?? 0) !== attachment.generation ||
      tunnels.get(key) !== entry ||
      Boolean(entry.attachmentInvalidated) ||
      Boolean(entry.uncertainDrain) ||
      entry.selectedRuntime !== attachment.selection
    )
      return yield* supersededPreparation();
  });
  const finishEnsureEnvironment = Effect.fn("ssh/tunnel.finishEnsureEnvironment")(function* (
    prepared: PreparedEnsure,
    ticket: RequestTicket,
    requestOptions?: SshEnvironmentEnsureOptions,
  ) {
    return yield* withTargetLock(
      prepared.key,
      Effect.gen(function* () {
        const { key, generation, runner, result: entry } = prepared;
        if (closed || ensureSuperseded(ticket) || (generations.get(key) ?? 0) !== generation)
          return yield* supersededPreparation();
        if ("type" in entry) return entry;
        if (prepared.attachment === undefined) return yield* supersededPreparation();
        yield* validatePreparedAttachment(key, entry, prepared.attachment);
        if (requestOptions?.preparedAttachmentId !== undefined) {
          yield* Effect.sync(() => {
            try {
              requestOptions.onPreparationAdmission?.({
                operationId: prepared.operationId,
                disposition: "attachment-completion",
                generation,
              });
            } catch {
              /* A detached observer does not own the attachment. */
            }
          });
        }
        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runWithSshAuth({
              key,
              keyOnly: requestOptions?.keyOnly === true || managedAliases.has(entry.target.alias),
              target: entry.target,
              operation: (authOptions) =>
                issueRemotePairingToken(entry.target, authOptions, runner, entry.selectedRuntime),
            })
          : null;
        const currentPin = yield* readManagedPin(entry.target).pipe(
          Effect.mapError(() => supersededPreparation()),
        );
        if (
          closed ||
          ensureSuperseded(ticket) ||
          (generations.get(key) ?? 0) !== generation ||
          tunnels.get(key) !== entry ||
          entry.selectedRuntime !== prepared.attachment.selection ||
          entry.attachmentInvalidated === true ||
          entry.uncertainDrain === true ||
          !samePin(prepared.attachment.pin, currentPin)
        )
          return yield* supersededPreparation();
        yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
          ...sshTargetLogFields(entry.target),
          key,
          operationId: prepared.operationId,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          issuedPairingToken: pairingResult !== null,
        });
        const pendingReplacement = pendingReplacements.get(key)?.pending;
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken: pairingResult?.credential ?? null,
          attachmentId: prepared.attachment.id,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
          ...(entry.selectedRuntime.version
            ? { remoteServerVersion: entry.selectedRuntime.version }
            : {}),
          ...(pendingReplacement === undefined ? {} : { pendingReplacement }),
        };
      }),
    );
  });

  const ensureEnvironmentAttempt = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: SshEnvironmentEnsureOptions,
  ): Effect.fn.Return<
    DesktopSshEnvironmentReadyOrPending,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext | Scope.Scope
  > {
    const ticket = yield* takeRequestTicket(target, "ensure");
    const requestKey = targetConnectionKey(target);
    const knownKey = targetConnectionKey(resolvedTargets.get(requestKey) ?? target);
    const requestGeneration = generations.get(knownKey) ?? 0;
    const knownEntry = tunnels.get(knownKey);
    const retainedSelection = takeReconnectSelection(knownKey);
    const pendingSelection = takePendingReconnectSelection(knownKey);
    const reconnectSelection =
      knownEntry?.reconnectSelection ?? retainedSelection ?? pendingSelection;
    if (knownEntry !== undefined) delete knownEntry.reconnectSelection;
    if (requestOptions?.refreshRuntime === true || requestOptions?.confirmReplacement === true)
      invalidateReconnectSelection(knownKey);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    if (
      closed ||
      ensureSuperseded(ticket) ||
      (generations.get(knownKey) ?? 0) !== requestGeneration
    )
      return yield* supersededPreparation();
    yield* startRetry;
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname, target).pipe(
      Effect.tapError((error) =>
        Effect.suspend(() =>
          !closed &&
          !ensureSuperseded(ticket) &&
          (generations.get(knownKey) ?? 0) === requestGeneration
            ? publishFailure(knownKey, target, runner, error)
            : Effect.void,
        ),
      ),
    );
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    if (
      closed ||
      ensureSuperseded(ticket) ||
      (generations.get(knownKey) ?? 0) !== requestGeneration
    )
      return yield* supersededPreparation();
    const key = targetConnectionKey(resolvedTarget);
    if (key !== knownKey) invalidateReconnectSelection(knownKey);
    const admittedGeneration = generations.get(key) ?? 0;
    resolvedTargets.set(requestKey, resolvedTarget);
    if (key !== knownKey && !statuses.has(key)) {
      const initial = statuses.get(knownKey);
      if (initial !== undefined) statuses.set(key, initial);
      statuses.delete(knownKey);
    }
    yield* Effect.logDebug("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    if (requestOptions?.preparedAttachmentId !== undefined) {
      const prepared = yield* withTargetLock(
        key,
        Effect.gen(function* () {
          const entry = tunnels.get(key);
          const attachment = entry === undefined ? undefined : attachments.get(entry);
          if (
            entry === undefined ||
            attachment === undefined ||
            attachment.id !== requestOptions.preparedAttachmentId
          )
            return yield* supersededPreparation();
          return {
            key,
            operationId: attachment.operationId,
            generation: admittedGeneration,
            runner,
            result: entry,
            attachment,
          };
        }),
      );
      return yield* finishEnsureEnvironment(prepared, ticket, requestOptions);
    }
    const managedPin = yield* readManagedPin(resolvedTarget);
    const preparationOptions = {
      keyOnly: requestOptions?.keyOnly === true || managedPin !== undefined,
      refreshRuntime: requestOptions?.refreshRuntime === true,
      confirmReplacement: requestOptions?.confirmReplacement === true,
      reuseWhileRefreshPending: requestOptions?.reuseWhileRefreshPending === true,
    };
    const onHostAnswered = yield* SshHostAnswered;
    const context = (yield* Effect.context<SshEnvironmentEffectContext>()).pipe(
      Context.omit(Scope.Scope, SshHostAnswered, SshReconnectCost),
    );
    const lease = yield* flights.join({
      key,
      generation: admittedGeneration,
      intent: preparationIntent(runner, preparationOptions),
      ...(requestOptions?.onPreparationProgress === undefined
        ? {}
        : { onProgress: requestOptions.onPreparationProgress }),
      ...(requestOptions?.onPreparationAdmission === undefined
        ? {}
        : { onAdmission: requestOptions.onPreparationAdmission }),
      ...(requestOptions?.onPhase === undefined
        ? {}
        : {
            onPhase: (phase, upload) =>
              notifyRuntimePhase(resolvedTarget, phase, requestOptions.onPhase, upload),
          }),
      onHostAnswered,
      terminal: preparationTerminal,
      onFailure: (error) =>
        Effect.suspend(() => {
          if (closed || (generations.get(key) ?? 0) !== admittedGeneration) return Effect.void;
          invalidateReconnectSelection(key);
          return publishFailure(key, resolvedTarget, runner, error);
        }).pipe(Effect.provide(context)),
      prepare: (report) =>
        withTargetLock(
          key,
          Effect.gen(function* () {
            if (closed || (generations.get(key) ?? 0) !== admittedGeneration)
              return yield* supersededPreparation();
            forgotten.delete(key);
            const reusingPending =
              preparationOptions.reuseWhileRefreshPending === true &&
              preparationOptions.refreshRuntime !== true &&
              pendingReplacements.has(key) &&
              tunnels.has(key);
            const onPhase: SshRuntimeProgressCallback = ({ phase, upload }) =>
              report.onPhase(phase, upload);
            if (!reusingPending)
              publishPhase(
                key,
                resolvedTarget,
                runner?.archiveVersion?.trim() ?? "",
                "connecting",
                onPhase,
              );
            if (preparationOptions.refreshRuntime === true) acquisitionFailures.delete(key);
            const decisionKey = `${key}:${runner?.archiveVersion ?? runner?.nodeScriptPath ?? ""}`;
            const connectionRunner =
              runner === undefined
                ? undefined
                : {
                    ...runner,
                    refreshOwnedRuntimeOnFirstConnection:
                      runner.keepExistingRunner !== true &&
                      (preparationOptions.refreshRuntime === true ||
                        (!firstConnectionDecisions.has(decisionKey) &&
                          !pendingReplacements.has(key))) &&
                      runner.refreshOwnedRuntimeOnFirstConnection === true,
                    confirmReplacement: preparationOptions.confirmReplacement === true,
                    ...(preparationOptions.refreshRuntime === true ? { manualRefresh: true } : {}),
                  };
            const entry = yield* ensureTunnelEntry(
              key,
              resolvedTarget,
              connectionRunner,
              false,
              preparationOptions.keyOnly === true,
              preparationOptions.reuseWhileRefreshPending === true &&
                preparationOptions.refreshRuntime !== true,
              onPhase,
              requestOptions?.refreshRuntime !== true &&
                requestOptions?.confirmReplacement !== true,
              reconnectSelection,
            );
            if (closed || (generations.get(key) ?? 0) !== admittedGeneration)
              return yield* supersededPreparation();
            if (
              !("type" in entry) &&
              connectionRunner?.refreshOwnedRuntimeOnFirstConnection === true &&
              !pendingReplacements.has(key)
            )
              firstConnectionDecisions.add(decisionKey);
            yield* publishResult(key, resolvedTarget, entry, runner);
            const pin = yield* readManagedPin(resolvedTarget);
            if (closed || (generations.get(key) ?? 0) !== admittedGeneration)
              return yield* supersededPreparation();
            return {
              key,
              operationId: report.operationId,
              generation: admittedGeneration,
              runner,
              result: entry,
              ...("type" in entry
                ? {}
                : {
                    attachment: rememberAttachment(
                      entry,
                      admittedGeneration,
                      report.operationId,
                      pin,
                    ),
                  }),
            };
          }),
        ).pipe(
          withReconnectCost,
          Effect.provideService(SshHostAnswered, report.onHostAnswered),
          Effect.provideService(SshReconnectCost, null),
          Effect.provide(context),
          Effect.annotateLogs({
            key,
            generation: admittedGeneration,
            operationId: report.operationId,
          }),
        ),
    });
    return yield* finishEnsureEnvironment(lease.value, ticket, requestOptions);
  });

  const ensureEnvironment: SshEnvironmentManagerShape["ensureEnvironment"] = (...args) =>
    withSshCost(Effect.scoped(ensureEnvironmentAttempt(...args)), "ssh.ensure.request.cost");

  const revalidateTunnels = Effect.fn("ssh/tunnel.revalidateTunnels")(function* () {
    yield* Effect.forEach(
      [...tunnels.keys()],
      // The lock waits out an ensure in flight, which may already be replacing the entry.
      (key) =>
        withTargetLock(
          key,
          Effect.suspend(() => {
            const entry = tunnels.get(key);
            return entry === undefined ? Effect.void : keepAnsweringTunnel(key, entry, true);
          }),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const ticket = yield* takeRequestTicket(target, "disconnect");
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    // Stored resolution also covers a launch in flight and aliases removed from ssh config.
    const requestKey = targetConnectionKey(target);
    const stored =
      resolvedTargets.get(requestKey) ??
      [...resolvedTargets.values()].find((value) => targetConnectionKey(value) === requestKey);
    const baseResolved =
      stored ?? (yield* resolveSshTarget(target.alias || target.hostname, target));
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    if (disconnectSuperseded(ticket)) {
      yield* Effect.logInfo("ssh.environment.disconnect.superseded", {
        ...sshTargetLogFields(resolvedTarget),
        key,
      });
      return;
    }
    const hadPending = pendingReplacements.has(key);
    generations.set(key, (generations.get(key) ?? 0) + 1);
    invalidateReconnectSelection(key);
    yield* flights.retire(key, false);
    pendingReplacements.delete(key);
    statuses.delete(key);
    acquisitionFailures.delete(key);
    setupOperations.delete(key);
    for (const [request, value] of resolvedTargets)
      if (targetConnectionKey(value) === key) resolvedTargets.delete(request);
    yield* withTargetLock(
      key,
      Effect.gen(function* () {
        // A newer request took over while this one waited for the lock.
        if (disconnectSuperseded(ticket)) {
          // The newer ensure owns whatever a cancelled launch left running.
          cancelledLaunches.delete(key);
          yield* Effect.logInfo("ssh.environment.disconnect.superseded", {
            ...sshTargetLogFields(resolvedTarget),
            key,
          });
          return;
        }
        const entry = tunnels.get(key) ?? null;
        yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          hasTunnel: entry !== null,
        });
        if (entry !== null) {
          // Remove this entry before closure; an owner stops explicitly below.
          yield* Effect.gen(function* () {
            tunnels.delete(key);
            yield* closeTunnelEntry(entry);
          }).pipe(Effect.uninterruptible);
        }
        const stopRemote = cancelledLaunches.get(key) ?? !hadPending;
        cancelledLaunches.delete(key);
        if (options.leaveRemoteServerRunning !== true && stopRemote) {
          yield* runWithSshAuth({
            key,
            target: resolvedTarget,
            operation: (authOptions) => stopRemoteServer(resolvedTarget, authOptions),
          });
        }
        yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
      }),
    );
  });

  const resolveManagedTarget = Effect.fn("ssh/tunnel.resolveManagedTarget")(function* (
    target: DesktopSshEnvironmentTarget,
  ) {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname, target);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    return { resolvedTarget, key: targetConnectionKey(resolvedTarget) };
  });

  const status = Effect.fn("ssh/tunnel.status")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<SshHostResult, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const requestKey = targetConnectionKey(target);
    const knownTarget = resolvedTargets.get(requestKey) ?? target;
    const knownKey = targetConnectionKey(knownTarget);
    const active = statuses.get(knownKey);
    if (forgotten.has(knownKey) && active !== undefined) return active;
    if (
      active?.status?.setup?.stage === "complete" &&
      active.status.state === "failed" &&
      [
        "diagnosis_failed",
        "approval_expired",
        "authorization_revoked",
        "operation_failed",
      ].includes(active.status.failure?.reason ?? "")
    )
      return active;
    if (active?.status?.state === "preparing" || active?.status?.state === "update_waiting")
      return active;
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    let key = knownKey;
    let observed = active;
    let generation = generations.get(key) ?? 0;
    const initialGeneration = generation;
    // Applied only after the generation/snapshot checks below, so a stale probe cannot clear newer state.
    let clearArchiveDeferral:
      | { readonly failure: SshHostFailure | undefined; readonly intent: unknown }
      | undefined;
    let drainAttachment:
      | { entry: SshTunnelEntry; intent: NonNullable<ReturnType<typeof pendingReplacements.get>> }
      | undefined;
    let verifiedDrainDeferral:
      | { entry: SshTunnelEntry; intent: NonNullable<ReturnType<typeof pendingReplacements.get>> }
      | undefined;
    const result = yield* Effect.gen(function* () {
      const { resolvedTarget } = yield* resolveManagedTarget(target);
      key = targetConnectionKey(resolvedTarget);
      if ((generations.get(knownKey) ?? 0) !== initialGeneration)
        return (
          statuses.get(knownKey) ??
          statuses.get(key) ??
          ({
            kind: "ok",
            status: {
              host: target.alias || target.hostname,
              requestedVersion: "",
              runtimeVersion: null,
              state: "untrusted",
            },
          } satisfies SshHostResult)
        );
      if (forgotten.has(key) && statuses.has(key)) return statuses.get(key)!;
      generation = generations.get(key) ?? 0;
      resolvedTargets.set(requestKey, resolvedTarget);
      observed = statuses.get(key);
      const entry = tunnels.get(key);
      const intent = pendingReplacements.get(key);
      if (entry !== undefined && intent?.pending?.refreshCause === "drain_unavailable")
        drainAttachment = { entry, intent };
      yield* validateManagedPin(resolvedTarget);
      if (observed?.status?.state === "preparing" || observed?.status?.state === "update_waiting")
        return observed;
      const requestedVersion = runner?.archiveVersion?.trim() ?? "";
      const output = yield* runSshCommand(resolvedTarget, {
        batchMode: "yes",
        interactiveAuth: false,
        preHostArgs: ["-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no"],
        remoteCommandArgs: ["sh", "-l", "-s"],
        stdin: buildRemoteRuntimeProbeScript(requestedVersion, REMOTE_RUNTIME_STATE_KEY),
        timeoutMs: SSH_READY_TIMEOUT_MS,
      });
      const probe = yield* decodeRemoteJsonOutput(output.stdout, decodeRemoteRuntimeProbe).pipe(
        Effect.mapError(runtimePreparationError),
      );
      const host = target.alias || target.hostname;
      const base = { host, requestedVersion };
      let snapshot: SshHostStatus;
      let compatibleLive = false;
      if (probe.liveStatus === "live") {
        if (
          probe.liveVersion === undefined ||
          probe.liveSignals === undefined ||
          probe.liveSignals.serverVersion !== probe.liveVersion
        ) {
          return {
            kind: "error",
            code: "operation_failed",
            message: `${host}: The running GOAT runtime could not be verified.`,
            fix: { actor: "agent", instruction: "Try again" },
          } satisfies SshHostResult;
        }
        const order = compareRuntimeBuilds(
          { version: probe.liveVersion, commitTime: probe.liveCommitTime },
          { version: requestedVersion, commitTime: runner?.archiveCommitTime },
        );
        const blocked =
          probe.liveOwned !== true ||
          order === undefined ||
          order > 0 ||
          (probe.liveVersion !== requestedVersion && probe.liveDrain !== true);
        const compatible = matchesSignals(probe.liveSignals, requestedVersion);
        compatibleLive =
          compatible &&
          probe.identityAbsent !== true &&
          probe.liveBinarySignals !== undefined &&
          probe.liveBinarySignals.serverVersion === probe.liveVersion &&
          matchesSignals(probe.liveBinarySignals, requestedVersion);
        if (!compatible && !blocked) {
          return {
            kind: "error",
            code: "operation_failed",
            message: `${host}: The running GOAT runtime has incompatible protocols.`,
            fix: { actor: "agent", instruction: "Try again" },
          } satisfies SshHostResult;
        }
        const providers = observed?.status?.providers;
        snapshot = {
          ...base,
          runtimeVersion: probe.liveVersion,
          state: blocked
            ? "update_blocked"
            : providers?.ready === false
              ? "providers_not_ready"
              : "ready",
          ...(providers === undefined ? {} : { providers }),
          ...(blocked
            ? {
                detail:
                  order !== undefined && order > 0
                    ? `${host} runs a newer GOAT (${probe.liveVersion}). Update this app from the update button above Settings.`
                    : `A GOAT server that this app didn't start or cannot replace is running on ${host}. Stop it on the host, then reconnect.`,
              }
            : {}),
        };
      } else if (probe.liveStatus === "unknown") {
        return {
          kind: "error",
          code: "operation_failed",
          message: `${host}: The running GOAT runtime could not be verified.`,
          fix: { actor: "agent", instruction: "Try again" },
        } satisfies SshHostResult;
      } else {
        snapshot = {
          ...base,
          state: "stopped",
          runtimeVersion:
            probe.retained === "ready"
              ? (probe.retainedVersion ?? null)
              : probe.ready
                ? requestedVersion
                : null,
        };
      }
      // A successful probe observes liveness; it does not retry a failed acquisition.
      const pending = intent?.pending;
      if (
        compatibleLive &&
        probe.liveStatus === "live" &&
        probe.liveOwned === true &&
        entry !== undefined &&
        entry.uncertainDrain !== true &&
        intent !== undefined &&
        intent.generation === generation &&
        intent.requestedRunner.archiveVersion?.trim() === requestedVersion &&
        pending?.refreshCause === "drain_unavailable" &&
        (pending.replacement === "older" || pending.replacement === "capability") &&
        pending.requestedVersion === requestedVersion &&
        pending.liveVersion === probe.liveVersion &&
        entry.selectedRuntime.version === probe.liveVersion &&
        entry.selectedRuntime.requestedVersion === requestedVersion &&
        entry.remotePort === probe.livePort &&
        !setupTerminalFailure(key) &&
        (yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => false))) &&
        (yield* waitForHttpReady(existingTunnelCheck(entry, EXISTING_TUNNEL_CHECK_TIMEOUT_MS)).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ))
      ) {
        const pin = yield* validateManagedPin(resolvedTarget);
        if (
          !closed &&
          (generations.get(key) ?? 0) === generation &&
          tunnels.get(key) === entry &&
          pendingReplacements.get(key) === intent &&
          !setupTerminalFailure(key) &&
          samePin(intent.managedPin, pin)
        )
          verifiedDrainDeferral = { entry, intent };
      }
      const previousFailure = acquisitionFailures.get(key);
      if (verifiedDrainDeferral !== undefined) {
        const refreshDeferred = deferredDrainRefresh(requestedVersion);
        snapshot = {
          ...base,
          runtimeVersion: probe.liveVersion!,
          state: snapshot.providers?.ready === false ? "providers_not_ready" : "ready",
          ...(snapshot.providers === undefined ? {} : { providers: snapshot.providers }),
          refreshDeferred,
          detail: refreshDeferred.detail,
        };
      } else if (pending?.refreshCause === "drain_unavailable") {
        snapshot = {
          ...base,
          runtimeVersion: snapshot.runtimeVersion,
          state: "update_blocked",
          detail:
            snapshot.detail ??
            `${host}: The deferred runtime attachment could not be verified. Try reconnecting.`,
        };
      } else if (compatibleLive && snapshot.runtimeVersion === requestedVersion) {
        clearArchiveDeferral = { failure: previousFailure, intent: pendingReplacements.get(key) };
      } else if (
        compatibleLive &&
        previousFailure?.reason === "archive_unavailable" &&
        previousFailure.archive?.requestedVersion === requestedVersion
      ) {
        const refreshDeferred = deferredArchiveRefresh(requestedVersion);
        snapshot = {
          ...base,
          runtimeVersion: snapshot.runtimeVersion,
          detail: refreshDeferred.detail,
          state: snapshot.providers?.ready === false ? "providers_not_ready" : "ready",
          ...(snapshot.providers === undefined ? {} : { providers: snapshot.providers }),
          refreshDeferred,
        };
      } else if (
        previousFailure?.reason === "archive_unavailable" ||
        previousFailure?.reason === "unsupported_platform"
      ) {
        snapshot = {
          ...base,
          state: "failed",
          runtimeVersion: snapshot.runtimeVersion,
          failure: previousFailure,
        };
      }
      return { kind: "ok", status: { ...snapshot, ...setupFields(key) } } satisfies SshHostResult;
    }).pipe(
      Effect.catch((error) => {
        const failure = runtimeFailureResult(
          target.alias || target.hostname,
          runner?.archiveVersion?.trim() ?? "",
          observed?.status?.runtimeVersion ?? null,
          error,
        );
        const previousFailure = acquisitionFailures.get(key);
        if (
          failure.kind === "error" &&
          (previousFailure?.reason === "archive_unavailable" ||
            previousFailure?.reason === "unsupported_platform")
        ) {
          return Effect.succeed<SshHostResult>({
            ...failure,
            status: {
              host: target.alias || target.hostname,
              requestedVersion: runner?.archiveVersion?.trim() ?? "",
              runtimeVersion: observed?.status?.runtimeVersion ?? null,
              state: "failed" as const,
              failure: previousFailure,
            },
          });
        }
        return Effect.succeed<SshHostResult>(failure);
      }),
    );
    // A read started before a launch/disconnect must not overwrite its newer snapshot.
    if (closed || (generations.get(key) ?? 0) !== generation) return statuses.get(key) ?? result;
    const latest = statuses.get(key);
    if (latest !== observed && latest !== undefined) return latest;
    let enriched = yield* enrichFailure(target, result);
    if (closed || (generations.get(key) ?? 0) !== generation) return statuses.get(key) ?? enriched;
    if (statuses.get(key) !== observed && statuses.has(key)) return statuses.get(key)!;
    if (verifiedDrainDeferral !== undefined) {
      if (
        tunnels.get(key) !== verifiedDrainDeferral.entry ||
        pendingReplacements.get(key) !== verifiedDrainDeferral.intent ||
        setupTerminalFailure(key)
      )
        return statuses.get(key) ?? enriched;
      acquisitionFailures.delete(key);
    }
    if (clearArchiveDeferral !== undefined) {
      if (acquisitionFailures.get(key) === clearArchiveDeferral.failure)
        acquisitionFailures.delete(key);
      const intent = pendingReplacements.get(key);
      if (
        intent !== undefined &&
        intent === clearArchiveDeferral.intent &&
        intent.archiveFailure !== undefined
      )
        pendingReplacements.delete(key);
    }
    if (
      tunnels.get(key)?.uncertainDrain === true &&
      enriched.kind === "ok" &&
      (enriched.status.state === "ready" || enriched.status.state === "providers_not_ready")
    ) {
      // Liveness cannot prove that an attempted drain was cancelled.
      verifiedDrainDeferral = undefined;
      const blockedStatus = {
        ...enriched.status,
        state: "update_blocked" as const,
        detail: "The previous runtime drain could not be verified. Try reconnecting.",
      };
      delete blockedStatus.refreshDeferred;
      enriched = { ...enriched, status: blockedStatus };
    }
    if (
      drainAttachment !== undefined &&
      tunnels.get(key) === drainAttachment.entry &&
      pendingReplacements.get(key) === drainAttachment.intent
    ) {
      // Historical launch proof cannot readmit an attachment rejected by a fresh probe.
      drainAttachment.entry.attachmentInvalidated = verifiedDrainDeferral === undefined;
      if (drainAttachment.entry.attachmentInvalidated) attachments.delete(drainAttachment.entry);
    }
    const selected = tunnels.get(key)?.reconnectSelection ?? reconnectSelections.get(key);
    if (
      tunnels.get(key)?.attachmentInvalidated === true ||
      tunnels.get(key)?.uncertainDrain === true ||
      enriched.kind !== "ok" ||
      (enriched.status?.state !== "ready" && enriched.status?.state !== "providers_not_ready") ||
      enriched.status.runtimeVersion !== selected?.runtime.version
    )
      invalidateReconnectSelection(key);
    statuses.set(key, enriched);
    return enriched;
  });

  const requireReadyEntry = Effect.fn("ssh/tunnel.requireReadyEntry")(function* (
    target: DesktopSshEnvironmentTarget,
    key: string,
  ) {
    const entry = tunnels.get(key);
    const snapshot = statuses.get(key)?.status;
    if (
      closed ||
      entry === undefined ||
      entry.attachmentInvalidated === true ||
      entry.uncertainDrain === true ||
      (snapshot?.state !== "ready" && snapshot?.state !== "providers_not_ready") ||
      !(yield* entry.process.isRunning.pipe(Effect.orElseSucceed(() => false)))
    )
      return yield* notReady(target);
    yield* validateManagedPin(entry.target);
    return entry;
  });
  const readyEnvironment: SshEnvironmentManagerShape["readyEnvironment"] = Effect.fn(
    "ssh/tunnel.readyEnvironment",
  )(function* (target) {
    const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const key = targetConnectionKey(known);
    return yield* withIdleTargetLock(
      key,
      target,
      Effect.gen(function* () {
        const entry = yield* requireReadyEntry(target, key);
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken: null,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind === null ? {} : { remoteServerKind: entry.remoteServerKind }),
          ...(entry.selectedRuntime.version === null
            ? {}
            : { remoteServerVersion: entry.selectedRuntime.version }),
        };
      }),
    );
  });

  const issueMcpClientSession = Effect.fn("ssh/tunnel.issueMcpClientSession")(function* (
    target: DesktopSshEnvironmentTarget,
    sessionOptions: RemoteMcpClientSessionOptions,
  ): Effect.fn.Return<
    RemoteMcpClientSession,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
    const { resolvedTarget, key } =
      sessionOptions.requireReady === true
        ? { resolvedTarget: known, key: targetConnectionKey(known) }
        : yield* resolveManagedTarget(target);
    if (sessionOptions.requireReady !== true) yield* validateManagedPin(resolvedTarget);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    if (pendingReplacements.has(key) && !tunnels.has(key)) {
      return yield* new SshLaunchError({
        message: "Remote runtime will be replaced when its work finishes.",
        stdout: "",
      });
    }
    // Session preparation waits for a launch in flight and reuses its selection.
    const issue = Effect.gen(function* () {
      if (sessionOptions.requireReady === true) yield* requireReadyEntry(target, key);
      return yield* runWithSshAuth({
        key,
        keyOnly: managedAliases.has(resolvedTarget.alias) || sessionOptions.requireReady === true,
        target: resolvedTarget,
        operation: (authOptions) =>
          issueRemoteMcpClientSession(
            resolvedTarget,
            sessionOptions,
            authOptions,
            runner,
            tunnels.get(key)?.selectedRuntime,
          ),
      });
    });
    return yield* (
      sessionOptions.requireReady === true
        ? withIdleTargetLock(key, target, issue)
        : withTargetLock(key, issue)
    ).pipe(
      Effect.mapError((error) => {
        const pending = pendingReplacements.get(key)?.pending;
        if (
          pending === undefined ||
          error._tag !== "SshPairingError" ||
          error.reason !== "memory-scopes-unsupported"
        )
          return error;
        // The refresh already waits for this runtime to go idle; say so instead of asking for a stop.
        return (
          memoryScopesUnsupportedError(
            error.stdout,
            resolvedTarget.alias,
            `It will be replaced with GOAT ${pending.requestedVersion} when its current work finishes.`,
          ) ?? error
        );
      }),
    );
  });

  const issueClientSession: SshEnvironmentManagerShape["issueClientSession"] = Effect.fn(
    "ssh/tunnel.issueClientSession",
  )(function* (target, sessionOptions) {
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    yield* validateManagedPin(resolvedTarget);
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    if (pendingReplacements.has(key) && !tunnels.has(key)) {
      return yield* new SshLaunchError({
        message: "Remote runtime will be replaced when its work finishes.",
        stdout: "",
      });
    }
    return yield* withTargetLock(
      key,
      runWithSshAuth({
        key,
        keyOnly: managedAliases.has(resolvedTarget.alias),
        target: resolvedTarget,
        operation: (authOptions) =>
          issueRemoteClientSession(
            resolvedTarget,
            sessionOptions,
            authOptions,
            runner,
            tunnels.get(key)?.selectedRuntime,
          ),
      }),
    );
  });

  const runRemoteScript = Effect.fn("ssh/tunnel.runRemoteScript")(function* (
    target: DesktopSshEnvironmentTarget,
    input: { readonly script: string; readonly timeoutMs?: number },
  ): Effect.fn.Return<
    { readonly stdout: string; readonly stderr: string },
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    yield* validateManagedPin(resolvedTarget);
    return yield* runWithSshAuth({
      key,
      keyOnly: managedAliases.has(resolvedTarget.alias),
      target: resolvedTarget,
      operation: (authOptions) =>
        runSshCommand(resolvedTarget, {
          remoteCommandArgs: ["sh", "-s"],
          stdin: input.script,
          ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
          ...(authOptions.authSecret === undefined ? {} : { authSecret: authOptions.authSecret }),
          ...(authOptions.batchMode === undefined ? {} : { batchMode: authOptions.batchMode }),
          ...(authOptions.interactiveAuth === undefined
            ? {}
            : { interactiveAuth: authOptions.interactiveAuth }),
        }),
    });
  });

  const beginSetupOperation: SshEnvironmentManagerShape["beginSetupOperation"] = Effect.fn(
    "ssh/tunnel.beginSetupOperation",
  )(function* (target, operationId) {
    const ticket = yield* takeRequestTicket(target, "ensure");
    const { resolvedTarget, key } = yield* resolveManagedTarget(target);
    if (latestRequest.get(ticket.key) !== ticket.sequence)
      return yield* new SshLaunchError({ message: "SSH setup was cancelled.", stdout: "" });
    resolvedTargets.set(targetConnectionKey(target), resolvedTarget);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    invalidateReconnectSelection(key);
    yield* flights.retire(key, false);
    pendingReplacements.delete(key);
    forgotten.delete(key);
    const setup: SshHostSetupProgress = { operationId, generation, stage: "runtime" };
    setupOperations.set(key, setup);
    const previous = statuses.get(key)?.status;
    statuses.set(key, {
      kind: "ok",
      status: {
        host: target.alias || target.hostname,
        requestedVersion: previous?.requestedVersion ?? "",
        runtimeVersion: previous?.runtimeVersion ?? null,
        state: "stopped",
        setup,
      },
    });
    return setup;
  });
  const publishSetupOutcome: SshEnvironmentManagerShape["publishSetupOutcome"] = (
    target,
    operation,
    outcome,
  ) =>
    Effect.sync(() => {
      const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
      const key = targetConnectionKey(known);
      const setup = setupOperations.get(key);
      const previous = statuses.get(key);
      const snapshot =
        previous?.status ??
        (previous?.kind === "error"
          ? {
              host: target.alias || target.hostname,
              requestedVersion: "",
              runtimeVersion: null,
              state: "failed" as const,
              failure: {
                reason: "operation_failed" as const,
                fix: previous.fix ?? { actor: "agent" as const, instruction: "Try again" },
              },
              detail: previous.message,
            }
          : undefined);
      if (
        closed ||
        setup?.operationId !== operation.operationId ||
        setup.generation !== operation.generation ||
        (generations.get(key) ?? 0) !== operation.generation ||
        snapshot === undefined
      )
        return false;
      // Failed runtime acquisition and replacement waits keep their own recovery.
      // Expired/revoked key-auth approvals instead become one terminal setup failure.
      const keepRecovery = [
        "failed",
        "update_waiting",
        "update_blocked",
        "providers_not_ready",
      ].includes(snapshot.state);
      if (outcome.kind === "complete" || (keepRecovery && snapshot.refreshDeferred === undefined)) {
        if (outcome.kind === "complete" && snapshot.state === "preparing") return false;
        setupOperations.set(key, { ...setup, diagnosisRequired: false });
        statuses.set(key, { kind: "ok", status: { ...snapshot, ...setupFields(key, "complete") } });
      } else {
        pendingReplacements.delete(key);
        generations.set(key, operation.generation + 1);
        invalidateReconnectSelection(key);
        const attachmentEntry = tunnels.get(key);
        if (attachmentEntry !== undefined) attachments.delete(attachmentEntry);
        const {
          phase: _phase,
          waitingReason: _waiting,
          publicKey: _publicKey,
          keyAuth: _keyAuth,
          failure: _failure,
          refreshDeferred: _refreshDeferred,
          ...base
        } = snapshot;
        statuses.set(key, {
          kind: "ok",
          status: {
            ...base,
            state: "failed",
            detail: outcome.message,
            failure: { reason: outcome.reason, fix: outcome.fix },
            ...setupFields(key, "complete"),
          },
        });
      }
      return true;
    });
  const publishProviderDiagnosis: SshEnvironmentManagerShape["publishProviderDiagnosis"] = (
    target,
    operation,
    providers,
  ) =>
    Effect.sync(() => {
      // A stale publisher must not resolve or contact a host forgotten in the meantime.
      const known = resolvedTargets.get(targetConnectionKey(target)) ?? target;
      const key = targetConnectionKey(known);
      const setup = setupOperations.get(key);
      const previous = statuses.get(key)?.status;
      if (
        closed ||
        setup?.operationId !== operation.operationId ||
        setup.generation !== operation.generation ||
        (generations.get(key) ?? 0) !== operation.generation ||
        previous === undefined ||
        (previous.state !== "ready" && previous.state !== "providers_not_ready")
      )
        return false;
      statuses.set(key, {
        kind: "ok",
        status: {
          ...previous,
          state: providers.ready ? "ready" : "providers_not_ready",
          providers,
          ...setupFields(key, "complete"),
        },
      });
      return true;
    });
  const forgetEnvironment: SshEnvironmentManagerShape["forgetEnvironment"] = Effect.fn(
    "ssh/tunnel.forgetEnvironment",
  )(function* (target, forgetOptions) {
    const ticket = yield* takeRequestTicket(target, "disconnect");
    const requestKey = targetConnectionKey(target);
    const resolvedTarget =
      resolvedTargets.get(requestKey) ?? (yield* resolveManagedTarget(target)).resolvedTarget;
    const key = targetConnectionKey(resolvedTarget);
    const generation = (generations.get(key) ?? 0) + 1;
    generations.set(key, generation);
    invalidateReconnectSelection(key);
    yield* flights.retire(key, false);
    pendingReplacements.delete(key);
    acquisitionFailures.delete(key);
    setupOperations.delete(key);
    forgotten.add(key);
    observedPins.delete(target.alias);
    let result: SshHostResult = {
      kind: "ok",
      status: {
        host: target.alias || target.hostname,
        requestedVersion: statuses.get(key)?.status?.requestedVersion ?? "",
        runtimeVersion: statuses.get(key)?.status?.runtimeVersion ?? null,
        state: "untrusted",
      },
    };
    // Publish the fence before waiting on a long upload's lock.
    statuses.set(key, result);
    yield* withTargetLock(
      key,
      Effect.gen(function* () {
        if (disconnectSuperseded(ticket)) return;
        if (forgetOptions.stopRuntime === "if_idle") {
          const stopped = yield* Effect.result(
            stopRemoteServer(resolvedTarget, {
              batchMode: "yes",
              interactiveAuth: false,
              ownedOnly: true,
            }),
          );
          if (stopped._tag === "Failure")
            result = {
              ...result,
              status: { ...result.status!, detail: "Runtime stop was not confirmed." },
            };
        }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            const entry = tunnels.get(key);
            if (entry !== undefined) {
              tunnels.delete(key);
              yield* closeTunnelEntry(entry);
            }
            cancelledLaunches.delete(key);
            authSecrets.delete(key);
            for (const decision of firstConnectionDecisions)
              if (decision.startsWith(`${key}:`)) firstConnectionDecisions.delete(decision);
            if ((generations.get(key) ?? 0) === generation) statuses.set(key, result);
          }),
        ),
        Effect.uninterruptible,
      ),
    );
    return result;
  });

  const withSharing =
    <Args extends unknown[], A, E, R>(operation: (...args: Args) => Effect.Effect<A, E, R>) =>
    (...args: Args) =>
      operation(...args).pipe(Effect.provideService(SshConnectionSharing, sharing));
  return SshEnvironmentManager.of({
    status: withSharing(status),
    readyEnvironment: withSharing(readyEnvironment),
    beginSetupOperation: withSharing(beginSetupOperation),
    publishProviderDiagnosis: withSharing(publishProviderDiagnosis),
    publishSetupOutcome: withSharing(publishSetupOutcome),
    forgetEnvironment: withSharing(forgetEnvironment),
    ensureEnvironment: withSharing(ensureEnvironment),
    disconnectEnvironment: withSharing(disconnectEnvironment),
    revalidateTunnels: withSharing(revalidateTunnels),
    issueMcpClientSession: withSharing(issueMcpClientSession),
    issueClientSession: withSharing(issueClientSession),
    runRemoteScript: withSharing(runRemoteScript),
  });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | Crypto | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@goat/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
