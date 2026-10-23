import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";
import {
  encodePowerShellCommand,
  WINDOWS_DETACHED_SPAWN_POWERSHELL,
  WINDOWS_PROCESS_INFO_POWERSHELL,
} from "@goat/shared/windowsHostProcess";

import { REMOTE_RUNNER_HINT_SCRIPT } from "./runtimeFactsScripts.ts";

const REMOTE_REPLACEMENT_WAIT_ATTEMPTS = 50;

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
export const REMOTE_REPLACEMENT_LOCK_SCRIPT = String.raw`${REMOTE_HOST_PROCESS_SCRIPT}LOCK="$DEFAULT_SERVER_HOME/ssh-launch/replacement.lock"
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
export const REMOTE_PROTOCOL_GUARD_SCRIPT = `compatible_fields() {
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
# Only an owning launch holding the host replacement lock writes ownership records. Identity,
# port and PID come first and the managed marker last, so a reader never sees ownership without identity.
adopt_managed_orphan() {
  [ "\${OWNING_LAUNCH:-0}" = 1 ] && [ "\${LOCK_HELD:-0}" = 1 ] && [ "\${LEGACY_PENDING:-0}" != 1 ] &&
    [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || return 1
  managed_orphan "$LIVE_PID" "$LIVE_PORT" "$LIVE_VERSION" "$STATE_DIR" || return 1
  adopt_next="$STATE_DIR/identity.adopt.$$"
  printf '%s\n' "$HOME/.goat/runtime/goat/versions/$LIVE_VERSION/goat serve --host 127.0.0.1 --port $LIVE_PORT --base-dir $DEFAULT_SERVER_HOME" >"$adopt_next" &&
    mv -f "$adopt_next" "$STATE_DIR/identity" &&
    printf '%s\n' "$LIVE_PORT" >"$PORT_FILE" && printf '%s\n' "$LIVE_PID" >"$PID_FILE" &&
    printf 'managed\n' >"$MANAGED_FILE" || { rm -f "$adopt_next"; return 1; }
  verify_owned_identity "$LIVE_PID" "$LIVE_PORT"
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
    if [ "$LIVE_STATUS" = live ] && [ "$LIVE_OWNED" = 0 ] && adopt_managed_orphan; then LIVE_OWNED=1; fi
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

export const REMOTE_RUNNER_SETUP_SCRIPT = `RUNNER_FILE="$STATE_DIR/run-t3.sh"
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
export const REMOTE_LEGACY_IDENTITY_SCRIPT = String.raw`capture_running_runner() {
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
export const REMOTE_OWNED_IDENTITY_SCRIPT = `verify_owned_identity() {
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

export const VERIFY_OWNED_BEFORE_PUBLICATION = `if [ "$LEGACY_PENDING" = 1 ]; then
  verify_legacy_identity || ownership_unverified
elif [ "$LIVE_OWNED" = 1 ] && ! verify_owned_identity "$LIVE_PID" "$LIVE_PORT"; then
  printf 'GOAT ownership could not be verified for PID %s: persisted launch identity is missing or mismatched; process, runner and ownership files were preserved.\\n' "$LIVE_PID" >&2
  exit 1
fi`;

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

export const REPLACE_RUNNER_INSTALL = `if [ -f "$RUNNER_FILE" ] && cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  rm -f "$RUNNER_NEXT"
else
  mv "$RUNNER_NEXT" "$RUNNER_FILE"
  RUNNER_CHANGED=1
fi`;

export const KEEP_EXISTING_RUNNER_INSTALL = `if [ ! -f "$RUNNER_FILE" ] || ! cmp -s "$RUNNER_NEXT" "$RUNNER_FILE"; then
  printf 'Selected retained runner changed before publication; reconnect.\\n' >&2; exit 1
fi
rm -f "$RUNNER_NEXT"`;
