import { REMOTE_COMBINED_CALL_SCRIPT } from "./runtimeFactsFrameScripts.ts";

// The first pairing after a launch asked the new server's live and compat facts with one goat start
// each, about a second apiece on Git Bash. A Windows launch whose goat lists wait-ready-report asks
// them in its readiness wait instead and records them under live_fact's and compat_fact's rules, so
// that pairing finds them. Launch only: it reads the launch's runner, record and launch files.
export const REMOTE_LAUNCH_READY_REPORT_SCRIPT = `${REMOTE_COMBINED_CALL_SCRIPT}
LAUNCH_CAPS_FILE=
# Asks, in the background while the launched server starts, what the selected goat supports. The
# answer counts only when it is complete as the readiness wait starts; nothing waits for it.
launch_caps_begin() {
  LAUNCH_CAPS_FILE=
  [ "$GOAT_HOST_WINDOWS" = 1 ] && [ "$GOAT_ARCHIVE_MODE" = 1 ] && [ -n "$FACT_MEMO" ] || return 0
  LAUNCH_CAPS_FILE="$FACT_MEMO.caps-answer"
  # An earlier process with this PID may have left one behind.
  if [ -e "$LAUNCH_CAPS_FILE" ] || [ -e "$LAUNCH_CAPS_FILE.next" ]; then
    rm -f "$LAUNCH_CAPS_FILE" "$LAUNCH_CAPS_FILE.next" || { LAUNCH_CAPS_FILE=; return 0; }
  fi
  launch_caps_exe="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  (
    set +e; caps_key=
    helper_caps "$launch_caps_exe"
    printf '%s\\n%s\\n' "$caps_key" "$HELPER_CAPS" >"$LAUNCH_CAPS_FILE.next" &&
      mv -f "$LAUNCH_CAPS_FILE.next" "$LAUNCH_CAPS_FILE"
  ) </dev/null >/dev/null 2>&1 &
}
# Waits $1 ms for the launched server, as wait_ready does, and fails as it would.
launch_wait_ready() {
  if launch_ready_report "$1"; then return "$LAUNCH_READY"; fi
  wait_ready "$1"
}
# Sets LAUNCH_READY to 0 for a server the report saw ready on REMOTE_PORT, else 1, and fails when
# the report cannot be used: the lookup was incomplete or found no support, the executable changed
# since, or the call failed or printed anything but a whole valid frame. A wait is a read, so the
# separate wait then runs, which a ready server answers at once. Live and compat are recorded only
# for the record's own server, REMOTE_PID on REMOTE_PORT, when its live key was present before the
# call and unchanged after it, the runner still runs the executable the lookup was for, and both
# answers pass the checks live_fact and compat_fact record by.
launch_ready_report() {
  LAUNCH_READY=1
  [ -n "$LAUNCH_CAPS_FILE" ] && [ -f "$LAUNCH_CAPS_FILE" ] || return 1
  { IFS= read -r report_caps_key && IFS= read -r report_caps; } <"$LAUNCH_CAPS_FILE" || return 1
  case " $report_caps " in *" wait-ready-report "*) ;; *) return 1 ;; esac
  report_exe="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  exec_fact_key "$report_exe" && [ "$FACT_KEY" = "$report_caps_key" ] || return 1
  report_before=; ! live_fact_key "$RUNNER_FILE" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" || report_before="$FACT_KEY"
  launch_bounded $(( ($1 + 999) / 1000 + 10 )) "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@GOAT_READY_PROBE_TIMEOUT_MS@@" \\
    --report --runtime-file "$DEFAULT_RUNTIME_FILE" --port-file "$PORT_FILE" --pid-file "$PID_FILE" >"$FACT_MEMO.report" 2>/dev/null || return 1
  fact_slurp "$FACT_MEMO.report" || return 1
  frame_parse wait-ready "ready live" "$FACT_TEXT" || return 1
  [ "$FRAME_READY" != "ok $REMOTE_PORT" ] || LAUNCH_READY=0
  [ "$LAUNCH_READY" = 0 ] && [ -n "$report_before" ] || return 0
  live_fact_key "$RUNNER_FILE" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" && [ "$FACT_KEY" = "$report_before" ] || return 0
  report_name="$FACT_NAME"; report_runner="$fact_live"
  exec_fact_key "$report_exe" && [ "$FACT_KEY" = "$report_caps_key" ] &&
    [ "\${report_runner% *}" = "\${report_caps_key% *}" ] || return 0
  case "$FRAME_LIVE" in "ok "*) report_live="\${FRAME_LIVE#ok }" ;; *) return 0 ;; esac
  case "$FRAME_COMPAT" in "ok "*) report_compat="\${FRAME_COMPAT#ok }" ;; *) return 0 ;; esac
  fact_valid live "$report_live" && fact_valid compat "$report_compat" || return 0
  facts_frame_live_ids "$report_live"
  [ "$frame_pid" = "$REMOTE_PID" ] && [ "$frame_port" = "$REMOTE_PORT" ] &&
    fact_bound "$frame_pid" "$frame_port" || return 0
  fact_put "live.$report_name" "$report_before" "$report_live"
  fact_put "compat.$report_name" "$report_before|$frame_port" "$report_compat"
}
`;
