#!/bin/bash
# Installs and registers the GOAT macOS release runner on this Mac (the Mac Studio).
# Run it yourself in Terminal while logged in at this Mac's console. It does not
# touch the keychain. See docs/operations/goat-mac-release-runner.md.
#
#   bash scripts/goat-mac-runner/install-runner.sh [--dry-run]
#        [--dir ~/actions-runner/goat-mac-studio] [--name goat-mac-studio] [--repo goat-si/goat]
#
# The registration token comes from your own gh login (repository admin) and
# reaches config.sh through its environment, never through argv or output.
set -euo pipefail
set +x

runner_version="2.338.0"
runner_sha256="df4cebda25c86a886ed204e49fee63f5c2e7cec5f447b5c98440a826bbdf9df2"
dir="$HOME/actions-runner/goat-mac-studio"
name="goat-mac-studio"
repo="goat-si/goat"
dry_run=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) dir="$2"; shift ;;
    --name) name="$2"; shift ;;
    --repo) repo="$2"; shift ;;
    --dry-run) dry_run=true ;;
    *) echo "install-runner: unknown option $1" >&2; exit 2 ;;
  esac
  shift
done
say() { printf 'install-runner: %s\n' "$*"; }
run() { if [ "$dry_run" = true ]; then printf 'would run:'; printf ' %q' "$@"; echo; else "$@"; fi; }
case "$dir" in /*) ;; *) dir="$PWD/$dir" ;; esac

[ "$(uname -s)/$(uname -m)" = "Darwin/arm64" ] || { say "this installs the Apple silicon macOS runner" >&2; exit 1; }
# svc.sh installs a LaunchAgent; only the logged-in GUI session can use the login
# keychain that holds the signing identity (measured, devlog/_fin/261012_release_nightly M1).
[ "$(launchctl managername)" = "Aqua" ] || { say "run this in Terminal at the Mac's console, not over SSH" >&2; exit 1; }
command -v gh >/dev/null || { say "gh is required (brew install gh; gh auth login)" >&2; exit 1; }

# 1. Runner files, pinned and checksummed.
archive="actions-runner-osx-arm64-$runner_version.tar.gz"
if [ -x "$dir/config.sh" ]; then
  say "runner files present in $dir"
else
  run mkdir -p "$dir"
  if [ "$dry_run" = true ]; then
    echo "would download $archive, check sha256 $runner_sha256, and unpack into $dir"
  else
    tmp="$(mktemp -d)"
    curl -fsSLo "$tmp/$archive" "https://github.com/actions/runner/releases/download/v$runner_version/$archive"
    (cd "$tmp" && echo "$runner_sha256  $archive" | shasum -a 256 -c -)
    tar xzf "$tmp/$archive" -C "$dir"
    rm -r "$tmp"
  fi
fi

# 2. Registration (skipped when this directory is already registered here).
if [ -f "$dir/.runner" ]; then
  if grep -q "\"agentName\": *\"$name\"" "$dir/.runner" && grep -q "github.com/$repo\"" "$dir/.runner"; then
    say "already registered as $name on $repo"
  else
    say "$dir/.runner belongs to another runner; remove it first (see the runbook) or pass --dir" >&2
    exit 1
  fi
elif [ "$dry_run" = true ]; then
  echo "would fetch a registration token with: gh api -X POST repos/$repo/actions/runners/registration-token"
  echo "would run: ./config.sh --url https://github.com/$repo --name $name --labels goat,mac-studio --work _work --unattended --replace (token via ACTIONS_RUNNER_INPUT_TOKEN)"
else
  (
    cd "$dir"
    ACTIONS_RUNNER_INPUT_TOKEN="$(gh api -X POST "repos/$repo/actions/runners/registration-token" --jq .token)"
    export ACTIONS_RUNNER_INPUT_TOKEN
    ./config.sh --url "https://github.com/$repo" --name "$name" --labels goat,mac-studio \
      --work _work --unattended --replace
  )
fi

# 3. The service keeps the PATH saved in .path; make sure cargo is on it.
if [ "$dry_run" = false ] && [ -d "$HOME/.cargo/bin" ]; then
  current="$(cat "$dir/.path" 2>/dev/null || printf '%s' "$PATH")"
  case ":$current:" in
    *":$HOME/.cargo/bin:"*) ;;
    *) printf '%s:%s\n' "$HOME/.cargo/bin" "$current" > "$dir/.path" ;;
  esac
fi

# 4. LaunchAgent service. svc.sh refuses to install over an existing plist and
# records the installed service in .service.
cd "$dir" 2>/dev/null || [ "$dry_run" = true ]
if [ -f "$dir/.service" ] && [ -f "$(cat "$dir/.service")" ]; then
  say "service already installed ($(cat "$dir/.service"))"
else
  run ./svc.sh install
fi

# svc.sh writes SessionCreate=true, which starts the runner in a new security
# session where the login keychain reads as locked: codesign and notarytool then
# fail although the same checks pass in Terminal (measured on the Mac Studio).
plist=""
if [ -f "$dir/.service" ]; then plist="$(cat "$dir/.service")"; fi
if [ -n "$plist" ] && /usr/libexec/PlistBuddy -c 'Print :SessionCreate' "$plist" >/dev/null 2>&1; then
  # Unload before editing, so a failed bootout leaves the key in place and the
  # next run still sees the repair it owes.
  if [ "$dry_run" = false ] && launchctl print "gui/$(id -u)/$(basename "$plist" .plist)" >/dev/null 2>&1; then
    run launchctl bootout "gui/$(id -u)/$(basename "$plist" .plist)"
  fi
  run /usr/libexec/PlistBuddy -c 'Delete :SessionCreate' "$plist"
fi

# svc.sh start can load the agent without running it; kickstart until it runs.
service_label=""
if [ -n "$plist" ]; then service_label="$(basename "$plist" .plist)"; fi
service_state=""
if [ -n "$service_label" ]; then
  service_state="$(launchctl print "gui/$(id -u)/$service_label" 2>/dev/null || true)"
fi
if [[ "$service_state" == *"state = running"* ]]; then
  say "service already running"
else
  run ./svc.sh start
  if [ -n "$service_label" ]; then
    launchctl print "gui/$(id -u)/$service_label" >/dev/null 2>&1 || run launchctl bootstrap "gui/$(id -u)" "$plist"
    run launchctl kickstart "gui/$(id -u)/$service_label"
  fi
fi
run ./svc.sh status
say "done. Labels: self-hosted, macOS, ARM64, goat, mac-studio."
