#!/bin/bash
# Checks that this Mac can sign and notarize GOAT release builds, the way the
# goat-nightly workflow will use it. Prints no secret values.
#
#   bash scripts/goat-mac-runner/preflight.sh            # human checklist
#   bash scripts/goat-mac-runner/preflight.sh --ci       # also export signing env to $GITHUB_ENV
#   bash scripts/goat-mac-runner/preflight.sh --offline  # skip the notary service check
#
# Options: --team <id> (default U9ATA49N28), --profile <name> (default goat-notary).
# See docs/operations/goat-mac-release-runner.md.
set -uo pipefail

team="U9ATA49N28"
profile="goat-notary"
ci=false
offline=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --ci) ci=true ;;
    --offline) offline=true ;;
    --team) team="$2"; shift ;;
    --profile) profile="$2"; shift ;;
    *) echo "preflight: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

keychain="$HOME/Library/Keychains/login.keychain-db"
# The runner LaunchAgent keeps the PATH it was configured with; rustup's default
# location is added so cargo is found either way.
if [ -d "$HOME/.cargo/bin" ]; then PATH="$HOME/.cargo/bin:$PATH"; fi
failures=0
pass() { printf '  ok    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n        %s\n' "$1" "$2"; failures=$((failures + 1)); }

# Runs a command with a time limit (macOS has no timeout(1)); returns 124 on expiry.
with_timeout() {
  local seconds="$1"; shift
  "$@" &
  local pid=$!
  ( sleep "$seconds"; kill -TERM "$pid" 2>/dev/null ) &
  local watchdog=$!
  wait "$pid"; local status=$?
  if kill -0 "$watchdog" 2>/dev/null; then kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null; return "$status"; fi
  return 124
}

echo "GOAT release runner preflight (team $team, notary profile $profile)"

# 1. Session: the login keychain is only usable from the logged-in GUI (Aqua)
#    session, which is where svc.sh installs the runner LaunchAgent.
session="$(launchctl managername 2>/dev/null || echo unknown)"
if [ "$session" = "Aqua" ]; then
  pass "running in the Aqua (GUI login) session"
else
  fail "running in the '$session' session" \
    "Run the runner as a LaunchAgent of the logged-in user (svc.sh install); SSH and LaunchDaemon sessions cannot use the login keychain."
fi

# 2. Tools.
for tool in codesign spctl hdiutil ditto security; do
  if command -v "$tool" >/dev/null 2>&1; then pass "$tool"; else fail "$tool" "Install the Xcode Command Line Tools."; fi
done
for tool in notarytool stapler; do
  if xcrun --find "$tool" >/dev/null 2>&1; then pass "xcrun $tool"; else fail "xcrun $tool" "Install the Xcode Command Line Tools (xcode-select --install)."; fi
done
if command -v cargo >/dev/null 2>&1 && command -v rustup >/dev/null 2>&1; then
  installed="$(rustup target list --installed 2>/dev/null)"
  for target in aarch64-apple-darwin x86_64-apple-darwin; do
    if printf '%s\n' "$installed" | grep -qx "$target"; then pass "rust target $target"; else fail "rust target $target" "rustup target add $target"; fi
  done
else
  fail "rust toolchain" "Install rustup (https://rustup.rs) for the runner user, then: rustup target add aarch64-apple-darwin x86_64-apple-darwin"
fi

# 3. Keychain.
if security show-keychain-info "$keychain" >/dev/null 2>&1; then
  pass "login keychain is unlocked"
else
  fail "login keychain is locked or unreachable" "Log in at the console of this Mac; the runner needs the user's GUI session."
fi

# 4. Signing identity: exactly one Developer ID Application identity for the team.
identities="$(security find-identity -v -p codesigning "$keychain" 2>/dev/null |
  sed -n "s/^ *[0-9]*) \([0-9A-F]\{40\}\) \"\(Developer ID Application: .* ($team)\)\"$/\1 \2/p" | sort -u)"
count="$(printf '%s' "$identities" | grep -c . || true)"
identity_hash=""
identity_name=""
if [ "$count" = "1" ]; then
  identity_hash="${identities%% *}"
  identity_name="${identities#* }"
  pass "signing identity: $identity_name"
elif [ "$count" = "0" ]; then
  fail "no Developer ID Application identity for team $team in the login keychain" \
    "Import the certificate and private key (docs/operations/goat-mac-release-runner.md, step 1)."
else
  fail "$count Developer ID Application identities for team $team" "Keep exactly one valid identity in the login keychain."
fi

# 5. The private key must be usable by codesign without a confirmation dialog.
if [ -n "$identity_hash" ]; then
  scratch="$(mktemp -d)"
  cp /usr/bin/true "$scratch/goat-preflight"
  if with_timeout 60 codesign --force --sign "$identity_hash" --keychain "$keychain" --options runtime --timestamp "$scratch/goat-preflight" >/dev/null 2>&1 &&
    codesign --verify --strict "$scratch/goat-preflight" >/dev/null 2>&1; then
    pass "codesign can use the private key unattended"
  else
    fail "codesign could not sign a scratch binary within 60s" \
      "Allow codesign to use the key without a dialog: run this script once in Terminal and choose Always Allow, or set the key's partition list (docs/operations/goat-mac-release-runner.md, step 1)."
  fi
  rm -rf "$scratch"
fi

# 6. Notary credentials stored by: xcrun notarytool store-credentials goat-notary ...
if [ "$offline" = true ]; then
  echo "  skip  notarytool profile check (--offline)"
elif with_timeout 90 xcrun notarytool history --keychain-profile "$profile" --keychain "$keychain" >/dev/null 2>&1; then
  pass "notarytool profile '$profile' authenticates"
else
  fail "notarytool profile '$profile' did not authenticate" \
    "Store it once in this user's login keychain: xcrun notarytool store-credentials $profile --apple-id <Apple ID> --team-id $team (step 2 of the runbook)."
fi

if [ "$failures" -gt 0 ]; then
  echo "preflight: $failures check(s) failed"
  exit 1
fi

if [ "$ci" = true ]; then
  if [ -z "${GITHUB_ENV:-}" ]; then
    echo "preflight: --ci needs GITHUB_ENV" >&2
    exit 1
  fi
  {
    # electron-builder wants the certificate name without its type prefix.
    echo "CSC_NAME=${identity_name#Developer ID Application: }"
    echo "CSC_KEYCHAIN=$keychain"
    echo "CSC_IDENTITY_AUTO_DISCOVERY=true"
    echo "APPLE_KEYCHAIN=$keychain"
    echo "T3CODE_CLI_MAC_SIGN_IDENTITY=$identity_name"
  } >> "$GITHUB_ENV"
  if [ -d "$HOME/.cargo/bin" ] && [ -n "${GITHUB_PATH:-}" ]; then
    echo "$HOME/.cargo/bin" >> "$GITHUB_PATH"
  fi
fi
echo "preflight: ready"
