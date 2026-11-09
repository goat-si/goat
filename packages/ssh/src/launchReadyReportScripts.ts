import { REMOTE_COMBINED_CALL_SCRIPT } from "./runtimeFactsFrameScripts.ts";

// The first pairing after a launch asked the new server's live and compat facts with one goat start
// each, about a second apiece on Git Bash. A Windows launch whose goat lists wait-ready-report asks
// them in its readiness wait instead and records them under live_fact's and compat_fact's rules, so
// that pairing finds them. Launch only: it reads the launch's runner, record and launch files.
export const REMOTE_LAUNCH_READY_REPORT_SCRIPT = `${REMOTE_COMBINED_CALL_SCRIPT}
LAUNCH_CAPS_FILE=
# Asks, once per launch and in the background while the launched server starts, what the selected
# goat supports. The answer counts only when it is complete as the readiness wait starts; nothing
# waits for it, so files of a launch that ended first are removed by a later one.
launch_caps_begin() {
  [ -z "$LAUNCH_CAPS_FILE" ] || return 0
  [ "$GOAT_HOST_WINDOWS" = 1 ] && [ "$GOAT_ARCHIVE_MODE" = 1 ] && [ -n "$FACT_MEMO" ] || return 0
  launch_report_paths || return 0
  launch_caps_sweep
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
# The report runs as a bounded job, which turns off MSYS's argument conversion, so goat.exe is given
# native paths. Sets LAUNCH_REPORT_RUNTIME, _PORT and _PID, or fails when a path is not on a drive.
launch_report_paths() {
  LAUNCH_REPORT_RUNTIME=; LAUNCH_REPORT_PORT=; LAUNCH_REPORT_PID=
  launch_native_path "$DEFAULT_RUNTIME_FILE" || return 1; LAUNCH_REPORT_RUNTIME="$LAUNCH_NATIVE"
  launch_native_path "$PORT_FILE" || return 1; LAUNCH_REPORT_PORT="$LAUNCH_NATIVE"
  launch_native_path "$PID_FILE" || return 1; LAUNCH_REPORT_PID="$LAUNCH_NATIVE"
}
# Sets LAUNCH_NATIVE to Git Bash drive path $1 (/c/rest) as Windows names it (c:/rest), with
# builtins: a cygpath start could stall after the server is spawned. Fails for any other path.
launch_native_path() {
  case "$1" in /[ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz]/*) ;; *) return 1 ;; esac
  native_drive="\${1#/}"; native_drive="\${native_drive%%/*}"
  LAUNCH_NATIVE="$native_drive:\${1#/?}"
}
# Removes what the lookup and report of launches no longer running left beside their memos.
launch_caps_sweep() {
  case "$-" in *f*) caps_sweep_glob=1; set +f ;; *) caps_sweep_glob= ;; esac
  for caps_sweep_file in "$STATE_DIR"/run-t3.next.*.facts.caps-* "$STATE_DIR"/run-t3.next.*.facts.report; do
    caps_sweep_pid="\${caps_sweep_file#"$STATE_DIR"/run-t3.next.}"; caps_sweep_pid="\${caps_sweep_pid%%.*}"
    case "$caps_sweep_pid" in ''|*[!0123456789]*) continue ;; esac
    if [ -e "$caps_sweep_file" ] && ! kill -0 "$caps_sweep_pid" 2>/dev/null; then rm -f "$caps_sweep_file" || :; fi
  done
  [ -z "$caps_sweep_glob" ] || set -f
}
# The facts are keyed by the server's runtime record, which it writes once started, possibly after
# it first answers. Waits for the record to name REMOTE_PID, checking it without starting a process
# up to 50 times 0.1 s apart: a count, so a clock stepped back cannot lengthen the wait.
launch_record_wait() {
  launch_record_left=50
  while :; do
    if fact_read_record "$DEFAULT_RUNTIME_FILE"; then
      fact_json_uint '"pid"' "$FACT_TEXT"
      [ "$FACT_TEXT" != "$REMOTE_PID" ] || return 0
    fi
    [ "$launch_record_left" -gt 0 ] || return 1
    launch_record_left=$((launch_record_left - 1))
    launch_pause 100000
  done
}
# Waits $1 ms for the launched server, as wait_ready does, and fails as it would.
launch_wait_ready() {
  if launch_ready_report "$1"; then return "$LAUNCH_READY"; fi
  wait_ready "$1"
}
# Sets LAUNCH_READY to 0 for a server the report saw ready on REMOTE_PORT, else 1, and fails when
# the report cannot be used: the lookup was incomplete or found no support, the executable changed
# since, the record never named the launched server, or the call failed or printed anything but a
# whole valid frame with a ready answer for REMOTE_PORT or a failure and live and compat answers
# that pass their validators. A wait is a read, so the separate wait then runs, which a ready
# server answers at once. Live and compat are recorded only for the record's own server, REMOTE_PID
# on REMOTE_PORT, when its live key was present before the call and unchanged after it, the runner
# still runs the executable the lookup was for, and both pass the checks live_fact and compat_fact
# record by.
launch_ready_report() {
  LAUNCH_READY=1
  [ -n "$LAUNCH_CAPS_FILE" ] && [ -f "$LAUNCH_CAPS_FILE" ] || return 1
  { IFS= read -r report_caps_key && IFS= read -r report_caps; } <"$LAUNCH_CAPS_FILE" || return 1
  case " $report_caps " in *" wait-ready-report "*) ;; *) return 1 ;; esac
  report_exe="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  exec_fact_key "$report_exe" && [ "$FACT_KEY" = "$report_caps_key" ] || return 1
  launch_record_wait || return 1
  report_before=; ! live_fact_key "$RUNNER_FILE" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" || report_before="$FACT_KEY"
  launch_bounded $(( ($1 + 999) / 1000 + 10 )) "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@GOAT_READY_PROBE_TIMEOUT_MS@@" \\
    --report --runtime-file "$LAUNCH_REPORT_RUNTIME" --port-file "$LAUNCH_REPORT_PORT" --pid-file "$LAUNCH_REPORT_PID" >"$FACT_MEMO.report" 2>/dev/null || return 1
  fact_slurp "$FACT_MEMO.report" || return 1
  frame_parse wait-ready "ready live" "$FACT_TEXT" || return 1
  case "$FRAME_READY" in "ok $REMOTE_PORT") LAUNCH_READY=0 ;; "fail "*) ;; *) return 1 ;; esac
  case "$FRAME_LIVE" in "ok "*) (set -f; set -- \${FRAME_LIVE#ok }; valid_live_tokens "$@") || return 1 ;; esac
  case "$FRAME_COMPAT" in "ok "*) facts_frame_compat_valid "\${FRAME_COMPAT#ok }" || return 1 ;; esac
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
