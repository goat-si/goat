import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";
import type { DesktopSshEnvironmentTarget, SshHostFailure } from "@goat/contracts";
import {
  CLI_ARCHIVE_PLATFORM_KEYS,
  CLI_RELEASE_REPOSITORY,
  cliArchiveFileName,
  cliArchivePlatformKey,
  isPublishableCliReleaseVersion,
  type CliArchivePlatformKey,
} from "@goat/shared/cliRelease";
import { fromLenientJson } from "@goat/shared/schemaJson";
import { compareRuntimeBuilds, parseSemver, type RuntimeBuild } from "@goat/shared/semver";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SshAuth from "./auth.ts";
import { readLocalRuntimeArchive } from "./runtimeArchive.ts";
import { downloadRuntimeArchiveWithGh } from "./runtimeArchiveGh.ts";
import { downloadRuntimeArchiveWithHttps } from "./runtimeArchiveHttp.ts";
import { findPublishedRuntime, type PublishedRuntimeMiss } from "./runtimePublished.ts";
import {
  applyScriptPlaceholders,
  decodeRemoteJsonOutput,
  isNodeScriptRunner,
  matchesSignals,
  notifyRuntimePhase,
  REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
  requestedRuntime,
  RuntimeSignals,
  shellSingleQuote,
  sshTargetLogFields,
  type PreparedRemoteRuntime,
  type RemoteGoatRunnerOptions,
  type SshRuntimeProgressCallback,
} from "./remoteRuntime.ts";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT, REMOTE_RUNNER_HINT_SCRIPT } from "./runtimeFactsScripts.ts";
import { REMOTE_REPLACEMENT_LOCK_SCRIPT } from "./runtimeOwnershipScripts.ts";
import { REMOTE_RUNTIME_STATE_KEY, runSshCommand } from "./command.ts";
import { SshCommandError, SshInvalidTargetError, SshLaunchError } from "./errors.ts";

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
  if [ "$1" = live ] && [ "$live_owned" = false ] && [ -n "$state_key" ] &&
     managed_orphan "$5" "$6" "$2" "$state"; then
    live_fields="$live_fields,\\"liveAdoptable\\":true"
  fi
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

const decodeRemoteRuntimeProbeFields = Schema.decodeEffect(
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
      /** The live server is GOAT's managed runtime whose launch records were lost; see `managed_orphan`. */
      liveAdoptable: Schema.optionalKey(Schema.Boolean),
    }),
  ),
);

// An owning launch adopts such a server under the replacement lock before it acts, so every
// decision treats it as owned. Its identity is written by that adoption, not inherited.
type RemoteRuntimeProbe = Effect.Success<ReturnType<typeof decodeRemoteRuntimeProbeFields>>;

export const decodeRemoteRuntimeProbe = (input: string) =>
  decodeRemoteRuntimeProbeFields(input).pipe(
    Effect.map((probe): RemoteRuntimeProbe =>
      probe.liveAdoptable === true && probe.liveOwned !== true
        ? { ...probe, liveOwned: true, identityAbsent: false }
        : probe,
    ),
  );

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
