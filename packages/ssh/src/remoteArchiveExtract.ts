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
