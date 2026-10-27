#!/bin/sh
# Sets up a lightweight GOAT server: the self-contained goat CLI (no desktop
# app, Electron, Node or npm), a background service for this user, and the
# pairing links that add it to another GOAT.
#
#   curl -fsSL <url>/install-goat-server.sh | sh -s -- --tailscale
#   sh install-goat-server.sh --archive ./goat-<version>-linux-x64.tar.gz
#
# Options:
#   --archive FILE  install this CLI archive (scripts/build-cli-archive.ts output)
#                   instead of downloading a published release
#   --tailscale     publish the server on your tailnet (Tailscale Serve HTTPS)
#                   and print pairing links for that address
#   --opencodex     also install OpenCodex; joining a Home is a separate step
#   --no-service    skip the background service; run goat serve yourself
#   --no-pair       skip the pairing links
#
# Environment: GOAT_CHANNEL, GOAT_VERSION, GOAT_HOME, GOAT_INSTALL_BIN_DIR and
# GOAT_RELEASE_BASE_URL as for install.sh. GOAT_INSTALLER_URL replaces the
# install.sh download when this script runs outside a GOAT checkout.
set -eu

installer_url="${GOAT_INSTALLER_URL:-https://raw.githubusercontent.com/goat-si/goat-releases/main/install.sh}"
# Match install.sh and the CLI: an install from before the GOAT rename keeps ~/.t3
# until ~/.goat holds state, so the archive lands where the service looks.
if [ -z "${GOAT_HOME:-}" ] && [ ! -d "$HOME/.goat/userdata" ] && [ -d "$HOME/.t3/userdata" ]; then
  GOAT_HOME="$HOME/.t3"
  export GOAT_HOME
fi
goat_home="${GOAT_HOME:-$HOME/.goat}"
bin_dir="${GOAT_INSTALL_BIN_DIR:-$HOME/.local/bin}"
archive=
tailscale=false
service=true
pair=true
opencodex=false

fail() {
  printf '\ngoat server install: %s\n' "$1" >&2
  exit 1
}
say() { printf '%s\n' "$1" >&2; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --archive)
      [ "$#" -ge 2 ] || fail "--archive needs a file"
      archive="$2"
      shift 2
      ;;
    --archive=*) archive="${1#--archive=}"; shift ;;
    --tailscale) tailscale=true; shift ;;
    --opencodex) opencodex=true; shift ;;
    --no-service) service=false; shift ;;
    --no-pair) pair=false; shift ;;
    -h | --help)
      sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' >&2 || true
      exit 0
      ;;
    *) fail "unknown option $1 (see --help)" ;;
  esac
done

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "a GOAT server service needs Linux or macOS; on Windows run goat serve" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

# Unpacks a CLI archive into the layout install.sh and goat service install use,
# so goat update and the service treat it like a downloaded release.
install_archive() {
  [ -f "$1" ] || fail "$1 does not exist"
  name="$(basename "$1")"
  case "$name" in
    goat-*.tar.gz) ;;
    *) fail "$name is not a GOAT CLI archive (goat-<version>-<platform>-<arch>.tar.gz)" ;;
  esac
  stem="${name%.tar.gz}"
  key="${stem#goat-}"
  key="${key#"${key%-*-*}"-}"
  [ "$key" = "${platform}-${arch}" ] || fail "$name is built for ${key}; this machine needs ${platform}-${arch}"
  version="${stem#goat-}"
  version="${version%-"$key"}"
  sums="$(dirname "$1")/SHA256SUMS"
  if [ -f "$sums" ]; then
    expected="$(grep " \*\{0,1\}${name}\$" "$sums" | cut -d' ' -f1)"
    [ -n "$expected" ] || fail "$name is not listed in $sums"
    if command -v sha256sum >/dev/null 2>&1; then actual="$(sha256sum "$1" | cut -d' ' -f1)"
    else actual="$(shasum -a 256 "$1" | cut -d' ' -f1)"; fi
    [ "$actual" = "$expected" ] || fail "checksum mismatch for $name"
  fi
  versions_dir="${goat_home}/runtime/goat/versions"
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  tar -xzf "$1" -C "$staging" --strip-components=1
  "${staging}/goat" --version >/dev/null || fail "the goat executable in $name does not run here"
  printf '%s\n' "$version" > "${staging}/.install-complete"
  rm -rf "${versions_dir:?}/${version}"
  mv "$staging" "${versions_dir}/${version}"
  trap - EXIT
  mkdir -p "$bin_dir"
  ln -sfn "${versions_dir}/${version}/goat" "${bin_dir}/goat"
  say "Installed GOAT ${version} from ${name}."
}

