export const REMOTE_ARCHIVE_EXTRACT = `  case "$GOAT_PLATFORM_KEY" in
    win32-*) "$(cygpath -S)/tar.exe" -xf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1 ;; # GNU tar cannot read zip.
    *)
      if ! GOAT_TAR_ERROR="$(tar -xzf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1 2>&1)"; then
        if command -v gzip >/dev/null 2>&1; then printf '%s\\n' "$GOAT_TAR_ERROR" >&2
        else printf 'Remote host needs gzip to unpack %s. Install gzip on it and try again.\\n' "$GOAT_ARCHIVE" >&2
        fi
        exit 1
      fi ;;
  esac`;

export const REMOTE_ARCHIVE_FETCH = `  goat_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$1" -O "$2"
    else printf 'Remote host needs curl or wget to download %s.\\n' "$GOAT_ARCHIVE" >&2; exit 1
    fi || {
      printf 'Could not download GOAT %s from %s. If this host cannot reach it, install GOAT with GOAT_VERSION=%s using https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh or configure a release mirror.\\n' "$GOAT_ARCHIVE_VERSION" "$1" "$GOAT_ARCHIVE_VERSION" >&2
      exit 1
    }
  }`;
