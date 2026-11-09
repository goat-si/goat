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
  [ -n "$FACT_MEMO" ] && exec_fact_key "$1" || return 0
  caps_name="caps.$FACT_NAME"; caps_key="$FACT_KEY"
  if caps_line="$(fact_get "$caps_name" "$caps_key")"; then
    HELPER_CAPS="\${caps_line#caps v1}"; HELPER_CAPS="\${HELPER_CAPS# }"; return 0
  fi
  # The status goes to a file only this script writes; stdout to a file and stderr to the capture,
  # each through head while it is read. Neither stream's content can stand for the status or hide
  # a cut: stdout counts only under the bound, and stderr only as an exact text.
  caps_tmp="$FACT_MEMO.caps"
  : >"$caps_tmp-status" && : >"$caps_tmp-out" || return 0
  caps_err="$({ { caps_s=0; "$1" __ssh-helper capabilities 2>&3 || caps_s=$?
      printf '%s\\n' "$caps_s" >"$caps_tmp-status"; } | head -c 4097 >"$caps_tmp-out"; printf . >&3; } 3>&1 | head -c 4097)" || return 0
  case "$caps_err" in *.) caps_err="\${caps_err%.}" ;; *) return 0 ;; esac
  IFS= read -r caps_status <"$caps_tmp-status" || return 0
  case "$caps_status" in ''|*[!0123456789]*) return 0 ;; esac
  caps_size="$(wc -c <"$caps_tmp-out")" || return 0
  caps_size="\${caps_size##* }"
  case "$caps_size" in ''|*[!0123456789]*) return 0 ;; esac
  [ "$caps_size" -le 4096 ] || return 0
  if [ "$caps_status" = 0 ] && [ -z "$caps_err" ]; then
    { IFS= read -r caps_line && ! IFS= read -r caps_more && [ -z "$caps_more" ]; } <"$caps_tmp-out" || return 0
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
# end line that counts the answers with nothing after it. The capability line \`facts --with-caps\`
# prints may follow the begin line, well formed and uncounted; with $2 "caps" it must, listing facts.
facts_frame_parse() {
  FRAME_MANIFEST=; FRAME_COMMIT=; FRAME_LIVE=; FRAME_COMPAT=; frame_count=0
  case "$1" in "begin v1 facts$fact_nl"*) frame_rest="\${1#*"$fact_nl"}" ;; *) return 1 ;; esac
  frame_caps=
  case "$frame_rest" in "caps v1$fact_nl"*|"caps v1 "*)
    frame_caps="\${frame_rest%%"$fact_nl"*}"; frame_rest="\${frame_rest#*"$fact_nl"}"
    caps_valid "$frame_caps" || return 1 ;;
  esac
  if [ "\${2:-}" = caps ]; then
    case " \${frame_caps#caps v1} " in *" facts "*) ;; *) return 1 ;; esac
  fi
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
# The compat tokens a separate compat call prints for a server with an instance id.
facts_frame_compat_valid() {
  set -f; set -- $1
  [ "$#" = 3 ] || return 1
  case "$1" in compatible|update-required|client-too-old|unknown) ;; *) return 1 ;; esac
  case "$2" in 0|1) ;; *) return 1 ;; esac
  case "$3" in ''|-|*[!$token_chars]*) return 1 ;; esac
}
# Makes goat $1's combined call and succeeds when its key is unchanged after it and the reply is
# valid in full; it records nothing. With $2 "caps" it asks for the capability line, requires it
# and fails on anything written to stderr.
facts_frame_call() {
  frame_absent=; ! live_none_absent "$runtime_file" "$state/port" "$state/pid" || frame_absent=1
  frame_live=; ! live_fact_key "$1" "$runtime_file" "$state/port" "$state/pid" || frame_live="$FACT_KEY"
  frame_err=/dev/null; frame_flag=
  if [ "\${2:-}" = caps ]; then frame_err="$FACT_MEMO.facts-err"; frame_flag=--with-caps; fi
  frame_out="$("$1" __ssh-helper facts $frame_flag --runtime-file "$runtime_file" --port-file "$state/port" --pid-file "$state/pid" 2>"$frame_err")" || return 1
  [ "$frame_err" = /dev/null ] || [ ! -s "$frame_err" ] || return 1
  exec_fact_key "$1" && [ "$FACT_NAME $FACT_KEY" = "$frame_exec" ] || return 1
  frame_after=; ! live_fact_key "$1" "$runtime_file" "$state/port" "$state/pid" || frame_after="$FACT_KEY"
  frame_absent_after=; ! live_none_absent "$runtime_file" "$state/port" "$state/pid" || frame_absent_after=1
  facts_frame_parse "$frame_out" "\${2:-}"
}
# Asks installed goat $1, once per executable and script, its manifest, its commit time, the live
# server behind the probe's record and launch files, and that server's compatibility, in one start.
# Succeeds, with FRAME_MANIFEST set, only when the reply may be used: the executable supports the
# call, its key was present before the call and is unchanged after it, and the frame is valid in
# full. Then commit, live and compat are recorded under their usual rules. Any other live or compat
# answer is dropped and asked again where the probe uses it, except a failed compat question,
# which stays failed for this probe as a failed separate call would.
facts_frame_ask() {
  [ -n "$FACT_MEMO" ] && exec_fact_key "$1" || return 1
  frame_name="$FACT_NAME"; frame_key="$FACT_KEY"; frame_exec="$FACT_NAME $FACT_KEY"
  if frame_memo_get frame-asked "$1|$frame_exec"; then return 1; fi
  # The client's own runtime version, with no recorded capability answer, is asked directly with
  # --with-caps. A valid frame whose own capability line lists facts is the evidence for using and
  # recording its answers, each under its own rule; that line is never recorded as a caps fact.
  # Any failure leaves no trace and takes the lookup below, as for every other version.
  if [ -n "$facts_own_version" ] && [ "$frame_name" = "$facts_own_version.exe" ] &&
     ! fact_get "caps.$frame_name" "$frame_key" >/dev/null && facts_frame_call "$1" caps; then
    frame_memo_put frame-asked "$1|$frame_exec" ok
    facts_frame_record "$1"
    return 0
  fi
  helper_caps "$1"
  case " $HELPER_CAPS " in *" facts "*) ;; *) return 1 ;; esac
  frame_memo_put frame-asked "$1|$frame_exec" ok
  facts_frame_call "$1" || return 1
  facts_frame_record "$1"
}
# Records the answers facts_frame_call validated for goat $1, each under its usual rule.
facts_frame_record() {
  case "$FRAME_COMMIT" in "ok "*) valid_positive "\${FRAME_COMMIT#ok }" || FRAME_COMMIT="fail error" ;; esac
  case "$FRAME_COMMIT" in "ok "*) fact_put "commit.$frame_name" "$frame_key" "\${FRAME_COMMIT#ok }" ;; esac
  frame_memo_put frame-commit "$1|commit.$frame_name|$frame_key" "$FRAME_COMMIT"
  # A failed live question stays failed for this probe, as a failed separate call would, but only
  # under inputs that are named again where it is used: a live key that held, or no files at all.
  frame_held=
  if [ -n "$frame_live" ] && [ "$frame_live" = "$frame_after" ]; then frame_held="$frame_live"
  elif [ -z "$frame_live$frame_after" ] && [ -n "$frame_absent" ] && [ -n "$frame_absent_after" ]; then frame_held=absent
  fi
  if [ -n "$frame_held" ]; then
    case "$FRAME_LIVE" in "ok "*) (set -f; set -- \${FRAME_LIVE#ok }; valid_live_tokens "$@") || FRAME_LIVE="fail error" ;; esac
    case "$FRAME_LIVE" in "fail "*)
      frame_memo_put frame-live "$1|$runtime_file|$state/port|$state/pid|$frame_exec|$frame_held" fail ;;
    esac
  fi
  if [ "$frame_live" = "$frame_after" ] && facts_frame_live_server "$FRAME_LIVE"; then
    facts_frame_live_ids "\${FRAME_LIVE#ok }"
    # Only the record's own server is recorded, and compat with it on the port live named.
    if [ -n "$frame_live" ] && fact_valid live "\${FRAME_LIVE#ok }" && fact_bound "$frame_pid" "$frame_port"; then
      fact_put "live.$frame_name" "$frame_live" "\${FRAME_LIVE#ok }"
      case "$FRAME_COMPAT" in "ok "*)
        if fact_valid compat "\${FRAME_COMPAT#ok }"; then
          fact_put "compat.$frame_name" "$frame_live|$frame_port" "\${FRAME_COMPAT#ok }"
        fi ;;
      esac
    fi
    # A server replaced between the frame's live and compat reads must not be asked afresh.
    case "$FRAME_COMPAT" in "ok "*) ! facts_frame_compat_valid "\${FRAME_COMPAT#ok }" || FRAME_COMPAT= ;; esac
    [ -z "$FRAME_COMPAT" ] || [ -z "$frame_live" ] ||
      frame_memo_put frame-compat "$1|$runtime_file|$state/port|$state/pid|$frame_exec|$frame_live|$frame_port" fail
  fi
  if [ -n "$frame_absent" ] && [ -n "$frame_absent_after" ] &&
       [ "$FRAME_LIVE" = "ok none unknown unknown unknown 0 0" ]; then
    # The record, port and PID files are absent, as live_fact keeps that answer for this script.
    frame_memo_put live-none "$frame_exec" "\${FRAME_LIVE#ok }"
  fi
}
`;
