import { OLD_HELPER_CAPS_STDERR } from "./runtimeFactsScripts.ts";

// A goat.exe start costs about a second on Git Bash; a runtime listing "facts" answers the first
// probe's four questions in one. Old runtimes pay one failed start per install, recorded as none.
// Probe only: it reads the probe's runtime_file and state.
export const REMOTE_FACTS_FRAME_SCRIPT = `helper_caps_old='${OLD_HELPER_CAPS_STDERR}'
# Sets HELPER_CAPS to the combined calls goat $1 supports, empty for none. An answer is recorded
# under the executable's key when that key holds across the call: a well-formed "caps v1" line on
# exit 0 with nothing on stderr, or an old runtime's exact unknown-subcommand failure as "caps v1".
# Anything else (another status, a signal, other or longer output) counts as none for this script.
helper_caps() {
  HELPER_CAPS=
  exec_fact_key "$1" || return 0
  caps_name="caps.$FACT_NAME"; caps_key="$FACT_KEY"
  if caps_line="$(fact_get "$caps_name" "$caps_key")"; then
    HELPER_CAPS="\${caps_line#caps v1}"; HELPER_CAPS="\${HELPER_CAPS# }"; return 0
  fi
  # Read as stderr, a mark, stdout, then the exit mark and status, each stream bounded while it is
  # read. A capture is whole only when it ends in the exit mark and a status: head keeps a prefix.
  caps_mark="$fact_nl:goat-caps-out:"; caps_exit="$fact_nl:goat-caps-exit:"
  caps_raw="$({ caps_out="$({ caps_s=0; "$1" __ssh-helper capabilities 2>&3 || caps_s=$?
      printf '%s%s:' "$caps_exit" "$caps_s"; } | head -c 4096)"
    printf '%s%s' "$caps_mark" "$caps_out"; } 3>&1 | head -c 8192)" || caps_raw=
  case "$caps_raw" in *"$caps_mark"*"$caps_mark"*) return 0 ;; *"$caps_mark"*"$caps_exit"*:) ;; *) return 0 ;; esac
  caps_err="\${caps_raw%%"$caps_mark"*}"; caps_rest="\${caps_raw#*"$caps_mark"}"
  caps_status="\${caps_rest##*"$caps_exit"}"; caps_status="\${caps_status%:}"
  caps_out="\${caps_rest%"$caps_exit"*}"
  case "$caps_status" in ''|*[!0123456789]*) return 0 ;; esac
  if [ "$caps_status" = 0 ] && [ -z "$caps_err" ]; then
    case "$caps_out" in *"$fact_nl"*"$fact_nl"*) return 0 ;; *"$fact_nl") caps_line="\${caps_out%"$fact_nl"}" ;; *) return 0 ;; esac
    caps_valid "$caps_line" || return 0
  elif [ "$caps_status" = 1 ] && [ "$caps_err" = "$helper_caps_old" ]; then
    caps_line="caps v1"
  else
    return 0
  fi
  HELPER_CAPS="\${caps_line#caps v1}"; HELPER_CAPS="\${HELPER_CAPS# }"
  if exec_fact_key "$1" && [ "$FACT_KEY" = "$caps_key" ]; then fact_put "$caps_name" "$caps_key" "$caps_line"; fi
}
# Appends answer $3 to question $1 under key $2 to this script's memo (see frame_memo_get).
frame_memo_put() {
  case "$1$2$3" in *"$fact_nl"*) return 0 ;; esac
  printf '\\n%s\\n%s\\n%s\\n\\n\\n' "$1" "$2" "$3" >>"$FACT_MEMO" 2>/dev/null || :
}
# True when live answer $1 names a live server on a port: then, and only then, the frame answers compat.
facts_frame_live_server() {
  case "$1" in "ok "*) ;; *) return 1 ;; esac
  set -f; set -- \${1#ok }
  valid_live_tokens "$@" && [ "$1" = live ]
}
# Sets FRAME_MANIFEST, FRAME_COMMIT, FRAME_LIVE and FRAME_COMPAT to the answers in combined reply
# $1 ("ok <tokens>" or "fail <word>"). Fails unless the whole frame is valid: its begin line, known
# tags each at most once, every required tag, compat exactly when live names a live server, and an
# end line that counts the answers with nothing after it.
facts_frame_parse() {
  FRAME_MANIFEST=; FRAME_COMMIT=; FRAME_LIVE=; FRAME_COMPAT=; frame_count=0
  case "$1" in "begin v1 facts$fact_nl"*) frame_rest="\${1#*"$fact_nl"}" ;; *) return 1 ;; esac
  while :; do
    case "$frame_rest" in *"$fact_nl"*) ;; *) break ;; esac
    frame_line="\${frame_rest%%"$fact_nl"*}"; frame_rest="\${frame_rest#*"$fact_nl"}"
    frame_answer="\${frame_line#* }"
    case "$frame_answer" in "ok "?*|"fail error"|"fail timeout"|"fail changed"|"fail unavailable") ;; *) return 1 ;; esac
    case "$frame_line" in
      "manifest $frame_answer") [ -z "$FRAME_MANIFEST" ] || return 1; FRAME_MANIFEST="$frame_answer" ;;
      "commit $frame_answer") [ -z "$FRAME_COMMIT" ] || return 1; FRAME_COMMIT="$frame_answer" ;;
      "live $frame_answer") [ -z "$FRAME_LIVE" ] || return 1; FRAME_LIVE="$frame_answer" ;;
      "compat $frame_answer") [ -z "$FRAME_COMPAT" ] || return 1; FRAME_COMPAT="$frame_answer" ;;
      *) return 1 ;;
    esac
    frame_count=$((frame_count + 1))
  done
  [ "$frame_rest" = "end $frame_count" ] && [ -n "$FRAME_MANIFEST" ] && [ -n "$FRAME_COMMIT" ] &&
    [ -n "$FRAME_LIVE" ] || return 1
  if facts_frame_live_server "$FRAME_LIVE"; then [ -n "$FRAME_COMPAT" ]; else [ -z "$FRAME_COMPAT" ]; fi
}
# Sets frame_pid and frame_port from live tokens $1.
facts_frame_live_ids() { set -f; set -- $1; frame_pid="\${5:-}"; frame_port="\${6:-}"; }
# Asks installed goat $1, once per executable and script, its manifest, its commit time, the live
# server behind the probe's record and launch files, and that server's compatibility, in one start.
# Succeeds, with FRAME_MANIFEST set, only when the reply may be used: the executable supports the
# call, its key was present before the capability lookup and is unchanged after the call, and the
# frame is valid in full. Then commit, live and compat are recorded under their usual rules. A
# live or compat answer that is not recorded is dropped: the probe's own check asks it again.
facts_frame_ask() {
  [ -n "$FACT_MEMO" ] && exec_fact_key "$1" || return 1
  frame_name="$FACT_NAME"; frame_key="$FACT_KEY"; frame_exec="$FACT_NAME $FACT_KEY"
  if frame_memo_get frame-asked "$1|$frame_exec"; then return 1; fi
  helper_caps "$1"
  case " $HELPER_CAPS " in *" facts "*) ;; *) return 1 ;; esac
  frame_memo_put frame-asked "$1|$frame_exec" ok
  frame_absent=; ! live_none_absent "$runtime_file" "$state/port" "$state/pid" || frame_absent=1
  frame_live=; ! live_fact_key "$1" "$runtime_file" "$state/port" "$state/pid" || frame_live="$FACT_KEY"
  frame_out="$("$1" __ssh-helper facts --runtime-file "$runtime_file" --port-file "$state/port" --pid-file "$state/pid" 2>/dev/null)" || return 1
  exec_fact_key "$1" && [ "$FACT_NAME $FACT_KEY" = "$frame_exec" ] || return 1
  frame_after=; ! live_fact_key "$1" "$runtime_file" "$state/port" "$state/pid" || frame_after="$FACT_KEY"
  frame_absent_after=; ! live_none_absent "$runtime_file" "$state/port" "$state/pid" || frame_absent_after=1
  facts_frame_parse "$frame_out" || return 1
  case "$FRAME_COMMIT" in "ok "*) valid_positive "\${FRAME_COMMIT#ok }" || FRAME_COMMIT="fail error" ;; esac
  case "$FRAME_COMMIT" in "ok "*) fact_put "commit.$frame_name" "$frame_key" "\${FRAME_COMMIT#ok }" ;; esac
  frame_memo_put frame-commit "$1|commit.$frame_name|$frame_key" "$FRAME_COMMIT"
  if [ -n "$frame_live" ] && [ "$frame_live" = "$frame_after" ]; then
    # Only the record's own server is recorded; compat with it, on the port live named.
    frame_tokens="\${FRAME_LIVE#ok }"
    if [ "$FRAME_LIVE" = "ok $frame_tokens" ] && fact_valid live "$frame_tokens"; then
      facts_frame_live_ids "$frame_tokens"
      if fact_bound "$frame_pid" "$frame_port"; then
        fact_put "live.$frame_name" "$frame_live" "$frame_tokens"
        case "$FRAME_COMPAT" in "ok "*)
          if fact_valid compat "\${FRAME_COMPAT#ok }"; then
            fact_put "compat.$frame_name" "$frame_live|$frame_port" "\${FRAME_COMPAT#ok }"
          fi ;;
        esac
      fi
    fi
  elif [ -n "$frame_absent" ] && [ -n "$frame_absent_after" ] &&
       [ "$FRAME_LIVE" = "ok none unknown unknown unknown 0 0" ]; then
    # The record, port and PID files are absent, as live_fact keeps that answer for this script.
    frame_memo_put live-none "$frame_exec" "\${FRAME_LIVE#ok }"
  fi
}
`;
