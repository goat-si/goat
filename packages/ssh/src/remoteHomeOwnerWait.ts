export const REMOTE_HOME_OWNER_WAIT_SECONDS = 60;

export const REMOTE_HOME_OWNER_WAIT = `HOME_OWNER_WAIT_LIMIT=${REMOTE_HOME_OWNER_WAIT_SECONDS}
wait_for_home_owner() {
  home_marker="$DEFAULT_SERVER_HOME/runtime/service-update-handoff.json"
  if [ ! -e "$home_marker" ] && [ ! -L "$home_marker" ]; then
    if [ ! -e "$DEFAULT_SERVER_HOME/runtime/service-serving.lock" ] &&
       [ ! -L "$DEFAULT_SERVER_HOME/runtime/service-serving.lock" ] &&
       [ ! -e "$DEFAULT_SERVER_HOME/userdata/server-owner.lock" ] &&
       [ ! -L "$DEFAULT_SERVER_HOME/userdata/server-owner.lock" ] &&
       [ ! -e "$DEFAULT_SERVER_HOME/userdata/server-owner.sqlite" ] &&
       [ ! -L "$DEFAULT_SERVER_HOME/userdata/server-owner.sqlite" ]; then return 0; fi
    if home_live="$(live_fact "$RUNNER_CANDIDATE_FILE.pin" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 2>/dev/null)"; then
      case "$home_live" in 'live '*) return 0 ;; esac
    fi
  fi
  home_waited=0
  home_deadline=$(($(date +%s) + HOME_OWNER_WAIT_LIMIT))
  while :; do
    if home_owner_result="$("$RUNNER_CANDIDATE_FILE.pin" __ssh-helper home-owned "$DEFAULT_SERVER_HOME" 2>/dev/null)"; then :
    else
      if [ "$home_owner_result" = inspection-error ]; then
        printf 'Cannot inspect GOAT home ownership; no second server was started.\\n' >&2
        return 1
      fi
      return 0
    fi
    if [ "$home_owner_result" != updating ] &&
       home_live="$(live_fact "$RUNNER_CANDIDATE_FILE.pin" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 2>/dev/null)"; then
      case "$home_live" in 'live '*) return 0 ;; esac
    fi
    if [ "$home_waited" -ge "$HOME_OWNER_WAIT_LIMIT" ] || [ "$(date +%s)" -ge "$home_deadline" ]; then
      if [ "$home_owner_result" = updating ]; then
        printf 'Remote GOAT is updating; retry after the update finishes.\\n' >&2
        return 1
      fi
      printf 'A GOAT server or boot service holds %s but did not become ready; no second server was started.\\n' "$DEFAULT_SERVER_HOME" >&2
      return 1
    fi
    sleep 1
    home_waited=$((home_waited + 1))
  done
}
`;
