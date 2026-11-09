import { REMOTE_COMBINED_CALL_SCRIPT } from "./runtimeFactsFrameScripts.ts";

// A fresh Windows launch started its candidate runner three times, about a second each on Git
// Bash, for its version, its own protocol and the live server. The setup defines this before it
// pins the candidate; the launch's readiness report later in the same script uses the same calls.
export const REMOTE_LAUNCH_FACTS_SCRIPT = `${REMOTE_COMBINED_CALL_SCRIPT}
# Declared contract extension: for the client's own runtime version reached through the candidate
# runner this launch just wrote and pinned, facts --version, --own and --live answer as --version,
# protocol --shell and protocol --runtime-file ... --shell do (the same functions in apps/server,
# pinned by its contract test). So one start asks the questions not yet answered, when two or
# more are missing, and its answers are recorded under the rules of the calls they stand for:
# version and own under the pin's exec key, which holds its digest, so a young pin rewritten within
# its second misses; live only as live_fact would keep it, bound to a live key that held across the
# call or, for no server, in this script's memo, which live_fact reads only while all three files
# stay absent. Any other runner, a key that changed or any invalid answer records nothing, leaves
# no marker, and the separate calls run as before.
launch_want() { launch_asks="$launch_asks --$1"; launch_tags="$launch_tags $1"; launch_count=$((launch_count + 1)); }
launch_facts_ask() {
  [ -n "$OWN_RUNTIME_VERSION" ] && [ "$PRESERVE_SELECTED_RUNNER" = 0 ] && [ -n "$FACT_MEMO" ] || return 0
  launch_pin="$RUNNER_CANDIDATE_FILE.pin"
  runner_key_hints "$launch_pin"
  [ -z "$RUNNER_NODE_DECLARED" ] && [ "$RUNNER_ARCHIVE_VERSION" = "$OWN_RUNTIME_VERSION" ] || return 0
  exec_fact_key "$launch_pin" && [ "$FACT_NAME" = "$OWN_RUNTIME_VERSION.runner" ] || return 0
  launch_name="$FACT_NAME"; launch_key="$FACT_KEY"; launch_exec="$FACT_NAME $FACT_KEY"
  launch_asks=; launch_tags=; launch_count=0; launch_absent=; launch_live=
  fact_get "version.$launch_name" "$launch_key" >/dev/null || launch_want version
  fact_get "own.$launch_name" "$launch_key" >/dev/null || launch_want own
  if live_none_absent "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE"; then
    launch_absent=1
    live_none_get "$launch_exec" >/dev/null || launch_want live
  elif live_fact_key "$launch_pin" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE"; then
    launch_live="$FACT_KEY"
    fact_get "live.$launch_name" "$launch_live" >/dev/null || launch_want live
  fi
  [ "$launch_count" -ge 2 ] || return 0
  frame_direct_call "$launch_pin" __ssh-helper facts --with-caps $launch_asks --runtime-file "$DEFAULT_RUNTIME_FILE" --port-file "$PORT_FILE" --pid-file "$PID_FILE" || return 0
  exec_fact_key "$launch_pin" && [ "$FACT_NAME $FACT_KEY" = "$launch_exec" ] || return 0
  launch_held=
  if [ -n "$launch_absent" ]; then
    ! live_none_absent "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" || launch_held=absent
  elif [ -n "$launch_live" ] && live_fact_key "$launch_pin" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" &&
       [ "$FACT_KEY" = "$launch_live" ]; then
    launch_held=live
  fi
  frame_parse facts "$launch_tags" "$frame_out" caps || return 0
  case " $launch_tags " in *" version "*) [ "$FRAME_VERSION" = "ok goat v$OWN_RUNTIME_VERSION" ] || return 0 ;; esac
  case " $launch_tags " in *" own "*)
    case "$FRAME_OWN" in "ok $OWN_RUNTIME_VERSION "*) ;; *) return 0 ;; esac
    (set -f; set -- \${FRAME_OWN#ok }; valid_own_tokens "$@") || return 0 ;;
  esac
  case " $launch_tags " in *" live "*)
    case "$FRAME_LIVE" in "ok "*) ;; *) return 0 ;; esac
    (set -f; set -- \${FRAME_LIVE#ok }; valid_live_tokens "$@") || return 0 ;;
  esac
  [ -z "$FRAME_VERSION" ] || fact_put "version.$launch_name" "$launch_key" "\${FRAME_VERSION#ok }"
  [ -z "$FRAME_OWN" ] || fact_put "own.$launch_name" "$launch_key" "\${FRAME_OWN#ok }"
  case "$launch_held $FRAME_LIVE" in
    "absent ok none unknown unknown unknown 0 0") frame_memo_put live-none "$launch_exec" "\${FRAME_LIVE#ok }" ;;
    "live ok live "*)
      facts_frame_live_ids "\${FRAME_LIVE#ok }"
      if fact_valid live "\${FRAME_LIVE#ok }" && fact_bound "$frame_pid" "$frame_port"; then
        fact_put "live.$launch_name" "$launch_live" "\${FRAME_LIVE#ok }"
      fi ;;
  esac
}
`;
