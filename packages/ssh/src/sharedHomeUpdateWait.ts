import {
  SHARED_HOME_DESKTOP_UPDATE_MARKER,
  SHARED_HOME_DESKTOP_UPDATE_TTL_SECONDS,
} from "@goat/shared/desktopAppServer";

// The only shared location is the SSH runtime's own home. A fresh runtime record is published
// after readiness. Each iteration is also counted so a stopped host clock cannot extend the wait.
export const SHARED_HOME_UPDATE_WAIT = `goat_wait_shared_home_update() (
  update_marker="$HOME/.goat/runtime/${SHARED_HOME_DESKTOP_UPDATE_MARKER}"
  update_record="$HOME/.goat/userdata/server-runtime.json"
  update_rounds=0
  while [ "$update_rounds" -lt ${SHARED_HOME_DESKTOP_UPDATE_TTL_SECONDS} ] &&
        [ -f "$update_marker" ] && [ ! -L "$update_marker" ]; do
    IFS=' ' read -r update_expiry update_owner update_extra < "$update_marker" || break
    case "$update_expiry" in ''|0*|*[!0-9]*) break ;; esac
    case "$update_owner" in ''|*[!0-9-]*) break ;; esac
    [ -z "$update_extra" ] || break
    update_now="$(date +%s)" || break
    [ "$update_expiry" -gt "$update_now" ] 2>/dev/null &&
      [ "$update_expiry" -le "$((update_now + ${SHARED_HOME_DESKTOP_UPDATE_TTL_SECONDS}))" ] 2>/dev/null || break
    if [ ! -L "$update_record" ] && [ "$update_record" -nt "$update_marker" ]; then break; fi
    update_rounds=$((update_rounds + 1))
    sleep 1 || break
  done
)
`;
