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
export const REMOTE_FORCED_STOP_SCRIPT = `forced_stop_runtime() {
  # A person approved stopping exactly this process. Every check runs again under the lock, and
  # a process that fails one is left running. Nothing is matched by name.
  forced_refused() {
    printf 'GOAT did not stop PID %s on the remote host because %s; it was left running. Ask again so the approval names the runtime running now.\\n' "$FORCE_PID" "$1" >&2; exit 1
  }
  forced_start_of() { server_start "$1" | awk '{ $1 = $1; print }'; }
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then forced_refused "GOAT cannot signal processes on a Windows host"; fi
  [ "$(readlink "$LOCK" 2>/dev/null || true)" = "$OWNER" ] || forced_refused "this client no longer holds the replacement lock"
  fact_file_is "$PID_FILE" "$FORCE_PID" && fact_file_is "$PORT_FILE" "$FORCE_PORT" || forced_refused "its launch records changed"
  server_alive "$FORCE_PID" || forced_refused "it is no longer running"
  [ "$(server_uid "$FORCE_PID" | tr -d ' ')" = "$(id -u)" ] || forced_refused "another user owns it"
  forced_start="$(forced_start_of "$FORCE_PID")"
  [ -n "$forced_start" ] && [ "$forced_start" = "$FORCE_START" ] || forced_refused "its start time differs from the approved one"
  server_owns_listener "$FORCE_PID" "$FORCE_PORT" || forced_refused "it does not listen on port $FORCE_PORT"
  # Signals $2 only while it is alive, this user's and started at $3, as read just before the signal.
  forced_signal_same() {
    server_alive "$2" && [ "$(server_uid "$2" | tr -d ' ')" = "$(id -u)" ] &&
      [ "$(forced_start_of "$2")" = "$3" ] && kill "-$1" "$2" 2>/dev/null
  }
  # One process table read binds each descendant to its owner and start time, so a PID that is
  # reused afterwards never matches its record. The table's own row for the runtime must still be
  # the approved process, or the children it lists belong to another one. Every row needs numeric
  # ids (macOS lists nobody as uid -2) and every descendant a whole start time;
  # anything else refuses before a signal. Ancestry walks stop after as many steps as the table has
  # rows, which only a parent loop reaches.
  forced_table="$(LC_ALL=C TZ=UTC ps -A -o pid= -o ppid= -o uid= -o lstart= 2>/dev/null)" || forced_refused "its process table could not be read"
  forced_root="$(printf '%s\\n' "$forced_table" | awk -v root="$FORCE_PID" '$1 == root { start = $4; for (i = 5; i <= NF; i++) start = start " " $i; print $3 " " start }')"
  [ "$forced_root" = "$(id -u) $FORCE_START" ] || forced_refused "the process table shows another process under its PID"
  forced_records="$(printf '%s\\n' "$forced_table" | awk -v root="$FORCE_PID" -v me="$(id -u)" '
    $1 !~ /^[0-9]+$/ || $2 !~ /^[0-9]+$/ || $3 !~ /^-?[0-9]+$/ { bad = 1 }
    { parent[$1] = $2; owner[$1] = $3; fields[$1] = NF; start = $4; for (i = 5; i <= NF; i++) start = start " " $i; started[$1] = start }
    END { if (bad) exit 1; for (pid in parent) { if (owner[pid] != me) continue; up = parent[pid]; for (depth = 0; depth < NR && up != ""; depth++) { if (up == root) { if (fields[pid] != 8) exit 1; print pid " " started[pid]; break } up = parent[up] } } }')" || forced_refused "its process table could not be read"
  printf 'Stopping GOAT PID %s (started %s, port %s) for an approved forced update.\\n' "$FORCE_PID" "$FORCE_START" "$FORCE_PORT" >>"$LOG_FILE" 2>/dev/null || :
  if ! forced_signal_same TERM "$FORCE_PID" "$FORCE_START" && server_alive "$FORCE_PID"; then
    forced_refused "it changed before the signal"
  fi
  forced_waited=0
  while server_alive "$FORCE_PID" && [ "$forced_waited" -lt "$DRAIN_GRACE_SECONDS" ]; do
    sleep 1; forced_waited=$((forced_waited + 1))
  done
  if server_alive "$FORCE_PID"; then
    forced_signal_same KILL "$FORCE_PID" "$FORCE_START" || :
    forced_waited=0
    while server_alive "$FORCE_PID" && [ "$forced_waited" -lt 10 ]; do sleep 1; forced_waited=$((forced_waited + 1)); done
    if server_alive "$FORCE_PID" && [ "$(forced_start_of "$FORCE_PID")" = "$FORCE_START" ]; then
      printf 'GOAT PID %s on the remote host did not exit after SIGKILL; the update stopped. See %s.\\n' "$FORCE_PID" "$LOG_FILE" >&2; exit 1
    fi
  fi
  forced_signal_children() {
    printf '%s\\n' "$forced_records" | while read -r forced_child forced_child_start; do
      valid_positive "$forced_child" || continue
      if forced_signal_same "$1" "$forced_child" "$forced_child_start"; then printf '%s\\n' "$forced_child"; fi
    done || :
  }
  forced_signalled="$(forced_signal_children TERM)" || forced_signalled=
  forced_waited=0
  while [ -n "$forced_signalled" ] && [ "$forced_waited" -lt 5 ]; do
    forced_left=
    for forced_child in $forced_signalled; do if server_alive "$forced_child"; then forced_left="$forced_left $forced_child"; fi; done
    [ -n "$forced_left" ] || break
    sleep 1; forced_waited=$((forced_waited + 1))
  done
  [ -z "$forced_signalled" ] || forced_signal_children KILL >/dev/null || :
  if [ -f "$DEFAULT_RUNTIME_FILE" ] && sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p' "$DEFAULT_RUNTIME_FILE" 2>/dev/null | grep -qx "$FORCE_PID"; then
    rm -f "$DEFAULT_RUNTIME_FILE"
  fi
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity" "$STATE_DIR/draining"
  FORCE_STOP=0; LIVE_STATUS=none; LIVE_PID=0; LIVE_PORT=0
}
if [ "$FORCE_STOP" = 1 ]; then forced_stop_runtime; fi
# A confirmed drain that names an approved process goes only to that process: a runtime started in
# its place after the approval was never shown to the person.
forced_drain_allowed() {
  valid_positive "$FORCE_PID" || return 0
  [ "$UPGRADE_PID" = "$FORCE_PID" ] && [ "$UPGRADE_PORT" = "$FORCE_PORT" ] &&
    [ "$(printf '%s\\n' "$UPGRADE_START" | awk '{ $1 = $1; print }')" = "$FORCE_START" ] && return 0
  printf 'GOAT did not update the remote runtime: PID %s, the runtime you approved stopping, is no longer the one running there (PID %s is). It was left running. Ask again.\\n' "$FORCE_PID" "$UPGRADE_PID" >&2; exit 1
}
`;
