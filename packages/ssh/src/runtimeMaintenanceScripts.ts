// Use the existing post-install round trip: young executables remain unkeyed everywhere else.
export const REMOTE_RUNTIME_FACT_WARMUP_SCRIPT = String.raw`warm_runtime_facts() (
  [ -n "$GOAT_FACTS_DIR" ] || exit 0
  # Skip an observed rollback window; concurrent changes are covered by each fact's keys.
  [ ! -e "$STATE_DIR/run-t3.previous" ] && [ ! -L "$STATE_DIR/run-t3.previous" ] || exit 1
  warm_exe="$HOME/.goat/runtime/goat/versions/$SELECTED_VERSION/goat"
  warm_sig="$(file_sig "$warm_exe")" || exit 1
  warm_age=$(( $(date +%s) - ${"${warm_sig##*:}"} ))
  # A clock behind ctime is not a reason to extend the cleanup's deadline.
  [ "$warm_age" -ge 0 ] || exit 1
  if [ "$warm_age" -lt 2 ]; then sleep "$(( 2 - warm_age ))" || exit 1; fi
  exec_fact_key "$warm_exe" || exit 1
  warm_exe_key="$FACT_KEY"; warm_exe_name="$FACT_NAME"
  # Independent answers run side by side, so warming costs about two goat starts on a host
  # whose cleanup already used most of the deadline.
  exec_fact version "$warm_exe" --version >/dev/null 2>&1 &
  exec_fact own "$warm_exe" __ssh-helper protocol --shell >/dev/null 2>&1 &
  build_commit_time "$warm_exe" >/dev/null 2>&1 &
  lacks_memory_scopes "$warm_exe" >/dev/null 2>&1 &
  if warm_live="$(live_fact "$warm_exe" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" 2>/dev/null)"; then
    (
      set -f; set -- $warm_live
      valid_live_tokens "$@" && [ "$1" = live ] && [ "$2" = "$SELECTED_VERSION" ] &&
        [ "$6" = "$REMOTE_PORT" ] &&
        compat_fact "$warm_exe" "$6" "$DEFAULT_RUNTIME_FILE" "$PORT_FILE" "$PID_FILE" "$5" >/dev/null 2>&1
    ) || true
  fi
  wait || true
  # exec_fact_key keys a runner only when it is an archive runner that execs this executable
  # with the same arguments, so its answers are the executable's under the runner's key.
  exec_fact_key "$RUNNER_FILE" || exit 0
  # The runner may have been republished for another version while this ran.
  [ "${"${FACT_KEY% *}"}" = "${"${warm_exe_key% *}"}" ] || exit 0
  warm_runner_key="$FACT_KEY"; warm_runner_name="$FACT_NAME"
  exec_fact_key "$warm_exe" && [ "$FACT_KEY" = "$warm_exe_key" ] || exit 0
  for warm_kind in version own commit scopes live compat; do
    warm_file="$GOAT_FACTS_DIR/$warm_kind.$warm_exe_name"
    [ -f "$warm_file" ] && [ ! -L "$warm_file" ] || continue
    { IFS= read -r warm_key && IFS= read -r warm_value; } <"$warm_file" || continue
    case "$warm_key" in "$warm_exe_key"*) ;; *) continue ;; esac
    fact_valid "$warm_kind" "$warm_value" || continue
    fact_put "$warm_kind.$warm_runner_name" "$warm_runner_key${'${warm_key#"$warm_exe_key"}'}" "$warm_value"
  done
)
warm_runtime_facts >/dev/null 2>&1 || exit 0
`;

