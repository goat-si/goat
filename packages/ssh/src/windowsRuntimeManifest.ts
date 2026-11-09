export const WINDOWS_MANIFEST_SUPPORT_SCRIPT = `windows_cached_own() {
  case "\${fact_uname-$(uname -s)}" in MINGW*|MSYS*|CYGWIN*) ;; *) return 1 ;; esac
  exec_fact_key "$2" || return 1
  [ "$(fact_get "version.$FACT_NAME" "$FACT_KEY")" = "goat v$1" ] || return 1
  wc_own="$(fact_get "own.$FACT_NAME" "$FACT_KEY")" || return 1
  wc_version="$1"; set -f; set -- $wc_own
  [ "$1" = "$wc_version" ] || return 1
  signals_json "$1" "$2" "$3"
}
# Sets WM_RECORDED to "<version>:<hash>" when goat $2's manifest marker and install record are
# regular files that both name version $1 and the same executable hash.
windows_manifest_recorded() {
  WM_RECORDED=
  case "\${fact_uname-$(uname -s)}" in MINGW*|MSYS*|CYGWIN*) ;; *) return 1 ;; esac
  wm_version="$1"; wm_dir="\${2%/goat}"
  wm_marker="$wm_dir/goat-manifest-shell-v1.sha256"
  wm_record="$wm_dir/.install-record"
  [ -f "$wm_marker" ] && [ ! -L "$wm_marker" ] &&
    [ -f "$wm_record" ] && [ ! -L "$wm_record" ] || return 1
  IFS=' ' read -r wm_v wm_hash wm_extra < "$wm_marker" || return 1
  [ "$wm_v" = "$wm_version" ] && [ -z "$wm_extra" ] || return 1
  IFS=' ' read -r wm_rv wm_archive wm_rhash wm_source wm_extra < "$wm_record" || return 1
  [ "$wm_rv" = "$wm_version" ] && [ "$wm_rhash" = "$wm_hash" ] &&
    [ -z "$wm_extra" ] || return 1
  WM_RECORDED="$wm_version:$wm_hash"
}
windows_manifest_key() {
  windows_manifest_recorded "$1" "$2" || return 1
  [ -f "$2" ] && [ ! -L "$2" ] || return 1
  wm_actual="$(runner_sha256 "$2")" || return 1
  [ "$wm_actual" = "$wm_hash" ] || return 1
  printf '%s' "$WM_RECORDED"
}
`;
