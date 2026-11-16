// Release-archive download and unpack steps of the remote runner, interpolated into it verbatim.
export const REMOTE_ARCHIVE_FETCH = `  goat_fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q --timeout=30 --tries=1 "$1" -O "$2"
    else printf 'Remote host needs curl or wget to download %s.\\n' "$GOAT_ARCHIVE" >&2; exit 1
    fi
  }`;

export const REMOTE_ARCHIVE_EXTRACT = `  case "$GOAT_PLATFORM_KEY" in
    win32-*) "$(cygpath -S)/tar.exe" -xf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1 ;; # GNU tar cannot read zip.
    *) tar -xzf "$GOAT_STAGING/$GOAT_ARCHIVE" -C "$GOAT_STAGING" --strip-components=1 ;;
  esac`;