// The caller holds the replacement mutex after readiness, outside any supervisor trial.
export const REMOTE_RUNTIME_CLEANUP_SCRIPT = String.raw`cleanup_runtime_versions() {
  [ "$GOAT_HOST_WINDOWS" = 0 ] && [ "$GOAT_ARCHIVE_MODE" = 1 ] || return 0
  [ "$LOCK_HELD" = 1 ] && [ -z "${"${UPGRADE_VERSION:-}"}" ] || return 0
  [ "$(readlink "$LOCK" 2>/dev/null)" = "$OWNER" ] || return 1
  # A detached supervisor can outlive the SSH shell that owned the replacement lock.
  [ ! -e "$STATE_DIR/run-t3.previous" ] && [ ! -L "$STATE_DIR/run-t3.previous" ] || return 1
  for parent in "$HOME" "$HOME/.goat" "$HOME/.goat/runtime" "$HOME/.goat/runtime/goat" "$HOME/.goat/runtime/goat/versions"; do
    [ -d "$parent" ] && [ ! -L "$parent" ] || return 1
  done
  versions="$HOME/.goat/runtime/goat/versions"
  # Linux names every process's executable and directory under /proc. macOS has no /proc,
  # so lsof answers the same question there.
  cleanup_lsof=
  if [ ! -d /proc/self ]; then
    for candidate in "$(command -v lsof 2>/dev/null || true)" /usr/sbin/lsof /sbin/lsof; do
      if [ -n "$candidate" ] && [ -x "$candidate" ]; then cleanup_lsof="$candidate"; break; fi
    done
    [ -n "$cleanup_lsof" ] || return 1
  fi
  [ ! -L "$versions/.maintenance.lock" ] || return 1
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$versions/.maintenance.lock" || return 1
    flock -n -x 9 || return 1
  else
    # Without flock (macOS) an atomic directory is the mutex, released when this subshell
    # exits. One a killed cleanup left behind over an hour ago is stale.
    maintenance="$versions/.maintenance.lock.d"
    [ ! -L "$maintenance" ] || return 1
    if ! mkdir "$maintenance" 2>/dev/null; then
      [ -n "$(find "$maintenance" -maxdepth 0 -mmin +60 2>/dev/null)" ] &&
        rmdir "$maintenance" 2>/dev/null && mkdir "$maintenance" 2>/dev/null || return 1
    fi
    trap 'rmdir "$maintenance" 2>/dev/null || true' EXIT
  fi
  set +f
  # Older clients do not take the maintenance mutex; their install locks still veto cleanup.
  for install in "$versions"/.*.install.lock*; do
    [ ! -e "$install" ] && [ ! -L "$install" ] || return 1
  done
  retained="$(read_runner_hint "$RUNNER_FILE" GOAT_ARCHIVE_VERSION T3_ARCHIVE_VERSION)" || return 1
  valid_version "$retained" && valid_version "$SELECTED_VERSION" || return 1
  live_binary="$versions/$SELECTED_VERSION/goat"
  [ ! -L "$versions/$SELECTED_VERSION" ] && [ ! -L "$live_binary" ] || return 1
  # Revalidate the descriptor under both mutexes, after the readiness handshake.
  live="$("$live_binary" __ssh-helper protocol --runtime-file "$DEFAULT_RUNTIME_FILE" --port-file "$PORT_FILE" --pid-file "$PID_FILE" --shell)" || return 1
  set -f; set -- $live; set +f
  valid_live_tokens "$@" && [ "$1" = live ] && [ "$2" = "$SELECTED_VERSION" ] &&
    [ "$6" = "$REMOTE_PORT" ] || return 1
  cleanup_process_paths() {
    # Only this user's processes can run from this user's runtime directory, and /proc
    # hides other users' executable and cwd links from an unprivileged reader.
    uid="$(id -u)" || return 1
    commands="$(ps -o command= -U "$uid")" && pids="$(ps -o pid= -U "$uid")" || return 1
    [ -n "$commands" ] && [ -n "$pids" ] || return 1
    paths="$commands"
    if [ -n "$cleanup_lsof" ]; then
      # Like an unreadable /proc entry, any lsof failure vetoes deletion.
      open_paths="$("$cleanup_lsof" -n -P -w -a -u "$uid" -d cwd,txt -Fn 2>/dev/null)" || return 1
      paths="$paths
$(printf '%s\n' "$open_paths" | sed -n 's/^n//p')"
      return 0
    fi
    # ps alone misses chdir and exec with a custom argv[0]. An unreadable live process vetoes
    # deletion; one that exited since ps listed it has nothing left to protect.
    for pid in $pids; do
      case "$pid" in *[!0-9]*|'') return 1 ;; esac
      if executable="$(readlink "/proc/$pid/exe")" && cwd="$(readlink "/proc/$pid/cwd")"; then
        paths="$paths
$executable
$cwd"
      elif [ -e "/proc/$pid" ]; then
        return 1
      fi
    done
  }
  cleanup_process_paths || return 1
  cleanup_commit() {
    binary="$versions/$1/goat"
    [ ! -L "$binary" ] && [ ! -L "$versions/$1/.install-record" ] || return 1
    record="$(cat "$versions/$1/.install-record" 2>/dev/null)" || return 1
    set -f; set -- $record; set +f
    [ "$#" = 4 ] && [ "$versions/$1/goat" = "$binary" ] || return 1
    [ "$(runner_sha256 "$binary")" = "$3" ] || return 1
    build_commit_time "$binary"
  }
  cleanup_order() {
    first="$1"; second="$2"; set --
    if first_time="$(cleanup_commit "$first")" && second_time="$(cleanup_commit "$second")"; then
      set -- --live-commit-time "$first_time" --requested-commit-time "$second_time"
    fi
    "$live_binary" __ssh-helper compare-version "$@" "$first" "$second" 2>/dev/null
  }
  # A complete install that is provably older than the live build.
  cleanup_older() {
    dir="$versions/$1"
    [ -d "$dir" ] && [ ! -L "$dir" ] && [ -x "$dir/goat" ] && [ ! -L "$dir/goat" ] || return 1
    valid_version "$1" && [ "$1" != "$SELECTED_VERSION" ] || return 1
    [ ! -L "$dir/.install-complete" ] && [ "$(cat "$dir/.install-complete" 2>/dev/null)" = "$1" ] || return 1
    [ "$(cleanup_order "$SELECTED_VERSION" "$1")" = newer ]
  }
  cleanup_ifs="$IFS"; IFS='
'
  # Install markers, most recent first. Version names never contain a newline.
  installed="$(ls -t "$versions"/*/.install-complete 2>/dev/null || true)"
  # One rollback build is kept: the older build installed last, which this host ran before
  # the live one.
  previous=
  for marker in $installed; do
    # Only the list splits on newlines; commands inside split words as usual.
    IFS="$cleanup_ifs"
    version="${"${marker%/.install-complete}"}"; version="${"${version##*/}"}"
    if cleanup_older "$version"; then previous="$version"; break; fi
  done
  # Each check starts goat, so a long backlog is pruned over several connections within the
  # caller's deadline, oldest installs first.
  started="$(date +%s)"
  IFS='
'
  for marker in $(printf '%s\n' "$installed" | awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }'); do
    IFS="$cleanup_ifs"
    [ $(( $(date +%s) - started )) -lt 6 ] || break
    version="${"${marker%/.install-complete}"}"; version="${"${version##*/}"}"
    [ "$version" != "$previous" ] && [ "$version" != "$retained" ] &&
      [ "$version" != "$REQUESTED_VERSION" ] || continue
    cleanup_older "$version" || continue
    dir="$versions/$version"
    cleanup_process_paths || return 1
    case "$paths" in *"$dir/"*|*"$dir
"*|*"$dir") continue ;; esac
    [ ! -L "$dir" ] || return 1
    [ ! -e "$versions/.$version.install.lock" ] && [ ! -L "$versions/.$version.install.lock" ] || return 1
    trash="$(mktemp -d "$versions/.trash-XXXXXXXX")" || return 1
    # Moving into an owned empty sibling keeps a failed recursive delete out of runtime discovery.
    mv "$dir" "$trash/runtime" || return 1
    rm -rf "$trash" || return 1
    printf 'ssh.runtime.cleanup.removed version=%s\n' "$version" >&2
  done
  IFS="$cleanup_ifs"
  # Staging exists only while an install holds its lock, and none is held now.
  for leftover in "$versions"/.staging-* "$versions"/.trash-*; do
    [ -d "$leftover" ] && [ ! -L "$leftover" ] || continue
    [ -n "$(find "$leftover" -maxdepth 0 -mmin +60 2>/dev/null)" ] || continue
    rm -rf "$leftover" || return 1
    printf 'ssh.runtime.cleanup.removed leftover=%s\n' "${"${leftover##*/}"}" >&2
  done
}
(cleanup_runtime_versions) || { printf 'ssh.runtime.cleanup.skipped inspection, lock, or cleanup failed\n' >&2 || true; }
`;
