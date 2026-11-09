import { encodePowerShellCommand } from "@goat/shared/windowsHostProcess";

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
# Windows: each PowerShell start costs about 1.5 s, so one waits for server $1 to own the listener on
# port $2 every 0.1 s: exit 0 once it does, 3 once the server is gone, 4 at the epoch second $3. Run
# in the background, the job is PowerShell itself.
server_awaits_listener() {
  GOAT_PROCESS_ID="$1" GOAT_LISTEN_PORT="$2" GOAT_WAIT_UNTIL_MS="${"${"}3}000" MSYS2_ARG_CONV_EXCL='*' exec powershell.exe -NoProfile -NonInteractive -EncodedCommand '${encodePowerShellCommand(WINDOWS_AWAIT_LISTENER_POWERSHELL)}' </dev/null >/dev/null 2>&1
}
# True while the single-process job with PID $1 still runs.
listen_running() {
  case " $(jobs -pr 2>/dev/null | tr '\n' ' ') " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
# Ends single-process job $2 through its job spec $1, which bash refuses once the job is reaped and
# never sends to a dead process, so no reused PID is hit (bash loops forever on a pipeline job with
# a dead member). TERM, then KILL after up to 2 s of clock-checked waits; waited for only after.
end_job() {
  kill -TERM "$1" 2>/dev/null || :
  end_job_until=$(( $(date +%s) + 2 ))
  while listen_running "$2" && [ "$(date +%s)" -lt "$end_job_until" ]; do sleep 0.1; done
  if listen_running "$2"; then kill -KILL "$1" 2>/dev/null || :; fi
  wait "$2" 2>/dev/null || :
}
wait_launched_listener() {
  listen_deadline=$(( $(date +%s) + (@@GOAT_READY_TIMEOUT_MS@@ + 999) / 1000 ))
  LISTEN_GONE=
  if [ "$GOAT_HOST_WINDOWS" = 1 ]; then
    # tasklist and PowerShell can stall, so only the PowerShell child looks at the server. This shell
    # checks the clock and that child alone, ends it at the deadline, and returns 1 there, 2 once the
    # server is gone. Another exit, such as a failed start, starts a new child before the deadline.
    while [ "$(date +%s)" -lt "$listen_deadline" ]; do
      server_awaits_listener "$REMOTE_PID" "$REMOTE_PORT" "$listen_deadline" &
      listen_ps=$!
      while listen_running "$listen_ps"; do
        if [ "$(date +%s)" -ge "$listen_deadline" ]; then
          end_job '%?server_awaits_listener' "$listen_ps"
          return 1
        fi
        sleep 0.1
      done
      if wait "$listen_ps"; then listen_status=0; else listen_status=$?; fi
      case "$listen_status" in
        0) [ "$(date +%s)" -lt "$listen_deadline" ] && return 0; return 1 ;;
        3) LISTEN_GONE="$REMOTE_PID"; return 2 ;;
        4) return 1 ;;
      esac
      sleep 0.1
    done
    return 1
  fi
  while server_alive "$REMOTE_PID"; do
    [ "$(date +%s)" -lt "$listen_deadline" ] || return 1
    server_owns_listener "$REMOTE_PID" "$REMOTE_PORT" && return 0
    sleep 0.1
  done
  return 2
}
# After the listener wait. Windows: PowerShell's word that the server is gone stands; otherwise one
# tasklist runs as a job writing to a file (one process, for end_job). One that has not answered in
# 5 s is ended and counts as alive, and later checks in this script do not run tasklist again.
launch_server_alive() {
  [ "$GOAT_HOST_WINDOWS" = 1 ] || { server_alive "$1"; return; }
  [ "$LISTEN_GONE" != "$1" ] || return 1
  [ -z "$LAUNCH_TASKLIST_STALLED" ] || return 0
  MSYS2_ARG_CONV_EXCL='*' tasklist.exe /FI "PID eq $1" /NH /FO CSV </dev/null >"$STATE_DIR/alive.$$" 2>/dev/null &
  launch_probe=$!
  launch_probe_until=$(( $(date +%s) + 5 ))
  while listen_running "$launch_probe"; do
    if [ "$(date +%s)" -ge "$launch_probe_until" ]; then
      end_job '%?tasklist.exe' "$launch_probe"; LAUNCH_TASKLIST_STALLED=1
      rm -f "$STATE_DIR/alive.$$"; return 0
    fi
    sleep 0.1
  done
  wait "$launch_probe" 2>/dev/null || :
  if grep -q "^\"[^\"]*\",\"$1\"," "$STATE_DIR/alive.$$" 2>/dev/null; then launch_alive=0; else launch_alive=1; fi
  rm -f "$STATE_DIR/alive.$$"
  return "$launch_alive"
}
# Waits up to about 2 s for server $1 to exit.
launch_wait_exit() {
  launch_wait_count=0; launch_wait_until=$(( $(date +%s) + 3 ))
  while [ "$launch_wait_count" -lt 20 ] && [ "$(date +%s)" -lt "$launch_wait_until" ] &&
    launch_server_alive "$1"; do
    launch_wait_count=$((launch_wait_count + 1))
    sleep 0.1
  done
}
`;
