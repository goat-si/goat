import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";

// Starting goat costs about 0.4 s on a host, and one reconnect used to start it dozens of times
// for answers that cannot change while their inputs stand: those of an unchanged executable, and
// those of one running server instance. Each answer is recorded under a key naming every input it
// depends on, so an executable that changed, was reinstalled or removed, or a server that was
// replaced or restarted misses and is asked again. Failures are never recorded, and a record is
// kept only when its key still holds after the answer. Windows hosts need this most: a goat.exe
// start there has taken over 5 s, so a probe that asked every time ran past the 60 s SSH timeout.
// MSYS stat keys executables by NTFS file ID and times. MSYS ps has no -o, so a live server there
// is keyed by its ps -W row (see fact_process_starts).
const REMOTE_FACTS_SCRIPT = `GOAT_FACTS_DIR="$HOME/.goat/ssh-launch/facts"
FACT_NAME=; FACT_KEY=; FACT_TEXT=; FACT_START=; FILE_SIG=; RUNNER_DIGEST=
# A script that names FACT_MEMO keeps there, for its own subshells, the exec keys of installed
# executables and of its content-pinned runner; pin_runner clears it.
FACT_MEMO="\${FACT_MEMO:-}"
fact_nl='
'
# Later blocks read the system name from here instead of starting uname again.
fact_uname="$(uname -s 2>/dev/null)" || fact_uname=
case "$fact_uname" in
  MINGW*|MSYS*|CYGWIN*) fact_windows=1; fact_stat=gnu ;;
  Darwin|*BSD|DragonFly) fact_windows=0; fact_stat=bsd ;;
  *) fact_windows=0; fact_stat=gnu ;;
esac
# True when file $1 reads as $2, as [ "$(cat "$1" 2>/dev/null || true)" = "$2" ] tests it.
fact_file_is() { fact_slurp "$1" || FACT_TEXT=; [ "$FACT_TEXT" = "$2" ]; }
# Sets FACT_TEXT to file $1 as $(cat "$1") would read it, without starting cat.
fact_slurp() {
  FACT_TEXT=; slurp_sep=; slurp_line=
  [ -f "$1" ] && [ -r "$1" ] || return 1
  while IFS= read -r slurp_line || [ -n "$slurp_line" ]; do
    FACT_TEXT="$FACT_TEXT$slurp_sep$slurp_line"; slurp_sep="$fact_nl"; slurp_line=
  done <"$1"
  while :; do case "$FACT_TEXT" in *"$fact_nl") FACT_TEXT="\${FACT_TEXT%"$fact_nl"}" ;; *) return 0 ;; esac; done
}
# Sets FILE_SIG to device:inode:size:mtime:ctime of regular file $1.
file_sig_set() {
  FILE_SIG=
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  # GNU stat reads -f as a file-system query and BSD stat has no -c; the host's own goes first.
  if [ "$fact_stat" = bsd ]; then
    sig_value="$(stat -f '%d:%i:%z:%m:%c' "$1" 2>/dev/null)" ||
      sig_value="$(stat -c '%d:%i:%s:%Y:%Z' "$1" 2>/dev/null)" || return 1
  else
    sig_value="$(stat -c '%d:%i:%s:%Y:%Z' "$1" 2>/dev/null)" ||
      sig_value="$(stat -f '%d:%i:%z:%m:%c' "$1" 2>/dev/null)" || return 1
  fi
  case "$sig_value" in
    *[!0123456789:]*|:*|*:|*::*|*:*:*:*:*:*) return 1 ;;
    *:*:*:*:*) FILE_SIG="$sig_value" ;;
    *) return 1 ;;
  esac
}
file_sig() { file_sig_set "$1" && printf '%s' "$FILE_SIG"; }
# Sets FILE_SIG and FILE_SIG2 for regular files $1 and $2 as file_sig_set does, from one stat
# start; anything but two valid lines sets neither.
file_sigs_set() {
  FILE_SIG=; FILE_SIG2=
  [ -f "$1" ] && [ ! -L "$1" ] && [ -f "$2" ] && [ ! -L "$2" ] || return 1
  if [ "$fact_stat" = bsd ]; then
    sig_value="$(stat -f '%d:%i:%z:%m:%c' "$1" "$2" 2>/dev/null)" ||
      sig_value="$(stat -c '%d:%i:%s:%Y:%Z' "$1" "$2" 2>/dev/null)" || return 1
  else
    sig_value="$(stat -c '%d:%i:%s:%Y:%Z' "$1" "$2" 2>/dev/null)" ||
      sig_value="$(stat -f '%d:%i:%z:%m:%c' "$1" "$2" 2>/dev/null)" || return 1
  fi
  case "$sig_value" in *"$fact_nl"*) ;; *) return 1 ;; esac
  sig_first="\${sig_value%%"$fact_nl"*}"; sig_second="\${sig_value#*"$fact_nl"}"
  for sig_value in "$sig_first" "$sig_second"; do
    case "$sig_value" in
      *[!0123456789:]*|:*|*:|*::*|*:*:*:*:*:*) return 1 ;;
      *:*:*:*:*) ;;
      *) return 1 ;;
    esac
  done
  FILE_SIG="$sig_first"; FILE_SIG2="$sig_second"
}
# A remembered key holds only while its executable keeps the signature and install marker it had,
# and a remembered runner keeps its own. Their age gates hold again on a fresh clock: one stepped
# back makes a same-second rewrite look unchanged. The clock is read after the signatures, so a
# step back between them can only refuse.
fact_memo_get() {
  [ -n "$FACT_MEMO" ] && [ -f "$FACT_MEMO" ] && [ -r "$FACT_MEMO" ] || return 1
  while IFS= read -r memo_path && IFS= read -r memo_name && IFS= read -r memo_key &&
    IFS= read -r memo_exe && IFS= read -r memo_sig && IFS= read -r memo_path_sig; do
    [ "$memo_path" = "$1" ] || continue
    if [ "$memo_path" != "$memo_exe" ]; then
      file_sigs_set "$memo_path" "$memo_exe" && [ "$FILE_SIG" = "$memo_path_sig" ] &&
        [ "$FILE_SIG2" = "$memo_sig" ] || return 1
    else
      file_sig_set "$memo_exe" && [ "$FILE_SIG" = "$memo_sig" ] || return 1
    fi
    fact_clock || return 1
    [ "$memo_path" = "$memo_exe" ] || [ "\${memo_path_sig##*:}" -lt "$fact_now" ] || return 1
    [ "$(( fact_now - \${memo_sig##*:} ))" -ge 2 ] || return 1
    fact_slurp "\${memo_exe%/goat}/.install-complete" && [ "$FACT_TEXT" = "\${memo_name%.*}" ] || return 1
    FACT_NAME="$memo_name"; FACT_KEY="$memo_key"; return 0
  done <"$FACT_MEMO"
  return 1
}
fact_memo_put() {
  [ -n "$FACT_MEMO" ] || return 0
  memo_path_sig="$fact_sig"
  case "$1" in
    "$HOME/.goat/runtime/goat/versions"/*/goat) ;;
    *)
      [ "$1" = "\${RUNNER_CANDIDATE_FILE:-}.pin" ] || return 0
      # A later write in the second the runner last changed could leave its signature unchanged.
      file_sig_set "$1" && [ "\${FILE_SIG##*:}" -lt "$fact_now" ] || return 0
      memo_path_sig="$FILE_SIG" ;;
  esac
  case "$1$FACT_NAME$FACT_KEY$fact_exe$fact_sig$memo_path_sig" in *"$fact_nl"*) return 0 ;; esac
  printf '%s\\n%s\\n%s\\n%s\\n%s\\n%s\\n' "$1" "$FACT_NAME" "$FACT_KEY" "$fact_exe" "$fact_sig" "$memo_path_sig" >>"$FACT_MEMO" 2>/dev/null || :
}
# Pins runner bytes $1 for this script; exec keys remembered for an earlier pin no longer apply.
pin_runner() { cp "$1" "\${RUNNER_CANDIDATE_FILE:?}.pin" || return 1; fact_memo_drop; }
# Forgets every remembered key; a memo that cannot be emptied is not used again.
fact_memo_drop() { [ -z "$FACT_MEMO" ] || true >"$FACT_MEMO" 2>/dev/null || FACT_MEMO=; }
# Sets fact_now to the wall clock in seconds, read afresh for each check: bash 5's EPOCHSECONDS,
# which starts no process, else date with its own status.
fact_clock() {
  case "\${EPOCHSECONDS:-}" in
    ''|*[!0123456789]*) fact_now="$(date +%s)" ;;
    *) fact_now="$EPOCHSECONDS" ;;
  esac
}
# Sets FACT_NAME and FACT_KEY for running goat as $1: an installed executable, or an archive
# runner, which execs one. An executable changed less than 2 s ago is not keyed: a second write
# within the same second would leave its ctime unchanged.
exec_fact_key() {
  FACT_NAME=; FACT_KEY=
  [ -n "$GOAT_FACTS_DIR" ] && [ -f "$1" ] || return 1
  fact_memo_get "$1" && return 0
  fact_versions="$HOME/.goat/runtime/goat/versions"
  case "$1" in
    "$fact_versions"/*/goat) fact_exe="$1"; fact_via=exe ;;
    *)
      command -v runner_key_hints >/dev/null 2>&1 || return 1
      runner_key_hints "$1"
      [ -z "$RUNNER_NODE_DECLARED" ] || return 1
      fact_exe="$fact_versions/$RUNNER_ARCHIVE_VERSION/goat"
      runner_digest "$1" 2>/dev/null || return 1
      fact_via="$RUNNER_DIGEST" ;;
  esac
  fact_version="\${fact_exe%/goat}"; fact_version="\${fact_version##*/}"
  valid_version "$fact_version" && [ "$fact_exe" = "$fact_versions/$fact_version/goat" ] || return 1
  file_sig_set "$fact_exe" || return 1
  fact_sig="$FILE_SIG"
  fact_clock || return 1
  [ "$(( fact_now - \${fact_sig##*:} ))" -ge 2 ] || return 1
  # A runner installs a version without its marker instead of running it.
  fact_slurp "$fact_versions/$fact_version/.install-complete" && [ "$FACT_TEXT" = "$fact_version" ] || return 1
  case "$fact_via" in exe) FACT_NAME="$fact_version.exe" ;; *) FACT_NAME="$fact_version.runner" ;; esac
  FACT_KEY="$fact_exe $fact_sig $fact_via"
  fact_memo_put "$1"
}
prune_removed_facts() (
  [ -n "$GOAT_FACTS_DIR" ] || exit 0
  # A missing version is enough to discard answers; incomplete installs and links are not.
  for fact_parent in "$HOME" "$HOME/.goat" "$HOME/.goat/ssh-launch" "$GOAT_FACTS_DIR" \
    "$HOME/.goat/runtime" "$HOME/.goat/runtime/goat" "$HOME/.goat/runtime/goat/versions"; do
    [ ! -L "$fact_parent" ] && [ -d "$fact_parent" ] && [ -r "$fact_parent" ] && [ -x "$fact_parent" ] || exit 0
  done
  set +f
  for fact_file in "$GOAT_FACTS_DIR"/*; do
    [ ! -L "$fact_file" ] && [ -f "$fact_file" ] || continue
    fact_base="\${fact_file##*/}"
    case "$fact_base" in version.*|own.*|commit.*|scopes.*|live.*|compat.*) ;; *) continue ;; esac
    case "$fact_base" in *.exe|*.runner) ;; *) continue ;; esac
    fact_version="\${fact_base#*.}"; fact_version="\${fact_version%.*}"
    valid_version "$fact_version" || continue
    fact_dir="$HOME/.goat/runtime/goat/versions/$fact_version"
    [ ! -L "$fact_dir" ] && [ ! -e "$fact_dir" ] || continue
    rm -f "$fact_file" || true
  done
) 2>/dev/null || true
# A recorded value must parse as an answer of its kind (the name's first word); anything else,
# such as a damaged file, is a miss and is asked again.
fact_valid() {
  case "$1" in
    version) case "$2" in "goat v"*) valid_version "\${2#goat v}" ;; *) return 1 ;; esac ;;
    own) (set -f; set -- $2; valid_own_tokens "$@") ;;
    commit) valid_positive "$2" ;;
    scopes) case "$2" in has|lacks|unknown) ;; *) return 1 ;; esac ;;
    live) (set -f; set -- $2; valid_live_tokens "$@" && [ "$1" = live ] && valid_positive "$5") ;;
    compat)
      (set -f; set -- $2
        [ "$#" = 3 ] || exit 1
        case "$1" in compatible|update-required|client-too-old) ;; *) exit 1 ;; esac
        [ "$2" = 1 ] || exit 1
        case "$3" in ''|-|*[!A-Za-z0-9-]*) exit 1 ;; *) ;; esac) ;;
    *) return 1 ;;
  esac
}
fact_get() {
  [ -n "$1" ] && [ -n "$2" ] && [ -f "$GOAT_FACTS_DIR/$1" ] && [ ! -L "$GOAT_FACTS_DIR/$1" ] || return 1
  { IFS= read -r fact_recorded && IFS= read -r fact_value; } <"$GOAT_FACTS_DIR/$1" || return 1
  [ "$fact_recorded" = "$2" ] && fact_valid "\${1%%.*}" "$fact_value" || return 1
  printf '%s\\n' "$fact_value"
}
fact_put() {
  [ -n "$1" ] && [ -n "$2" ] || return 0
  case "$2$3" in *"$fact_nl"*) return 0 ;; esac
  (
    umask 077
    # mkdir -p changes nothing for an existing directory; skipping it saves a process start.
    [ ! -L "$GOAT_FACTS_DIR" ] && { [ -d "$GOAT_FACTS_DIR" ] || mkdir -p "$GOAT_FACTS_DIR"; } &&
      fact_tmp="$(mktemp "$GOAT_FACTS_DIR/.fact.XXXXXX")" || exit 0
    printf '%s\\n%s\\n' "$2" "$3" >"$fact_tmp" && mv -f "$fact_tmp" "$GOAT_FACTS_DIR/$1" || rm -f "$fact_tmp"
  ) 2>/dev/null || true
}
# Sets FACT_START and FACT_START2 to the start identities of processes $1 and $2 (may be empty),
# from one listing. Git Bash and Cygwin ps lists native processes only through -W, by WINPID
# (column 4 after an optional status letter), with a start shown to the second today and to the
# day before; the whole row, executable path included, is the key. A server GOAT restarts still
# misses: it rewrites the runtime record, whose startedAt and instanceId are in the key.
fact_process_starts() {
  FACT_START=; FACT_START2=
  if [ "$fact_windows" = 0 ]; then
    FACT_START="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null)" || FACT_START=
    [ -z "$2" ] || FACT_START2="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$2" 2>/dev/null)" || FACT_START2=
    return 0
  fi
  ps_rows="$(ps -W 2>/dev/null | awk -v a="$1" -v b="$2" '
    NR > 1 {
      if ($1 !~ /^[0-9]+$/) { $1 = ""; $0 = $0 }
      if ($4 == a && ra == "") { $1 = $1; ra = $0 }
      if (b != "" && $4 == b && rb == "") { $1 = $1; rb = $0 }
    }
    END { print ra; print rb }')" || return 0
  FACT_START="\${ps_rows%%"$fact_nl"*}"
  case "$ps_rows" in *"$fact_nl"*) FACT_START2="\${ps_rows#*"$fact_nl"}" ;; esac
}
# Sets FACT_TEXT to the digits after the last JSON name $1 (quoted) in $2 that a colon and a
# number follow, as sed -n 's/.*NAME[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p' finds them.
fact_json_uint() {
  FACT_TEXT=; json_rest="$2"
  while :; do
    case "$json_rest" in *"$1"*) ;; *) return 0 ;; esac
    json_tail="\${json_rest##*"$1"}"; json_rest="\${json_rest%"$1"*}"
    while :; do case "$json_tail" in [[:space:]]*) json_tail="\${json_tail#?}" ;; *) break ;; esac; done
    case "$json_tail" in :*) json_tail="\${json_tail#:}" ;; *) continue ;; esac
    while :; do case "$json_tail" in [[:space:]]*) json_tail="\${json_tail#?}" ;; *) break ;; esac; done
    json_digits="\${json_tail%%[!0123456789]*}"
    if [ -n "$json_digits" ]; then FACT_TEXT="$json_digits"; return 0; fi
  done
}
# Prints the output of goat run as "$2" "$3"..., recorded as fact $1 of that executable.
exec_fact() {
  fact_kind="$1"; shift
  exec_fact_key "$1" || true
  fact_name="$fact_kind.$FACT_NAME"; fact_key="$FACT_KEY"
  if fact_get "$fact_name" "$fact_key"; then return 0; fi
  fact_out="$("$@")" || return 1
  if [ -n "$fact_key" ] && exec_fact_key "$1" && [ "$FACT_KEY" = "$fact_key" ]; then
    fact_put "$fact_name" "$fact_key" "$fact_out"
  fi
  printf '%s\\n' "$fact_out"
}
# Sets FACT_TEXT to file $1 as tr '\\n' ' ' <"$1" prints it: every line ended by a space.
fact_read_record() {
  FACT_TEXT=; record_line=
  [ -f "$1" ] && [ -r "$1" ] || return 1
  while IFS= read -r record_line; do FACT_TEXT="$FACT_TEXT$record_line "; record_line=; done <"$1"
  FACT_TEXT="$FACT_TEXT$record_line"
}
# A live answer from goat $1 depends on its executable, the runtime record $2, the launch port
# and PID files $3 and $4, and whether the PIDs they name still run the same processes.
live_fact_key() {
  exec_fact_key "$1" || return 1
  fact_live="$FACT_KEY"; FACT_KEY=
  fact_read_record "$2" && fact_record="$FACT_TEXT" && [ -n "$fact_record" ] || return 1
  fact_json_uint '"pid"' "$fact_record"; fact_pid="$FACT_TEXT"
  valid_positive "$fact_pid" || return 1
  fact_json_uint '"port"' "$fact_record"; fact_record_port="$FACT_TEXT"
  valid_positive "$fact_record_port" || return 1
  fact_slurp "$3" || :; fact_port="$FACT_TEXT"
  fact_slurp "$4" || :; fact_remembered="$FACT_TEXT"
  fact_remembered_pid=
  if valid_positive "$fact_remembered"; then fact_remembered_pid="$fact_remembered"; fi
  fact_process_starts "$fact_pid" "$fact_remembered_pid"
  fact_start="$FACT_START"; fact_remembered_start="$FACT_START2"
  [ -n "$fact_start" ] || return 1
  FACT_KEY="$fact_live|$fact_record|$fact_start|$fact_port|$fact_remembered|$fact_remembered_start"
}
# True when live PID $1 and port $2 are the record's own: only then does the record's process
# identify the server that answered. A historical or service-managed record answers PID 0, and
# whatever listens on its port may change without changing the key.
fact_bound() {
  [ "$1" = "$fact_pid" ] && [ "$2" = "$fact_record_port" ]
}
# True when none of files $1-$3 exists, even as a dangling link.
live_none_absent() {
  for live_none_file in "$1" "$2" "$3"; do
    [ ! -e "$live_none_file" ] && [ ! -L "$live_none_file" ] || return 1
  done
}
# Prints the no-server answer this script's memo keeps for exec key $1. Its records have an empty
# path, which no exec key lookup matches.
live_none_get() {
  [ -n "$FACT_MEMO" ] && [ -f "$FACT_MEMO" ] && [ -r "$FACT_MEMO" ] || return 1
  while IFS= read -r memo_path && IFS= read -r memo_name && IFS= read -r memo_key &&
    IFS= read -r memo_answer && IFS= read -r memo_sig && IFS= read -r memo_path_sig; do
    [ -z "$memo_path" ] && [ "$memo_name" = live-none ] && [ "$memo_key" = "$1" ] || continue
    printf '%s\\n' "$memo_answer"; return 0
  done <"$FACT_MEMO"
  return 1
}
# Live protocol tokens from goat $1 for runtime record $2, port file $3 and PID file $4.
# Only a live answer from the record's own process is recorded; anything else is asked again.
# With no record, port or PID file goat can only find no server: that answer is kept for this
# script under the executable's key, and given again while all three stay absent and the key holds.
live_fact() {
  live_none_key=; fact_key=
  if live_none_absent "$2" "$3" "$4"; then
    if [ -n "$FACT_MEMO" ] && exec_fact_key "$1"; then
      live_none_key="$FACT_NAME $FACT_KEY"
      if live_none_get "$live_none_key"; then return 0; fi
    fi
  else
    live_fact_key "$1" "$2" "$3" "$4" || FACT_KEY=
    fact_name="live.$FACT_NAME"; fact_key="$FACT_KEY"
    if fact_get "$fact_name" "$fact_key"; then return 0; fi
  fi
  fact_out="$("$1" __ssh-helper protocol --runtime-file "$2" --port-file "$3" --pid-file "$4" --shell)" || return 1
  if [ -n "$live_none_key" ] && (set -f; set -- $fact_out; [ "$1" = none ] && valid_live_tokens "$@") &&
     live_none_absent "$2" "$3" "$4" && exec_fact_key "$1" && [ "$FACT_NAME $FACT_KEY" = "$live_none_key" ]; then
    case "$live_none_key$fact_out" in
      *"$fact_nl"*) ;;
      *) printf '\\n%s\\n%s\\n%s\\n\\n\\n' live-none "$live_none_key" "$fact_out" >>"$FACT_MEMO" 2>/dev/null || : ;;
    esac
  fi
  fact_answer="$(set -f; set -- $fact_out; printf '%s %s' "\${5:-}" "\${6:-}")"
  if [ -n "$fact_key" ] && live_fact_key "$1" "$2" "$3" "$4" && [ "$FACT_KEY" = "$fact_key" ] &&
     fact_valid live "$fact_out" && fact_bound "\${fact_answer% *}" "\${fact_answer#* }"; then
    fact_put "$fact_name" "$fact_key" "$fact_out"
  fi
  printf '%s\\n' "$fact_out"
}
# Compatibility tokens from goat $1 for the server on port $2, keyed like live_fact by $3-$5.
# $6 is the PID the live answer named; it is recorded only for the record's own process.
compat_fact() {
  live_fact_key "$1" "$3" "$4" "$5" || FACT_KEY=
  fact_name="compat.$FACT_NAME"; fact_key="$FACT_KEY"
  [ -z "$fact_key" ] || fact_key="$fact_key|$2"
  if fact_get "$fact_name" "$fact_key"; then return 0; fi
  fact_out="$("$1" __ssh-helper compat --port "$2")" || return 1
  if [ -n "$fact_key" ] && live_fact_key "$1" "$3" "$4" "$5" && [ "$FACT_KEY|$2" = "$fact_key" ] &&
     fact_valid compat "$fact_out" && fact_bound "$6" "$2"; then
    fact_put "$fact_name" "$fact_key" "$fact_out"
  fi
  printf '%s\\n' "$fact_out"
}
`;

