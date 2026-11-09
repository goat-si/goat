import {
  encodePowerShellCommand,
  WINDOWS_SPAWN_AND_WAIT_POWERSHELL,
  WINDOWS_STOP_RECORDED_POWERSHELL,
} from "@goat/shared/windowsHostProcess";

// Retained archives have a port-only wait-ready helper. Inspect the kernel's socket owner
// in the launch shell instead, without adding helper arguments or starts on reconnect.
const WINDOWS_AWAIT_LISTENER_POWERSHELL = String.raw`$ErrorActionPreference = 'Stop'
$id = [int]$env:GOAT_PROCESS_ID
$port = [int]$env:GOAT_LISTEN_PORT
$until = [long]$env:GOAT_WAIT_UNTIL_MS
while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $until) {
  if (-not (Get-Process -Id $id -ErrorAction SilentlyContinue)) { exit 3 }
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
  if ($connections | Where-Object { $_.OwningProcess -eq $id -and $_.LocalAddress -eq '127.0.0.1' }) { exit 0 }
  Start-Sleep -Milliseconds 100
}
exit 4`;

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
# netstat answers in about 0.15 s where a PowerShell start takes 1.5 s, but its state word is
# localized on some display languages. It proves server $1 owns 127.0.0.1:$2 only after it exited
# 0 within 5 s and its whole output has exactly one row from 127.0.0.1:$2 to 0.0.0.0:0, and it is
# TCP 127.0.0.1:$2 0.0.0.0:0 LISTENING $1. Output that ends mid-line was cut short and proves nothing.
# Bash only. read -d '' takes the file whole and succeeds only at a NUL byte, which netstat never
# prints (a command substitution would drop it).
listener_netstat_owns() {
  if launch_bounded 5 netstat.exe -ano -p TCP </dev/null >"$STATE_DIR/netstat.$$" 2>/dev/null; then
    listener_status=0; else listener_status=1; fi
  listener_netstat=
  if IFS= read -r -d '' listener_netstat 2>/dev/null <"$STATE_DIR/netstat.$$"; then listener_status=1; fi
  rm -f "$STATE_DIR/netstat.$$" || :
  [ "$listener_status" = 0 ] || return 1
  listener_pid="$1"; listener_port="$2"; listener_found=1
  printf -v listener_cr '\r'; printf -v IFS ' \t'; set -f
  while :; do
    case "$listener_netstat" in *"
"*) ;; *) [ -z "$listener_netstat" ] || return 1; break ;; esac
    listener_line="${"${"}listener_netstat%%"
"*}"
    listener_netstat="${"${"}listener_netstat#*"
"}"
    set -- ${"${"}listener_line%"$listener_cr"}
    [ "$#" -ge 3 ] && [ "$1" = TCP ] && [ "$2" = "127.0.0.1:$listener_port" ] && [ "$3" = 0.0.0.0:0 ] || continue
    [ "$#" = 5 ] && [ "$4" = LISTENING ] && [ "$5" = "$listener_pid" ] || return 1
    case "$5" in ''|*[!0123456789]*) return 1 ;; esac
    [ "$listener_found" = 1 ] || return 1
    listener_found=0
  done
  return "$listener_found"
}
server_owns_listener() (
  # Protocol parsing leaves noglob enabled; socket fd discovery needs expansion.
  set +f
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    if [ -n "${"${"}BASH_VERSION:-}" ] && listener_netstat_owns "$1" "$2"; then return 0; fi
    GOAT_PROCESS_ID="$1" GOAT_LISTEN_PORT="$2" launch_bounded 15 powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand("$ErrorActionPreference = 'Stop'; $connections = @(Get-NetTCPConnection -State Listen -LocalPort ([int]$env:GOAT_LISTEN_PORT) -ErrorAction Stop); if ($connections | Where-Object { $_.OwningProcess -eq [int]$env:GOAT_PROCESS_ID -and $_.LocalAddress -eq '127.0.0.1' }) { exit 0 }; exit 1")}' </dev/null >/dev/null 2>&1
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
# Sets launch_now_us to the wall clock in microseconds without a process where it can: bash 5's
# EPOCHREALTIME (its decimal point follows the locale), else SECONDS from one date per script.
LAUNCH_EPOCH_BASE=
launch_now() {
  launch_now_us="${"${"}EPOCHREALTIME:-}"
  case "$launch_now_us" in
    *[.,]*)
      launch_now_us="${"${"}launch_now_us%[.,]*}${"${"}launch_now_us#*[.,]}"
      case "$launch_now_us" in ''|*[!0123456789]*) ;; *) return 0 ;; esac ;;
  esac
  if [ -z "${"${"}SECONDS:-}" ]; then launch_now_us=$(( $(date +%s) * 1000000 )); return 0; fi
  [ -n "$LAUNCH_EPOCH_BASE" ] || LAUNCH_EPOCH_BASE=$(( $(date +%s) - SECONDS ))
  launch_now_us=$(( (LAUNCH_EPOCH_BASE + SECONDS) * 1000000 ))
}
# fd 7 is a private FIFO that only carries this shell's job list: bash lists it there and reads it
# back, and waits on it with read -t, so a pass starts no process. Its name is removed once open (the
# launch's EXIT trap removes it too). Any failed step falls back to tr and sleep, as does bash before
# 4, which crashes after a function that ran command exec returns and cannot read -t 0.05.
LAUNCH_FIFO=
launch_fifo_open() {
  LAUNCH_FIFO=0
  [ "${"${"}BASH_VERSINFO:-0}" -ge 4 ] || return 0
  # A killed script can leave its name behind. Only names of shells kill -0 finds gone are removed:
  # a live script's name stays, and one that loses its name before opening it falls back to sleep.
  case "$-" in *f*) launch_fifo_glob=1; set +f ;; *) launch_fifo_glob= ;; esac
  for launch_fifo_stale in "$STATE_DIR"/launch-tick.*; do
    launch_fifo_pid="${"${"}launch_fifo_stale##*.}"
    case "$launch_fifo_pid" in ''|*[!0123456789]*) continue ;; esac
    if [ -p "$launch_fifo_stale" ] && ! kill -0 "$launch_fifo_pid" 2>/dev/null; then
      rm -f "$launch_fifo_stale" || :
    fi
  done
  [ -z "$launch_fifo_glob" ] || set -f
  if mkfifo "$STATE_DIR/launch-tick.$$" 2>/dev/null; then
    if { command exec 7<>"$STATE_DIR/launch-tick.$$"; } 2>/dev/null; then LAUNCH_FIFO=1; fi
    rm -f "$STATE_DIR/launch-tick.$$" || :
  fi
}
launch_fifo_close() { LAUNCH_FIFO=0; exec 7<&-; }
# Waits $1 microseconds.
launch_pause() {
  launch_pause_s=$(( $1 % 1000000 + 1000000 )); launch_pause_s="$(( $1 / 1000000 )).${"${"}launch_pause_s#1}"
  if [ "$LAUNCH_FIFO" = 1 ]; then
    if read -t "$launch_pause_s" -u 7 launch_pause_line 2>/dev/null; then launch_pause_r=0; else launch_pause_r=$?; fi
    [ "$launch_pause_r" -le 128 ] || return 0
    launch_fifo_close
  fi
  sleep "$launch_pause_s"
}
# True while the single-process job with PID $1 still runs: bash lists a job as running only until
# it reaps it, so no reused PID can match.
listen_running() {
  if [ "$LAUNCH_FIFO" = 1 ]; then
    if jobs -pr >&7 2>/dev/null && echo . >&7 2>/dev/null; then
      listen_found=1
      while IFS= read -r -t 1 -u 7 listen_line; do
        case "$listen_line" in .) return "$listen_found" ;; "$1") listen_found=0 ;; esac
      done
    fi
    launch_fifo_close
  fi
  case " $(jobs -pr 2>/dev/null | tr '\n' ' ') " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
# Ends single-process job $2 through its job spec $1, which bash refuses once the job is reaped and
# never sends to a dead process, so no reused PID is hit (bash loops forever on a pipeline job with
# a dead member). TERM, then KILL after up to 2 s of clock-checked waits; waited for only after.
end_job() {
  kill -TERM "$1" 2>/dev/null || :
  launch_now; end_job_until=$((launch_now_us + 2000000))
  while listen_running "$2" && launch_now && [ "$launch_now_us" -lt "$end_job_until" ]; do launch_pause 100000; done
  if listen_running "$2"; then kill -KILL "$1" 2>/dev/null || :; fi
  wait "$2" 2>/dev/null || :
}
# The bounded job: the command replaces this subshell, so the job is that one process.
launch_bounded_job() { MSYS2_ARG_CONV_EXCL='*' exec "$@"; }
# Windows commands can stall, so after the listener wait starts every one the launch runs goes
# through here: command $2... runs for at most $1 s of clock and returns its own status, or 124 once
# it was ended at the bound. It is checked at once and then after 0.05, 0.1 and every 0.25 s. Other
# hosts, and shells other than bash, whose job specs cannot name it safely, run it directly.
launch_bounded() {
  if [ "$GOAT_HOST_WINDOWS" != 1 ] || [ -z "${"${"}BASH_VERSION:-}" ]; then shift; "$@"; return; fi
  [ -n "$LAUNCH_FIFO" ] || launch_fifo_open
  launch_now; launch_bound_until=$((launch_now_us + $1 * 1000000)); shift
  launch_bounded_job "$@" <&0 7<&- &
  launch_bound_job=$!
  launch_bound_step=50000
  while listen_running "$launch_bound_job"; do
    launch_now
    if [ "$launch_now_us" -ge "$launch_bound_until" ]; then
      end_job '%?launch_bounded_job' "$launch_bound_job"; return 124
    fi
    launch_bound_left=$((launch_bound_until - launch_now_us))
    [ "$launch_bound_left" -lt "$launch_bound_step" ] || launch_bound_left="$launch_bound_step"
    launch_pause "$launch_bound_left"
    case "$launch_bound_step" in 50000) launch_bound_step=100000 ;; *) launch_bound_step=250000 ;; esac
  done
  wait "$launch_bound_job"
}
# The launch runs under set -u; these start empty, before any check reads them.
LISTEN_GONE=; LAUNCH_TASKLIST_STALLED=; LAUNCH_SPAWN_STATUS=; REMOTE_BIRTH=
# Windows OpenSSH ends every process left in the session, so the server starts outside it. One
# PowerShell starts it, publishes its record and waits for its listener until the launch's
# deadline; wait_launched_listener takes that answer first. The record's PID and creation time
# (REMOTE_BIRTH) are all a failed launch may stop the server by.
windows_launch_server() {
  if [ "$GOAT_ARCHIVE_MODE" = 1 ]; then set -- "$(cygpath -w "$SPAWN_IDENTITY")"
  else set -- "$(cygpath -w "$(command -v node)")" "$(cygpath -w "$SPAWN_IDENTITY")"; fi
  export GOAT_RUNTIME_ORIGIN=ssh
  REMOTE_PID=; REMOTE_BIRTH=; launch_record_name="launch.$$.$LAUNCH_ATTEMPTS"
  launch_record="${"${"}LOG_FILE%/*}/$launch_record_name"
  launch_now; listen_deadline=$(( launch_now_us / 1000000 + (@@GOAT_READY_TIMEOUT_MS@@ + 999) / 1000 ))
  if windows_spawn_inputs "$LOG_FILE" "$@" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$(cygpath -w "$DEFAULT_SERVER_HOME")"; then
    if GOAT_SPAWN_CWD="$win_cwd" GOAT_SPAWN_LOG="$win_log" GOAT_SPAWN_ARGS="$win_args" GOAT_SPAWN_ENV='T3CODE_NO_BROWSER=1' \
      GOAT_SPAWN_RECORD="$launch_record_name" GOAT_LISTEN_PORT="$REMOTE_PORT" GOAT_WAIT_UNTIL_MS="$listen_deadline"000 \
      launch_bounded $((listen_deadline - launch_now_us / 1000000)) powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand(WINDOWS_SPAWN_AND_WAIT_POWERSHELL)}' </dev/null >/dev/null
    then LAUNCH_SPAWN_STATUS=0; else LAUNCH_SPAWN_STATUS=$?; fi
  else LAUNCH_SPAWN_STATUS=2; fi
  launch_pid=; launch_birth=; launch_rest=
  if [ -f "$launch_record" ]; then
    IFS=' ' read -r launch_pid launch_birth launch_rest <"$launch_record" || launch_pid=
    rm -f "$launch_record"
  fi
  case "$launch_birth" in ''|*[!0123456789]*) launch_pid= ;; esac
  if [ -z "$launch_rest" ] && valid_positive "$launch_pid"; then
    case "$LAUNCH_SPAWN_STATUS" in 6|7) ;; *) REMOTE_PID="$launch_pid"; REMOTE_BIRTH="$launch_birth"; return 0 ;; esac
  fi
  rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE" "$STATE_DIR/identity"
  printf 'Could not start the GOAT server outside the SSH session on this Windows host.\n' >&2
  tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
  # Without a record the PowerShell made no server (2-4) or ended the one it made (6); any other
  # answer, a stall or its death may leave one running that no record names, so none is stopped.
  case "$LAUNCH_SPAWN_STATUS" in 2|3|4|6) ;; *)
    printf 'GOAT could not confirm that the server it started stopped; it may still be running on this host.\n' >&2 ;;
  esac
  exit 1
}
wait_launched_listener() {
  LISTEN_GONE=
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    # Each PowerShell start costs about 1.5 s, so one waits for the server to own its listener,
    # checking it every 0.1 s: exit 0 once it does, 3 once the server is gone, 4 at the deadline.
    # The spawning PowerShell's answer comes first; a failed start (any other exit) is followed by
    # this wait alone, never a second spawn, before the same deadline.
    listen_status="$LAUNCH_SPAWN_STATUS"; LAUNCH_SPAWN_STATUS=
    if [ -z "$listen_status" ]; then
      launch_now; listen_deadline=$(( launch_now_us / 1000000 + (@@GOAT_READY_TIMEOUT_MS@@ + 999) / 1000 ))
    fi
    while :; do
      case "$listen_status" in
        0) launch_now; [ "$launch_now_us" -lt "$((listen_deadline * 1000000))" ] && return 0; return 1 ;;
        3) LISTEN_GONE="$REMOTE_PID"; return 2 ;;
        4|124) return 1 ;;
      esac
      [ -z "$listen_status" ] || launch_pause 100000
      launch_now; [ "$launch_now_us" -lt "$((listen_deadline * 1000000))" ] || return 1
      if GOAT_PROCESS_ID="$REMOTE_PID" GOAT_LISTEN_PORT="$REMOTE_PORT" GOAT_WAIT_UNTIL_MS="$listen_deadline"000 \
        launch_bounded $((listen_deadline - launch_now_us / 1000000)) powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand(WINDOWS_AWAIT_LISTENER_POWERSHELL)}' </dev/null >/dev/null 2>&1
      then listen_status=0; else listen_status=$?; fi
    done
  fi
  listen_deadline=$(( $(date +%s) + (@@GOAT_READY_TIMEOUT_MS@@ + 999) / 1000 ))
  while server_alive "$REMOTE_PID"; do
    [ "$(date +%s)" -lt "$listen_deadline" ] || return 1
    server_owns_listener "$REMOTE_PID" "$REMOTE_PORT" && return 0
    sleep 0.1
  done
  return 2
}
# After the listener wait. Windows: PowerShell's word that the server is gone stands; otherwise
# tasklist runs bounded to 5 s. Gone is only its localized "INFO: no tasks" answer: exit 0 and one
# line that is no CSV row but holds ": ". Anything else counts as alive, and after a timeout later
# checks in this script do not run tasklist again.
launch_server_alive() {
  [ "$GOAT_HOST_WINDOWS" = 1 ] || { server_alive "$1"; return; }
  [ "${"${"}LISTEN_GONE:-}" != "$1" ] || return 1
  [ -z "${"${"}LAUNCH_TASKLIST_STALLED:-}" ] || return 0
  if launch_bounded 5 tasklist.exe /FI "PID eq $1" /NH /FO CSV </dev/null >"$STATE_DIR/alive.$$" 2>/dev/null; then
    launch_probe=0; else launch_probe=$?; fi
  if [ "$launch_probe" = 124 ]; then LAUNCH_TASKLIST_STALLED=1; rm -f "$STATE_DIR/alive.$$"; return 0; fi
  launch_alive=0
  if [ "$launch_probe" = 0 ] && LC_ALL=C awk '{ sub(/\r$/, "") } $0 != "" { n++; line = $0 }
    END { exit !(n == 1 && substr(line, 1, 1) != "\"" && index(line, ": ") > 0) }' \
    "$STATE_DIR/alive.$$" 2>/dev/null; then launch_alive=1; fi
  rm -f "$STATE_DIR/alive.$$"
  return "$launch_alive"
}
# Stops server $1 after a failed launch. Windows: PowerShell's word that the server is gone
# stands; otherwise only the process with PID $1 and creation time $2, the launch record's, is
# ended, through one handle and bounded to 20 s; no PID alone is ever killed. Other hosts: kill,
# then up to about 2 s for the exit. A server not confirmed gone is reported as such.
launch_stop_server() {
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    [ "${"${"}LISTEN_GONE:-}" != "$1" ] || return 0
    if [ -n "$2" ] && GOAT_PROCESS_ID="$1" GOAT_PROCESS_BIRTH="$2" launch_bounded 20 powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand(WINDOWS_STOP_RECORDED_POWERSHELL)}' </dev/null >/dev/null 2>&1
    then launch_stop_status=0; else launch_stop_status=$?; fi
    case "$launch_stop_status" in 0|2) return 0 ;; esac
    printf 'GOAT could not confirm that the server (PID %s) stopped; it may still be running on this host.\n' "$1" >&2
    return 0
  fi
  if launch_server_alive "$1"; then server_kill "$1" || :; fi
  launch_stop_count=0; launch_stop_until=$(( $(date +%s) + 3 ))
  while [ "$launch_stop_count" -lt 20 ] && [ "$(date +%s)" -lt "$launch_stop_until" ] &&
    launch_server_alive "$1"; do
    launch_stop_count=$((launch_stop_count + 1))
    sleep 0.1
  done
  if launch_server_alive "$1"; then
    printf 'GOAT could not confirm that the server (PID %s) stopped; it may still be running on this host.\n' "$1" >&2
  fi
}
`;
