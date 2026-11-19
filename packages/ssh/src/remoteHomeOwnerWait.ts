export const REMOTE_HOME_OWNER_WAIT_SECONDS = 60;
export const REMOTE_HOME_OWNER_WAIT_MARKER = "GOAT_HOME_OWNER_WAITING";

export const REMOTE_HOME_OWNER_WAIT = `HOME_OWNER_WAIT_LIMIT=${REMOTE_HOME_OWNER_WAIT_SECONDS}
HOME_OWNER_PROBE_LIMIT=10
home_probe() {
  home_probe_deadline="$1"; shift
  home_probe_kind="\${3:-}"
  home_probe_remaining=$((home_probe_deadline - $(date +%s)))
  [ "$home_probe_remaining" -gt 0 ] || return 124
  [ "$home_probe_remaining" -le "$HOME_OWNER_PROBE_LIMIT" ] || home_probe_remaining="$HOME_OWNER_PROBE_LIMIT"
  home_probe_out="$STATE_DIR/home-probe.$$.out"
  home_probe_timeout="$STATE_DIR/home-probe.$$.timeout"
  rm -f "$home_probe_out" "$home_probe_timeout"
  ( ulimit -f 8; exec "$@" --deadline-ms "$((home_probe_remaining * 1000))" ) >"$home_probe_out" 2>/dev/null &
  home_probe_pid=$!
  (
    home_probe_sleeper=
    trap '[ -z "$home_probe_sleeper" ] || { kill "$home_probe_sleeper" 2>/dev/null || :; wait "$home_probe_sleeper" 2>/dev/null || :; }; exit 0' TERM
    sleep "$home_probe_remaining" & home_probe_sleeper=$!
    wait "$home_probe_sleeper" || exit 0
    if kill -0 "$home_probe_pid" 2>/dev/null; then
      : >"$home_probe_timeout"
      kill -KILL "$home_probe_pid" 2>/dev/null || :
    fi
  ) </dev/null >/dev/null 2>&1 &
  home_probe_watchdog=$!
  home_probe_status=0; wait "$home_probe_pid" || home_probe_status=$?
  kill "$home_probe_watchdog" 2>/dev/null || :; wait "$home_probe_watchdog" 2>/dev/null || :
  [ ! -e "$home_probe_timeout" ] || home_probe_status=124
  if [ "$home_probe_kind" = home-owned ]; then
    if [ "$home_probe_status" -eq 1 ] && [ -s "$home_probe_out" ]; then home_probe_status=2; fi
    if [ "$home_probe_status" -eq 0 ] && [ -s "$home_probe_out" ]; then
      printf 'updating\\n' | cmp -s - "$home_probe_out" || home_probe_status=2
    fi
  fi
  cat "$home_probe_out" 2>/dev/null || :
  rm -f "$home_probe_out" "$home_probe_timeout"
  return "$home_probe_status"
}
home_inspection_failed() {
  printf 'Cannot inspect GOAT home ownership; no second server was started.\\n' >&2
  return 1
}
wait_for_home_owner() {
  home_marker="$DEFAULT_SERVER_HOME/runtime/service-update-handoff.json"
  home_deadline=$(($(date +%s) + HOME_OWNER_WAIT_LIMIT))
  if [ ! -e "$home_marker" ] && [ ! -L "$home_marker" ]; then
    if [ ! -e "$DEFAULT_SERVER_HOME/runtime/service-serving.lock" ] &&
       [ ! -L "$DEFAULT_SERVER_HOME/runtime/service-serving.lock" ] &&
       [ ! -e "$DEFAULT_SERVER_HOME/userdata/server-owner.lock" ] &&
       [ ! -L "$DEFAULT_SERVER_HOME/userdata/server-owner.lock" ] &&
       [ ! -e "$DEFAULT_SERVER_HOME/userdata/server-owner.sqlite" ] &&
       [ ! -L "$DEFAULT_SERVER_HOME/userdata/server-owner.sqlite" ]; then return 0; fi
    if home_live="$(HOME_PROBE_DEADLINE="$home_deadline" live_fact "$RUNNER_CANDIDATE_FILE.pin" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 2>/dev/null)"; then
      case "$home_live" in 'live '*) return 0 ;; esac
    else
      home_live_status=$?; { [ "$home_live_status" -ne 124 ] && [ "$home_live_status" -le 125 ]; } || { home_inspection_failed; return 1; }
    fi
  fi
  home_waited=0
  home_owner_result=
  while :; do
    if [ "$home_waited" -ge "$HOME_OWNER_WAIT_LIMIT" ] || [ "$(date +%s)" -ge "$home_deadline" ]; then
      if [ "$home_owner_result" = updating ]; then
        printf 'Remote GOAT is updating; retry after the update finishes.\\n' >&2
        return 1
      fi
      printf 'A GOAT server or boot service holds %s but did not become ready; no second server was started.\\n' "$DEFAULT_SERVER_HOME" >&2
      return 1
    fi
    if home_owner_result="$(home_probe "$home_deadline" "$RUNNER_CANDIDATE_FILE.pin" __ssh-helper home-owned "$DEFAULT_SERVER_HOME")"; then
      case "$home_owner_result" in inspection-error|timeout) home_inspection_failed; return 1 ;; esac
      case "$home_owner_result" in ''|updating) : ;; *) home_inspection_failed; return 1 ;; esac
    else
      home_owner_status=$?
      if [ "$home_owner_status" -eq 1 ] && [ -n "$home_owner_result" ]; then home_inspection_failed; return 1; fi
      if [ "$home_owner_result" = inspection-error ] || [ "$home_owner_result" = timeout ] || [ "$home_owner_status" -ne 1 ]; then
        home_inspection_failed; return 1
      fi
      return 0
    fi
    if [ "$home_owner_result" != updating ] &&
       home_live="$(HOME_PROBE_DEADLINE="$home_deadline" live_fact "$RUNNER_CANDIDATE_FILE.pin" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 2>/dev/null)"; then
      case "$home_live" in 'live '*) return 0 ;; esac
    else
      home_live_status=$?; { [ "$home_live_status" -ne 124 ] && [ "$home_live_status" -le 125 ]; } || { home_inspection_failed; return 1; }
    fi
    [ "$home_waited" -ne 0 ] || printf '${REMOTE_HOME_OWNER_WAIT_MARKER}\\n' >&2
    sleep 1
    home_waited=$((home_waited + 1))
  done
}
`;