// The validators run for every token a host reports and must stay builtins: under MSYS each
// external command costs about 50 ms. Characters are listed, not ranged, so no locale widens them.
export const REMOTE_PROTOCOL_TOKEN_SCRIPT = `token_digits=0123456789
token_chars=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-
# 0 or a decimal integer without a leading zero.
valid_numeric_id() {
  case "$1" in 0) return 0 ;; ''|0*|*[!$token_digits]*) return 1 ;; esac
}
# Dot-separated SemVer identifiers $2: prerelease ($1=pre) numbers carry no leading zero.
valid_dot_ids() {
  ids_rest="$2."
  while [ -n "$ids_rest" ]; do
    ids_part="\${ids_rest%%.*}"; ids_rest="\${ids_rest#*.}"
    case "$ids_part" in ''|*[!$token_chars]*) return 1 ;; esac
    if [ "$1" = pre ]; then
      case "$ids_part" in *[!$token_digits]*) ;; *) valid_numeric_id "$ids_part" || return 1 ;; esac
    fi
  done
}
valid_version() {
  ver_core="\${1%%[-+]*}"; ver_rest="\${1#"$ver_core"}"
  ver_major="\${ver_core%%.*}"; ver_tail="\${ver_core#*.}"
  [ "$ver_tail" != "$ver_core" ] || return 1
  ver_minor="\${ver_tail%%.*}"; ver_patch="\${ver_tail#*.}"
  [ "$ver_patch" != "$ver_tail" ] &&
    valid_numeric_id "$ver_major" && valid_numeric_id "$ver_minor" && valid_numeric_id "$ver_patch" || return 1
  case "$ver_rest" in
    '') ;;
    -*)
      ver_rest="\${ver_rest#-}"
      valid_dot_ids pre "\${ver_rest%%+*}" || return 1
      case "$ver_rest" in *+*) valid_dot_ids build "\${ver_rest#*+}" ;; esac ;;
    +*) valid_dot_ids build "\${ver_rest#+}" ;;
    *) return 1 ;;
  esac
}
# At most 2^53 - 1. Sixteen digits compare as two halves, which 32-bit shell arithmetic can hold.
valid_uint() {
  valid_numeric_id "$1" && [ "\${#1}" -le 16 ] || return 1
  [ "\${#1}" -lt 16 ] && return 0
  uint_high="\${1%????????}"; uint_low="\${1#????????}"
  [ "$uint_high" -lt 90071992 ] || { [ "$uint_high" = 90071992 ] && [ "$uint_low" -le 54740991 ]; }
}
valid_positive() { valid_uint "$1" && [ "$1" != 0 ]; }
valid_port() { valid_uint "$1" && [ "$1" -le 65535 ]; }
# A server this user runs from GOAT's own runtime directory for the default home is GOAT's
# managed runtime, whichever client or person started it. Lost launch records (a manual
# restart, a moved state directory) must not turn it into a foreign server nobody may replace.
# Records that name a live process belong to someone: another server, an older client's
# per-client directory, or an ownership change in progress. Attaching to a foreign server
# removes its PID file, so a lost-records server has none.
managed_orphan() {
  orphan_pid="$1"; orphan_port="$2"; orphan_version="$3"; orphan_state="$4"
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 1 ;; esac
  valid_positive "$orphan_pid" && valid_positive "$orphan_port" && valid_port "$orphan_port" &&
    valid_version "$orphan_version" || return 1
  [ ! -e "$orphan_state/draining" ] && [ ! -L "$orphan_state/draining" ] || return 1
  case "$-" in *f*) orphan_noglob=1 ;; *) orphan_noglob=0 ;; esac
  set +f
  for orphan_record in "$HOME/.goat/ssh-launch/"*/pid; do
    orphan_recorded="$(cat "$orphan_record" 2>/dev/null || true)"
    if valid_positive "$orphan_recorded" && kill -0 "$orphan_recorded" 2>/dev/null; then
      [ "$orphan_noglob" = 0 ] || set -f
      return 1
    fi
  done
  [ "$orphan_noglob" = 0 ] || set -f
  orphan_dir="$HOME/.goat/runtime/goat/versions/$orphan_version"
  [ -d "$orphan_dir" ] && [ ! -L "$orphan_dir" ] && [ -x "$orphan_dir/goat" ] && [ ! -L "$orphan_dir/goat" ] || return 1
  orphan_uid="$(ps -o uid= -p "$orphan_pid" 2>/dev/null | awk 'NF==1 { print $1 }')"
  [ -n "$orphan_uid" ] && [ "$orphan_uid" = "$(id -u)" ] || return 1
  [ "$(ps -o command= -p "$orphan_pid" 2>/dev/null)" = "$orphan_dir/goat serve --host 127.0.0.1 --port $orphan_port --base-dir $HOME/.goat" ]
}
valid_protocol_field() { [ "$1" = unknown ] || valid_positive "$1"; }
valid_own_tokens() {
  [ "$#" = 5 ] && valid_version "$1" && valid_protocol_field "$2" &&
    valid_protocol_field "$3" && valid_uint "$4" && valid_port "$5" || return 1
  # Own advertisement is normally not running: 0 0 is a valid pair.
  { [ "$4" = 0 ] && [ "$5" = 0 ]; } ||
    { valid_positive "$4" && valid_positive "$5"; }
}
valid_live_tokens() {
  [ "$#" = 6 ] && valid_uint "$5" && valid_port "$6" || return 1
  case "$1" in
    live) valid_version "$2" && valid_protocol_field "$3" &&
      valid_protocol_field "$4" && valid_positive "$6" ;;
    none) [ "$2 $3 $4 $5 $6" = 'unknown unknown unknown 0 0' ] ;;
    unknown) [ "$2 $3 $4" = 'unknown unknown unknown' ] ;;
    *) return 1 ;;
  esac
}
# Commit time of the build behind executable $1; fails for unstamped or older builds.
build_commit_time() {
  t="$(exec_fact commit "$1" __ssh-helper commit-time 2>/dev/null || true)"
  valid_positive "$t" && printf '%s' "$t"
}
# True only when executable $1 lists its session scopes and memory:read is not among them.
# Every GOAT CLI prints its scope choices here, so this also answers for builds before memory.
lacks_memory_scopes() {
  [ -x "$1" ] || return 1
  exec_fact_key "$1" || true
  scope_name="scopes.$FACT_NAME"; scope_key="$FACT_KEY"
  if ! scope_verdict="$(fact_get "$scope_name" "$scope_key")"; then
    scope_help="$("$1" auth session issue --help 2>/dev/null)" || return 1
    case "$scope_help" in *memory:read*) scope_verdict=has ;; *--scope*) scope_verdict=lacks ;; *) scope_verdict=unknown ;; esac
    if [ -n "$scope_key" ] && exec_fact_key "$1" && [ "$FACT_KEY" = "$scope_key" ]; then
      fact_put "$scope_name" "$scope_key" "$scope_verdict"
    fi
  fi
  [ "$scope_verdict" = lacks ]
}
# Sets RUNNER_DIGEST to the SHA-256 of file $1.
runner_digest() {
  RUNNER_DIGEST=
  if command -v shasum >/dev/null 2>&1; then digest="$(shasum -a 256 "$1")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$1")" || return 1
  else printf 'Install shasum or sha256sum to verify the retained GOAT runner.\\n' >&2; return 1; fi
  digest="\${digest%% *}"
  case "$digest" in *[!0123456789abcdef]*) return 1 ;; esac
  [ "\${#digest}" = 64 ] || return 1
  RUNNER_DIGEST="$digest"
}
runner_sha256() { runner_digest "$1" && printf '%s' "$RUNNER_DIGEST"; }
${REMOTE_FACTS_SCRIPT}
`;

