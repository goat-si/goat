import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";
import { fromLenientJson } from "@goat/shared/schemaJson";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RuntimeSignals, shellSingleQuote } from "./remoteRuntime.ts";
import { REMOTE_PROTOCOL_TOKEN_SCRIPT, REMOTE_RUNNER_HINT_SCRIPT } from "./runtimeFactsScripts.ts";

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