if [ -n "$archive" ]; then
  install_archive "$archive"
elif [ -x "${bin_dir}/goat" ] || command -v goat >/dev/null 2>&1; then
  say "Using the goat command that is already installed; goat update moves it to a newer release."
else
  # From a checkout, use the install.sh next to this file; piped through sh, $0 is the shell.
  here=
  case "$0" in
    *install-goat-server.sh) here="$(cd "$(dirname "$0")" 2>/dev/null && pwd || true)" ;;
  esac
  if [ -n "$here" ] && [ -f "${here}/install.sh" ]; then
    sh "${here}/install.sh"
  else
    tmp="$(mktemp)"
    if command -v curl >/dev/null 2>&1; then curl -fsSL "$installer_url" -o "$tmp" || fail "could not download $installer_url"
    elif command -v wget >/dev/null 2>&1; then wget -q "$installer_url" -O "$tmp" || fail "could not download $installer_url"
    else fail "curl or wget is required"; fi
    sh "$tmp"
    rm -f "$tmp"
  fi
fi

if [ -x "${bin_dir}/goat" ]; then goat="${bin_dir}/goat"
elif command -v goat >/dev/null 2>&1; then goat="$(command -v goat)"
else fail "the goat command was not installed"; fi

if "$opencodex"; then
  say "Installing OpenCodex..."
  "$goat" opencodex install || fail "OpenCodex installation failed; GOAT is installed. Run: $goat opencodex install"
  say "OpenCodex is installed. Join this machine to your Home from Hub devices on the Home; installation alone does not make it Ready."
fi

if "$service"; then
  say "Starting GOAT as a background service..."
  "$goat" service install || fail "the service did not start; goat service status shows why, or run goat serve in a terminal"
else
  say "Skipping the service. Start the server with: $goat serve"
fi

"$pair" || exit 0
pair_flags=
if "$tailscale"; then pair_flags="--tailscale"; fi

# The service needs a few seconds before goat pair can find it. Without the service, pair
# only when a server is already running.
max_attempts=30
if ! "$service"; then max_attempts=1; fi
attempt=0
until app_pairing="$("$goat" pair $pair_flags --label "GOAT app" 2>&1)"; do
  attempt=$((attempt + 1))
  if ! "$service"; then
    say "No GOAT server is running yet. Start one with goat serve, then run goat pair for the pairing links."
    exit 0
  fi
  if [ "$attempt" -ge "$max_attempts" ]; then
    printf '%s\n' "$app_pairing" >&2
    fail "no running GOAT server answered; start one, then run: goat pair"
  fi
  sleep 2
done
# Only orchestration scopes: enough for agents, nothing else on this machine.
agent_pairing="$("$goat" pair $pair_flags --label "Agent link" --scope orchestration:read --scope orchestration:operate 2>&1)" ||
  fail "could not create the agent link: $agent_pairing"
agent_url="$(printf '%s\n' "$agent_pairing" | sed -n 's/^Pairing URL: //p' | head -n 1)"
link_name="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9._\n-' '-')"

printf '\nGOAT is running here. Both links work once and expire in 5 minutes; run goat pair for new ones.\n\n'
printf 'To see this machine in another GOAT app, open Settings > Connections > Add environment\nand paste the pairing URL, or scan the code:\n\n'
printf '%s\n' "$app_pairing"
printf '\nTo let agents in that GOAT use this machine, tell one of them:\n\n'
printf '  Link %s as %s\n\n' "$agent_url" "${link_name:-goat-server}"
