import {
  LEGACY_SSH_ARCHIVE_VERSION_KEY,
  LEGACY_SSH_NODE_SCRIPT_PATH_KEY,
} from "@goat/contracts/legacyT3Names";

// Starting goat costs about 0.4 s on a host, and one reconnect used to start it dozens of times
// for answers that cannot change while their inputs stand: those of an unchanged executable, and
// those of one running server instance. Each answer is recorded under a key naming every input it
// depends on, so an executable that changed, was reinstalled or removed, or a server that was
// replaced or restarted misses and is asked again. Failures are never recorded, and a record is
// kept only when its key still holds after the answer. Windows hosts ask every time.
const REMOTE_FACTS_SCRIPT = `case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) GOAT_FACTS_DIR= ;;
  *) GOAT_FACTS_DIR="$HOME/.goat/ssh-launch/facts" ;;
esac
FACT_NAME=; FACT_KEY=
fact_nl='
'
file_sig() {
  [ -f "$1" ] && [ ! -L "$1" ] || return 1
  # BSD stat first: GNU stat reads -f as a file-system query and rejects the format operand.
  sig_value="$(stat -f '%d:%i:%z:%m:%c' "$1" 2>/dev/null)" ||
    sig_value="$(stat -c '%d:%i:%s:%Y:%Z' "$1" 2>/dev/null)" || return 1
  printf '%s\\n' "$sig_value" | LC_ALL=C grep -Eq '^[0-9]+(:[0-9]+){4}$' || return 1
  printf '%s' "$sig_value"
}
# Sets FACT_NAME and FACT_KEY for running goat as $1: an installed executable, or an archive
# runner, which execs one. An executable changed less than 2 s ago is not keyed: a second write
# within the same second would leave its ctime unchanged.
exec_fact_key() {
  FACT_NAME=; FACT_KEY=
  [ -n "$GOAT_FACTS_DIR" ] && [ -f "$1" ] || return 1
  fact_versions="$HOME/.goat/runtime/goat/versions"
  case "$1" in
    "$fact_versions"/*/goat) fact_exe="$1"; fact_via=exe ;;
    *)
      command -v read_runner_hint >/dev/null 2>&1 || return 1
      [ -z "$(read_runner_hint "$1" GOAT_NODE_SCRIPT_PATH ${LEGACY_SSH_NODE_SCRIPT_PATH_KEY} 2>/dev/null)" ] || return 1
      fact_exe="$fact_versions/$(read_runner_hint "$1" GOAT_ARCHIVE_VERSION ${LEGACY_SSH_ARCHIVE_VERSION_KEY} 2>/dev/null)/goat"
      fact_via="$(runner_sha256 "$1" 2>/dev/null)" || return 1 ;;
  esac
  fact_version="\${fact_exe%/goat}"; fact_version="\${fact_version##*/}"
  valid_version "$fact_version" && [ "$fact_exe" = "$fact_versions/$fact_version/goat" ] || return 1
  fact_sig="$(file_sig "$fact_exe")" || return 1
  [ "$(( $(date +%s) - \${fact_sig##*:} ))" -ge 2 ] || return 1
  # A runner installs a version without its marker instead of running it.
  [ "$(cat "$fact_versions/$fact_version/.install-complete" 2>/dev/null)" = "$fact_version" ] || return 1
  case "$fact_via" in exe) FACT_NAME="$fact_version.exe" ;; *) FACT_NAME="$fact_version.runner" ;; esac
  FACT_KEY="$fact_exe $fact_sig $fact_via"
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
    [ ! -L "$GOAT_FACTS_DIR" ] && mkdir -p "$GOAT_FACTS_DIR" &&
      fact_tmp="$(mktemp "$GOAT_FACTS_DIR/.fact.XXXXXX")" || exit 0
    printf '%s\\n%s\\n' "$2" "$3" >"$fact_tmp" && mv -f "$fact_tmp" "$GOAT_FACTS_DIR/$1" || rm -f "$fact_tmp"
  ) 2>/dev/null || true
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
# A live answer from goat $1 depends on its executable, the runtime record $2, the launch port
# and PID files $3 and $4, and whether the PIDs they name still run the same processes.
live_fact_key() {
  exec_fact_key "$1" || return 1
  fact_live="$FACT_KEY"; FACT_KEY=
  [ -f "$2" ] && fact_record="$(tr '\\n' ' ' <"$2")" && [ -n "$fact_record" ] || return 1
  fact_pid="$(printf '%s\\n' "$fact_record" | sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')"
  valid_positive "$fact_pid" || return 1
  fact_record_port="$(printf '%s\\n' "$fact_record" | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\\([0-9][0-9]*\\).*/\\1/p')"
  valid_positive "$fact_record_port" || return 1
  fact_start="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$fact_pid" 2>/dev/null)" && [ -n "$fact_start" ] || return 1
  fact_port="$(cat "$3" 2>/dev/null || true)"; fact_remembered="$(cat "$4" 2>/dev/null || true)"
  fact_remembered_start=
  if valid_positive "$fact_remembered"; then
    fact_remembered_start="$(LC_ALL=C TZ=UTC ps -o lstart= -p "$fact_remembered" 2>/dev/null || true)"
  fi
  FACT_KEY="$fact_live|$fact_record|$fact_start|$fact_port|$fact_remembered|$fact_remembered_start"
}
# True when live PID $1 and port $2 are the record's own: only then does the record's process
# identify the server that answered. A historical or service-managed record answers PID 0, and
# whatever listens on its port may change without changing the key.
fact_bound() {
  [ "$1" = "$fact_pid" ] && [ "$2" = "$fact_record_port" ]
}
# Live protocol tokens from goat $1 for runtime record $2, port file $3 and PID file $4.
# Only a live answer from the record's own process is recorded; anything else is asked again.
live_fact() {
  live_fact_key "$1" "$2" "$3" "$4" || FACT_KEY=
  fact_name="live.$FACT_NAME"; fact_key="$FACT_KEY"
  if fact_get "$fact_name" "$fact_key"; then return 0; fi
  fact_out="$("$1" __ssh-helper protocol --runtime-file "$2" --port-file "$3" --pid-file "$4" --shell)" || return 1
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

export const REMOTE_PROTOCOL_TOKEN_SCRIPT = `valid_version() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(\\+[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$'
}
valid_uint() {
  printf '%s\\n' "$1" | LC_ALL=C grep -Eq '^(0|[1-9][0-9]*)$' || return 1
  [ "\${#1}" -le 16 ] && awk -v n="$1" 'BEGIN { exit !(n <= 9007199254740991) }'
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
runner_sha256() {
  if command -v shasum >/dev/null 2>&1; then digest="$(shasum -a 256 "$1")" || return 1
  elif command -v sha256sum >/dev/null 2>&1; then digest="$(sha256sum "$1")" || return 1
  else printf 'Install shasum or sha256sum to verify the retained GOAT runner.\\n' >&2; return 1; fi
  digest="\${digest%% *}"
  printf '%s\\n' "$digest" | LC_ALL=C grep -Eq '^[0-9a-f]{64}$' || return 1
  printf '%s' "$digest"
}
${REMOTE_FACTS_SCRIPT}
`;

// Retained runners are data: inspect either declaration spelling without sourcing shell code.
export const REMOTE_RUNNER_HINT_SCRIPT = String.raw`read_runner_hint() {
  if grep -q "^$2=" "$1"; then hint_key="$2"; else hint_key="$3"; fi
  sed -n "s/^$hint_key='\(.*\)'$/\1/p" "$1"
}
`;
