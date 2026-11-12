import { SshForceReplaceTarget } from "@goat/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { type RemoteGoatRunnerOptions, shellSingleQuote } from "./remoteRuntime.ts";

const decodeTarget = Schema.decodeUnknownOption(SshForceReplaceTarget);

/** The status field naming the recorded runtime process; absent when the host reported none. */
export const replaceTargetOf = (probe: { readonly replaceTarget?: unknown }) => {
  const target = Option.getOrUndefined(decodeTarget(probe.replaceTarget));
  return target === undefined ? {} : { replaceTarget: target };
};

/** Fills the approved process a confirmed replacement may stop; empty without confirmation. */
export const withForcedReplacement = (
  script: string,
  input: RemoteGoatRunnerOptions | undefined,
) => {
  const target = input?.confirmReplacement === true ? input.forceReplace : undefined;
  return script
    .replace("@@GOAT_FORCE_PID@@", target === undefined ? "''" : String(target.pid))
    .replace("@@GOAT_FORCE_PORT@@", target === undefined ? "''" : String(target.port))
    .replace("@@GOAT_FORCE_START@@", shellSingleQuote(target?.startedAt ?? ""));
};

// Runs in the owning launch under the replacement lock once classification selected the approved
// process (forced_target_recorded), or when that process does not answer its drain. Expects the
// launch's process, listener and log helpers.
export const REMOTE_FORCED_STOP_SCRIPT = `forced_start_of() { server_start "$1" | awk '{ $1 = $1; print }'; }
# Linux counts a process start in clock ticks; elsewhere only the one-second start time exists.
forced_ticks_of() {
  if [ -r "/proc/$1/stat" ]; then sed 's/^.*) //' "/proc/$1/stat" 2>/dev/null | awk '{ print $20 }'; else printf '%s\\n' -; fi
}
# The start time of the runtime this launch started, the evidence a later forced stop asks for. It
# is written to a new file and renamed into place, so a planted link is replaced, never followed.
forced_record_start() {
  rm -f "$STATE_DIR/started" "$STATE_DIR/started.ticks" 2>/dev/null || :
  forced_started_now="$(forced_start_of "$1")" || forced_started_now=
  [ -n "$forced_started_now" ] || return 0
  forced_record_file started "$forced_started_now" && forced_record_file started.ticks "$(forced_ticks_of "$1")" ||
    rm -f "$STATE_DIR/started" "$STATE_DIR/started.ticks"
}
forced_record_file() {
  forced_record_next="$(mktemp "$STATE_DIR/$1.XXXXXX" 2>/dev/null)" || return 1
  if printf '%s\\n' "$2" >"$forced_record_next"; then mv -f "$forced_record_next" "$STATE_DIR/$1"
  else rm -f "$forced_record_next"; return 1; fi
}
# A record counts as evidence only while it is this user's, no other user can change it, and it is
# not a link. A + after the mode marks an access list, which could let another user write; with
# extended attributes too, macOS shows @ instead, and ls -le lists the access list's entries.
forced_trusted() {
  [ -e "$1" ] && [ ! -L "$1" ] && [ -n "$(find "$1" -prune -user "$(id -u)" ! -perm -0020 ! -perm -0002 2>/dev/null)" ] || return 1
  forced_mode="$(LC_ALL=C ls -ld "$1" 2>/dev/null)" || return 1
  case "$forced_mode" in
    ??????????+*|"") return 1 ;;
    ??????????@*) forced_mode="$(LC_ALL=C ls -lde "$1" 2>/dev/null)" || return 1
      printf '%s\\n' "$forced_mode" | awk 'END { exit NR > 1 }' || return 1 ;;
  esac
}
forced_stop_runtime() {
  # A person approved stopping exactly this process. Every check runs again under the lock, and
  # a process that fails one is left running. Nothing is matched by name.
  forced_log_refusal() {
    printf 'GOAT did not stop PID %s for an approved forced update: %s.\\n' "$FORCE_PID" "$1" >>"$LOG_FILE" 2>/dev/null || :
  }
  forced_refused() {
    forced_restore_runner
    forced_log_refusal "$1"
    printf 'GOAT did not stop PID %s on the remote host because %s; it was left running. Ask again so the approval names the runtime running now, or check it on the host and stop it yourself (kill %s).\\n' "$FORCE_PID" "$1" "$FORCE_PID" >&2; exit 1
  }
  # Without a working sleep no grace can be given, so nothing more is signalled or started.
  forced_wait_failed() {
    forced_restore_runner
    forced_log_refusal "the host could not wait after $1"
    printf 'GOAT sent %s to PID %s on the remote host but could not wait for it to exit (sleep failed); nothing more was signalled or started. Check it on the host. See %s.\\n' "$1" "$FORCE_PID" "$LOG_FILE" >&2; exit 1
  }
  # Once the new runner is published, a stop that does not happen puts the old one back.
  FORCED_PUBLISHED=0
  forced_restore_runner() {
    [ "$FORCED_PUBLISHED" = 1 ] && [ -f "$FORCED_PREVIOUS_RUNNER" ] || return 0
    cp -p "$FORCED_PREVIOUS_RUNNER" "$RUNNER_FILE.forced-restore.$" && mv -f "$RUNNER_FILE.forced-restore.$" "$RUNNER_FILE" &&
      { sync_runner_alias || :; } && return 0
    # A failed restore must not end the script before it reports why it stopped.
    rm -f "$RUNNER_FILE.forced-restore.$" 2>/dev/null || :
    printf 'GOAT could not put the previous runner back at %s; the next update replaces it.\\n' "$RUNNER_FILE" >>"$LOG_FILE" 2>/dev/null || :
  }
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then forced_refused "GOAT cannot signal processes on a Windows host"; fi
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || forced_refused "this client no longer holds the replacement lock"
  fact_file_is "$PID_FILE" "$FORCE_PID" && fact_file_is "$PORT_FILE" "$FORCE_PORT" || forced_refused "its launch records changed"
  server_alive "$FORCE_PID" || forced_refused "it is no longer running"
  [ "$(server_uid "$FORCE_PID" | tr -d ' ')" = "$(id -u)" ] || forced_refused "another user owns it"
  forced_start="$(forced_start_of "$FORCE_PID")"
  [ -n "$forced_start" ] && [ "$forced_start" = "$FORCE_START" ] || forced_refused "its start time differs from the approved one"
  server_owns_listener "$FORCE_PID" "$FORCE_PORT" || forced_refused "it does not listen on port $FORCE_PORT"
  # The process must be the runtime GOAT started: the start time (and, on Linux, the start tick)
  # recorded at its launch and the exact launch command GOAT recorded must both match. Without
  # that record, as for a runtime started before GOAT kept it, a person checks it and stops it.
  for forced_record in "$DEFAULT_SERVER_HOME/ssh-launch" "$STATE_DIR" "$PID_FILE" "$PORT_FILE"; do
    forced_trusted "$forced_record" || forced_refused "$forced_record can be changed by another user"
  done
  forced_identity_verified=0
  if forced_trusted "$MANAGED_FILE" && forced_trusted "$STATE_DIR/identity" &&
     verify_owned_identity_now "$FORCE_PID" "$FORCE_PORT"; then forced_identity_verified=1; fi
  forced_recorded_start=; forced_recorded_ticks=
  if forced_trusted "$STATE_DIR/started" && forced_trusted "$STATE_DIR/started.ticks"; then
    fact_slurp "$STATE_DIR/started" && forced_recorded_start="$FACT_TEXT"
    fact_slurp "$STATE_DIR/started.ticks" && forced_recorded_ticks="$FACT_TEXT"
  fi
  forced_unproven=
  if [ "$forced_identity_verified" != 1 ]; then forced_unproven="its command is not GOAT's recorded launch"
  elif [ -z "$forced_recorded_start" ]; then forced_unproven="no start time was recorded at its launch"
  elif [ "$forced_recorded_start" != "$FORCE_START" ]; then forced_unproven="the start time recorded at its launch differs"
  elif [ "$forced_recorded_ticks" != "$(forced_ticks_of "$FORCE_PID")" ]; then forced_unproven="the start tick recorded at its launch differs"
  fi
  if [ -n "$forced_unproven" ]; then
    forced_log_refusal "$forced_unproven"
    printf 'GOAT did not stop PID %s on the remote host: it cannot show this is the runtime it started (the start time recorded at its launch and its launch command must both match, and runtimes started before GOAT kept that record have none). Check it on the host and stop it yourself (kill %s), then update again.\\n' "$FORCE_PID" "$FORCE_PID" >&2; exit 1
  fi
  # The tick just matched against the launch record stays the reference for every later check.
  forced_root_ticks="$forced_recorded_ticks"
  forced_parent_holds() {
    server_alive "$FORCE_PID" && [ "$(forced_start_of "$FORCE_PID")" = "$FORCE_START" ] &&
      [ "$(forced_ticks_of "$FORCE_PID")" = "$forced_root_ticks" ]
  }
  # Signals $2 only while it is alive, this user's, started at $4 and tick $5, and with $3 still the
  # child of $3, all read just before the signal.
  forced_signal_same() {
    server_alive "$2" && [ "$(server_uid "$2" | tr -d ' ')" = "$(id -u)" ] &&
      [ "$(forced_start_of "$2")" = "$4" ] && [ "$(forced_ticks_of "$2")" = "$5" ] &&
      { [ -z "$3" ] || [ "$(ps -o ppid= -p "$2" 2>/dev/null | tr -d ' ')" = "$3" ]; } &&
      kill "-$1" "$2" 2>/dev/null
  }
  # One process table read binds each descendant to its parent, owner and start time, and the
  # table's own row for the runtime must still be the approved process. Every row needs numeric
  # ids (macOS lists nobody as uid -2) and every descendant a whole start time; anything else
  # refuses before a signal. Ancestry walks stop after as many steps as the table has rows.
  forced_table="$(LC_ALL=C TZ=UTC ps -A -o pid= -o ppid= -o uid= -o lstart= 2>/dev/null)" || forced_refused "its process table could not be read"
  forced_root="$(printf '%s\\n' "$forced_table" | awk -v root="$FORCE_PID" '$1 == root { start = $4; for (i = 5; i <= NF; i++) start = start " " $i; print $3 " " start }')"
  [ "$forced_root" = "$(id -u) $FORCE_START" ] || forced_refused "the process table shows another process under its PID"
  forced_records="$(printf '%s\\n' "$forced_table" | awk -v root="$FORCE_PID" -v me="$(id -u)" '
    $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^-?[0-9]+$/ { bad = 1 }
    { parent[$1] = $2; owner[$1] = $3; fields[$1] = NF; start = $4; for (i = 5; i <= NF; i++) start = start " " $i; started[$1] = start }
    END { if (bad) exit 1; for (pid in parent) { if (owner[pid] != me) continue; up = parent[pid]; for (depth = 0; depth < NR && up != ""; depth++) { if (up == root) { if (fields[pid] != 8) exit 1; print pid " " parent[pid] " " started[pid]; break } up = parent[up] } } }')" || forced_refused "its process table could not be read"
  # Each descendant's start tick is read once, then bound by reading its start time and parent
  # again; one that changed in between cannot be identified and is never signalled.
  forced_children=
  while read -r forced_child forced_parent forced_child_start; do
    valid_positive "$forced_child" || continue
    forced_child_ticks="$(forced_ticks_of "$forced_child")"
    [ "$(forced_start_of "$forced_child")" = "$forced_child_start" ] &&
      [ "$(ps -o ppid= -p "$forced_child" 2>/dev/null | tr -d ' ')" = "$forced_parent" ] || continue
    forced_children="$forced_children$forced_child $forced_parent $forced_child_ticks $forced_child_start
"
  done <<GOAT_FORCED_RECORDS
$forced_records
GOAT_FORCED_RECORDS
  # The stopped version can be started again only when it answered its protocol, its launch
  # identity was verified and its release is still installed; the supervisor then rolls back to it.
  FORCED_PREVIOUS_VERSION=; FORCED_PREVIOUS_IDENTITY=; FORCED_PREVIOUS_RUNNER="$STATE_DIR/forced-runner.previous"
  rm -f "$FORCED_PREVIOUS_RUNNER"
  if [ -f "$RUNNER_FILE" ]; then cp -p "$RUNNER_FILE" "$FORCED_PREVIOUS_RUNNER" || forced_refused "its runner could not be kept"; fi
  if [ "$forced_identity_verified" = 1 ] && valid_version "\${FORCED_LIVE_VERSION:-}" &&
     [ -x "$HOME/.goat/runtime/goat/versions/$FORCED_LIVE_VERSION/goat" ] &&
     fact_file_is "$HOME/.goat/runtime/goat/versions/$FORCED_LIVE_VERSION/.install-complete" "$FORCED_LIVE_VERSION" &&
     [ -f "$FORCED_PREVIOUS_RUNNER" ] && fact_slurp "$STATE_DIR/identity"; then
    FORCED_PREVIOUS_IDENTITY="$FACT_TEXT"; FORCED_PREVIOUS_VERSION="$FORCED_LIVE_VERSION"
  fi
  # From publication on, a dropped SSH session must not end this script before the stop either
  # happened, with the detached supervisor taking over the start, or was undone.
  trap '' HUP PIPE
  # The new runner is published before the first signal, so a failed publication stops nothing.
  publish_selected_runner
  FORCED_PUBLISHED=1
  # The detached supervisor takes over the start and any rollback after the stop, so a host that
  # cannot run it keeps its runtime.
  nohup true >/dev/null 2>>"$LOG_FILE" </dev/null && [ -x "$RUNNER_FILE" ] ||
    forced_refused "the detached supervisor that starts the new runtime cannot run"
  printf 'Stopping GOAT PID %s (started %s, port %s) for an approved forced update.\\n' "$FORCE_PID" "$FORCE_START" "$FORCE_PORT" >>"$LOG_FILE" 2>/dev/null || :
  if ! forced_parent_holds; then forced_refused "it changed before the signal"; fi
  server_owns_listener "$FORCE_PID" "$FORCE_PORT" || forced_refused "it no longer listens on port $FORCE_PORT"
  if ! forced_signal_same TERM "$FORCE_PID" "" "$FORCE_START" "$forced_root_ticks" && server_alive "$FORCE_PID"; then
    forced_refused "it changed before the signal"
  fi
  forced_waited=0
  while server_alive "$FORCE_PID" && [ "$forced_waited" -lt "$DRAIN_GRACE_SECONDS" ]; do
    sleep 1 || forced_wait_failed SIGTERM; forced_waited=$((forced_waited + 1))
  done
  if server_alive "$FORCE_PID"; then
    # A process still running that no longer passes the checks may be the runtime after a bad read,
    # so nothing more is signalled or started and its records stay for a person.
    if ! forced_signal_same KILL "$FORCE_PID" "" "$FORCE_START" "$forced_root_ticks" && server_alive "$FORCE_PID"; then
      forced_refused "it no longer matched the approved runtime before SIGKILL"
    fi
    forced_waited=0
    while server_alive "$FORCE_PID" && [ "$forced_waited" -lt 10 ]; do sleep 1 || forced_wait_failed SIGKILL; forced_waited=$((forced_waited + 1)); done
    if forced_parent_holds; then
      forced_restore_runner
      printf 'GOAT PID %s on the remote host did not exit after SIGKILL; the update stopped. See %s.\\n' "$FORCE_PID" "$LOG_FILE" >&2; exit 1
    fi
    # Still running but no longer identifiable, as after a failed read: nothing more is started.
    if server_alive "$FORCE_PID"; then forced_refused "it was still running after SIGKILL and could not be identified"; fi
  fi
  # A shell cannot signal a child by anything firmer than its PID, which it may have given up by
  # then, so children are never signalled. A recorded child still running is named for a person.
  printf '%s' "$forced_children" | while read -r forced_child forced_parent forced_child_ticks forced_child_start; do
    [ -n "$forced_child" ] && server_alive "$forced_child" || continue
    [ "$(forced_start_of "$forced_child")" = "$forced_child_start" ] && [ "$(forced_ticks_of "$forced_child")" = "$forced_child_ticks" ] || continue
    printf 'GOAT did not signal child process %s of the stopped runtime, which still runs: a shell cannot prove the PID still names that child. Check it on the host.\\n' "$forced_child" >>"$LOG_FILE" 2>/dev/null || :
  done || :
  if [ -f "$DEFAULT_RUNTIME_FILE" ] && sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$DEFAULT_RUNTIME_FILE" 2>/dev/null | grep -qx "$FORCE_PID"; then
    rm -f "$DEFAULT_RUNTIME_FILE" 2>/dev/null || :
  fi
  # The runtime is gone, so a records cleanup that fails must not end the script before the
  # supervisor takes over; it rewrites these records for whatever it starts.
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity" "$STATE_DIR/draining" "$STATE_DIR/started" "$STATE_DIR/started.ticks" 2>/dev/null ||
    printf 'GOAT stopped PID %s but could not remove its launch records; the supervisor replaces them.\\n' "$FORCE_PID" >>"$LOG_FILE" 2>/dev/null || :
  printf 'Stopped GOAT PID %s for the approved forced update.\\n' "$FORCE_PID" >>"$LOG_FILE" 2>/dev/null || :
  FORCE_STOP=0; LIVE_STATUS=none; LIVE_PID=0; LIVE_PORT=0
}
if [ "$FORCE_STOP" = 1 ]; then forced_stop_runtime; FORCED_STOPPED_PID="$FORCE_PID"; fi
# After a forced stop and publication, the detached supervisor starts the new runtime on the same
# port, as a normal replacement does: a dropped SSH session cannot stop it, and when the new version
# does not start it restores the data and, if the stopped version can run again, starts it again.
forced_supervise_start() {
  if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then forced_spawn="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  else forced_spawn="$GOAT_NODE_SCRIPT_PATH"; fi
  forced_result="$STATE_DIR/replacement.result.$"
  # A result file that survives this removal is stale, so whatever it says is never reported.
  rm -f "$forced_result" 2>/dev/null || :
  forced_stale=0; [ ! -e "$forced_result" ] || forced_stale=1
  set --
  [ -n "$FORCED_PREVIOUS_VERSION" ] || rm -f "$FORCED_PREVIOUS_RUNNER" 2>/dev/null || :
  if [ -n "$FORCED_PREVIOUS_VERSION" ]; then
    set -- --previous-runner "$FORCED_PREVIOUS_RUNNER" --previous-version "$FORCED_PREVIOUS_VERSION" --previous-identity "$FORCED_PREVIOUS_IDENTITY"
  fi
  nohup "$RUNNER_FILE" __ssh-helper supervise --forced --old-stopped --old-pid "$FORCED_STOPPED_PID" --old-instance-id forced --port "$FORCE_PORT" --base-dir "$DEFAULT_SERVER_HOME" --state-dir "$STATE_DIR" --runner "$RUNNER_FILE" --target-version "$TARGET_VERSION" --identity "$forced_spawn serve --host 127.0.0.1 --port $FORCE_PORT --base-dir $DEFAULT_SERVER_HOME" "$@" --ready-timeout-ms "@@GOAT_READY_TIMEOUT_MS@@" --log "$LOG_FILE" --result "$forced_result" >/dev/null 2>>"$LOG_FILE" </dev/null &
  wait "$!" || true
  forced_status=absent; forced_new_pid=0; forced_new_version=
  if [ "$forced_stale" = 0 ] && [ -s "$forced_result" ]; then read -r forced_status forced_new_pid forced_new_version <"$forced_result" || true; fi
  rm -f "$forced_result" 2>/dev/null || :
  case "$forced_status" in
    replaced)
      # The supervisor already recorded this runtime, its start time included.
      REMOTE_PID="$forced_new_pid"; REMOTE_PORT="$FORCE_PORT"; REMOTE_MANAGED=managed; REFRESH_DECISION=replaced ;;
    stuck)
      printf 'GOAT %s, started as PID %s on the remote host, did not become ready and did not exit after SIGKILL; it was left running and nothing more was started. Check it on the host. See %s.\\n' "$forced_new_version" "$forced_new_pid" "$LOG_FILE" >&2; exit 1 ;;
    rolled-back)
      printf 'GOAT %s did not start on the remote host after the approved forced stop of PID %s; GOAT %s was started again. See %s.\\n' "$TARGET_VERSION" "$FORCED_STOPPED_PID" "$forced_new_version" "$LOG_FILE" >&2; exit 1 ;;
    absent)
      printf 'GOAT stopped PID %s on the remote host for the approved forced update, but the detached supervisor left no result, so GOAT cannot tell whether a runtime is running there now. Check the host and %s; if nothing runs, update again (no approval is needed).\\n' "$FORCED_STOPPED_PID" "$LOG_FILE" >&2; exit 1 ;;
    *)
      printf 'GOAT did not start %s on the remote host: after the approved forced stop of PID %s, the detached supervisor reported a failure and started no earlier runtime again. The reason is in %s. Check the host; if nothing runs, update again (no approval is needed).\\n' "$TARGET_VERSION" "$FORCED_STOPPED_PID" "$LOG_FILE" >&2; exit 1 ;;
  esac
}
# A confirmed drain that names an approved process goes only to that process: a runtime started in
# its place after the approval was never shown to the person.
forced_drain_allowed() {
  valid_positive "$FORCE_PID" || return 0
  [ "$UPGRADE_PID" = "$FORCE_PID" ] && [ "$UPGRADE_PORT" = "$FORCE_PORT" ] &&
    [ "$(printf '%s\\n' "$UPGRADE_START" | awk '{ $1 = $1; print }')" = "$FORCE_START" ] && return 0
  printf 'GOAT did not update the remote runtime: PID %s, the runtime you approved stopping, is no longer the one running there (PID %s is). It was left running. Ask again.\\n' "$FORCE_PID" "$UPGRADE_PID" >&2; exit 1
}
`;