// Retained runners are data: inspect either declaration spelling without sourcing shell code.
// Runners built from now on end their declarations with this line (see runner_hint_set).
export const RUNNER_HINT_END = "# End of the declarations GOAT reads without running this runner.";

export const REMOTE_RUNNER_HINT_SCRIPT = String.raw`# Key $2 counts when any line declares it, else key $3; quoted values only. Builtins only: an
# MSYS fork costs about 50 ms. The comparison test pins this against the grep and sed reader.
hint_nl='
'
hint_end='${RUNNER_HINT_END}'
# Adds line $1 to the declarations of keys $2/$3 and, with five arguments, $4/$5.
hint_take() {
  case "$1" in "$2="*) hint_named=1 ;; esac
  case "$1" in "$2='"*"'") hint_value="${"${"}1#"$2='"}"; hint_want="$hint_want${"${"}hint_value%"'"}$hint_nl" ;; esac
  case "$1" in "$3='"*"'") hint_value="${"${"}1#"$3='"}"; hint_back="$hint_back${"${"}hint_value%"'"}$hint_nl" ;; esac
  if [ "$#" -ge 5 ]; then
    case "$1" in "$4="*) hint_named2=1 ;; esac
    case "$1" in "$4='"*"'") hint_value="${"${"}1#"$4='"}"; hint_want2="$hint_want2${"${"}hint_value%"'"}$hint_nl" ;; esac
    case "$1" in "$5='"*"'") hint_value="${"${"}1#"$5='"}"; hint_back2="$hint_back2${"${"}hint_value%"'"}$hint_nl" ;; esac
  fi
}
# Sets RUNNER_HINT for key $2 (else $3) and, when $4 is given, RUNNER_HINT2 for key $4 (else $5),
# as $(...) would keep them, from every line of runner $1. bash reads the file in one call and,
# when no line after the end-of-declarations line starts with a key, parses only the lines
# before it, which give the same answer; other shells and files with NUL bytes read each line.
runner_hint_set() {
  RUNNER_HINT=; RUNNER_HINT2=; hint_line=
  hint_named=; hint_want=; hint_back=; hint_named2=; hint_want2=; hint_back2=
  [ -f "$1" ] && [ -r "$1" ] || return 1
  hint_file="$1"; shift
  if [ -n "${"${"}BASH_VERSION:-}" ] && ! IFS= read -r -d '' hint_all <"$hint_file" 2>/dev/null; then
    hint_rest="$hint_all"; hint_cut="$hint_nl$hint_end$hint_nl"; hint_all="$hint_nl$hint_all$hint_nl"
    case "$hint_all" in
      *"$hint_cut"*)
        case "$hint_nl${"${"}hint_all#*"$hint_cut"}" in
          *"$hint_nl$1="* | *"$hint_nl$2="* | *"$hint_nl${"${"}3:-$1}="* | *"$hint_nl${"${"}4:-$1}="*) ;;
          *) hint_rest="${"${"}hint_all%%"$hint_cut"*}"; hint_rest="${"${"}hint_rest#"$hint_nl"}" ;;
        esac ;;
    esac
    while [ -n "$hint_rest" ]; do
      hint_line="${"${"}hint_rest%%"$hint_nl"*}"
      case "$hint_rest" in *"$hint_nl"*) hint_rest="${"${"}hint_rest#*"$hint_nl"}" ;; *) hint_rest= ;; esac
      hint_take "$hint_line" "$@"
    done
  else
    while IFS= read -r hint_line || [ -n "$hint_line" ]; do
      hint_take "$hint_line" "$@"; hint_line=
    done <"$hint_file"
  fi
  if [ -n "$hint_named" ]; then RUNNER_HINT="$hint_want"; else RUNNER_HINT="$hint_back"; fi
  if [ -n "$hint_named2" ]; then RUNNER_HINT2="$hint_want2"; else RUNNER_HINT2="$hint_back2"; fi
  while :; do case "$RUNNER_HINT" in *"$hint_nl") RUNNER_HINT="${"${"}RUNNER_HINT%"$hint_nl"}" ;; *) break ;; esac; done
  while :; do case "$RUNNER_HINT2" in *"$hint_nl") RUNNER_HINT2="${"${"}RUNNER_HINT2%"$hint_nl"}" ;; *) return 0 ;; esac; done
}
read_runner_hint() { runner_hint_set "$1" "$2" "$3" || return 1; printf '%s' "$RUNNER_HINT"; }
# Sets RUNNER_NODE_DECLARED (1 or empty) and RUNNER_ARCHIVE_VERSION, the two declarations an
# exec key reads.
runner_key_hints() {
  RUNNER_NODE_DECLARED=; RUNNER_ARCHIVE_VERSION=
  runner_hint_set "$1" GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY} GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY} ||
    return 0
  [ -z "$RUNNER_HINT" ] || RUNNER_NODE_DECLARED=1
  RUNNER_ARCHIVE_VERSION="$RUNNER_HINT2"
}
`;
