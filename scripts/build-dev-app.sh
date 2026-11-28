#!/usr/bin/env bash
# Builds GOAT 2 (Dev) and installs it to /Applications on this Mac.
#   goat2-host (cargo --release, kache via ~/.cargo/config.toml) + apps/web (vite) + apps/desktop (tsc)
#   -> Electron.app renamed to "GOAT 2 (Dev).app", bundle id si.goat.goat2.dev, ad-hoc signed.
# Identity (structure/10_processes.md): data ~/.goat2-dev, host port 3873, nothing shared with GOAT v1.
#
# Usage: scripts/build-dev-app.sh [--no-install] [--no-open]
#   (default)     build origin/goat2 and install it here
#   --no-install  build the checkout this script lives in, into build/goat2-dev/ (lane testing)
#   --no-open     do not relaunch the app after installing (it is relaunched only if it was running)
#   --build-sha <sha>  internal: build <sha> in ~/Developer/goat2_devbuild and stop (the remote half)
#
# Installing (owner 2026-11-28, docs/lanes/PART1.md):
# - takes /tmp/goat2-merge.lock (owner file; refuses while a lane holds it) only for the instant of
#   git fetch + reading origin/goat2's SHA, then releases it;
# - builds that SHA in a detached worktree ~/Developer/goat2_devbuild (cleaned, node_modules and target
#   kept), never in ~/Developer/goat2, at nice 10, on GOAT2_DEVBUILD_HOST (default mac-studio, so this Mac
#   keeps its CPU; GOAT2_DEVBUILD_HOST=local builds here);
# - a remote build is copied back with rsync, quarantine is stripped (xattr -cr), the signature and the
#   stamp (that SHA, clean) are verified, then it is installed;
# - the build refuses when pnpm -r typecheck or cargo test --workspace --locked fails, so a broken goat2
#   is never installed. --locked also refuses a Cargo.lock that is out of date.
set -euo pipefail

APP_NAME="GOAT 2 (Dev)"
BUNDLE_ID="si.goat.goat2.dev"
INSTALL_DIR="/Applications"
INSTALL=1
OPEN=1
BUILD_SHA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install) INSTALL=0 ;;
    --no-open) OPEN=0 ;;
    --build-sha)
      BUILD_SHA="${2:-}"
      [[ "$BUILD_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "--build-sha needs a full commit SHA" >&2; exit 2; }
      INSTALL=0
      shift
      ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "GOAT 2 (Dev) packaging is macOS only" >&2; exit 1; }
MERGE_LOCK="/tmp/goat2-merge.lock"
DEVBUILD="${GOAT2_DEVBUILD_DIR:-$HOME/Developer/goat2_devbuild}"   # override: local tests only
# The merge checkout on every machine (docs/lanes/PART1.md); the build worktree hangs off it.
SOURCE_REPO="$HOME/Developer/goat2"
BUILD_HOST="${GOAT2_DEVBUILD_HOST:-mac-studio}"
REMOTE_SCRIPT="Developer/.goat2-build-dev-app.sh"   # relative to the build host's home
# docs/lanes/PART1.md (goat2 1f8912e): the lock is a directory with an owner file; only its owner
# releases it, and a failed mkdir means someone else holds it.
LOCK_OWNER="goat2_desktop build-dev-app $$"
OWN_LOCK=0
release_lock() {
  if [[ $OWN_LOCK == 1 ]]; then
    # Ours: our mkdir succeeded. The owner file can be missing only if we stopped before writing it.
    local owner
    owner="$(cat "$MERGE_LOCK/owner" 2>/dev/null || true)"
    if [[ -z "$owner" || "$owner" == "$LOCK_OWNER" ]]; then rm -rf "$MERGE_LOCK"; fi
    OWN_LOCK=0
  fi
}
# Installed before mkdir so no exit path after taking the lock can leave it behind (SIGKILL aside).
trap release_lock EXIT

# Checks <sha> out detached in $DEVBUILD (a worktree of $1), cleaned except dependency/Rust caches.
prepare_devbuild() {
  local repo="$1" sha="$2"
  git -C "$repo" fetch -q origin goat2
  git -C "$repo" cat-file -e "$sha^{commit}"
  if [[ -e "$DEVBUILD" ]]; then
    if [[ "$(git -C "$DEVBUILD" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" != \
      "$(git -C "$repo" rev-parse --path-format=absolute --git-common-dir)" ]]; then
      echo "$DEVBUILD exists but is not a worktree of $repo: not building" >&2
      exit 1
    fi
    git -C "$DEVBUILD" checkout -q --detach --force "$sha"
  else
    echo "==> creating the build worktree $DEVBUILD"
    git -C "$repo" worktree add -q --detach "$DEVBUILD" "$sha"
  fi
  git -C "$DEVBUILD" clean -q -fdx -e node_modules -e target
  if [[ "$(git -C "$DEVBUILD" rev-parse HEAD)" != "$sha" || -n "$(git -C "$DEVBUILD" status --porcelain)" ]]; then
    echo "$DEVBUILD is not a clean checkout of $sha: not building" >&2
    git -C "$DEVBUILD" status --short >&2
    exit 1
  fi
}

# Installs the .app at $1 (stamp already checked) to /Applications, quitting and relaunching a running one.
install_app() {
  local src="$1" stamp="$2"
  local target="$INSTALL_DIR/$APP_NAME.app"
  # pgrep -f takes a regex; escape the parentheses and dots in the app path.
  local target_re
  target_re="$(printf '%s' "$target/Contents/MacOS/" | sed 's/[][\.*^$()+?{}|]/\\&/g')"
  local was_running=0
  if pgrep -f "$target_re" >/dev/null; then
    was_running=1
    echo "==> quitting the running $APP_NAME (quitting ends its work)"
    osascript -e "tell application id \"$BUNDLE_ID\" to quit" || true
    for _ in $(seq 1 100); do pgrep -f "$target_re" >/dev/null || break; sleep 0.2; done
    if pgrep -f "$target_re" >/dev/null; then
      echo "$APP_NAME did not quit within 20 s; quit it and run again" >&2
      exit 1
    fi
  fi
  if [[ -e "$target" ]]; then
    local existing
    existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$target/Contents/Info.plist" 2>/dev/null || true)"
    if [[ "$existing" != "$BUNDLE_ID" ]]; then
      echo "$target exists with bundle id '$existing'; not replacing it" >&2
      exit 1
    fi
    rm -rf "$target"
  fi
  ditto "$src" "$target"
  echo "installed: $target ($stamp)"
  if [[ $was_running == 1 && $OPEN == 1 ]]; then
    # GOAT threads export ELECTRON_RUN_AS_NODE=1; open passes it on and Electron would start as plain Node.
    env -u ELECTRON_RUN_AS_NODE open "$target"
    echo "relaunched $APP_NAME"
  fi
}

if [[ $INSTALL == 1 ]]; then
  INVOKED_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  # The merge procedure holds this lock while a lane merges into ~/Developer/goat2 and tests the result,
  # so origin/goat2 is read under it; the build itself runs without it.
  if ! mkdir "$MERGE_LOCK" 2>/dev/null; then
    echo "a merge into goat2 is in progress ($MERGE_LOCK exists): not building. Run again when it is gone." >&2
    exit 1
  fi
  OWN_LOCK=1
  echo "$LOCK_OWNER" > "$MERGE_LOCK/owner"
  git -C "$INVOKED_REPO" fetch -q origin goat2
  SHA="$(git -C "$INVOKED_REPO" rev-parse --verify 'origin/goat2^{commit}')"
  release_lock
  COMMIT="${SHA:0:12}"

  if [[ "$BUILD_HOST" != "local" ]]; then
    echo "==> building goat2 $COMMIT on $BUILD_HOST"
    ssh -o BatchMode=yes "$BUILD_HOST" "cat > $REMOTE_SCRIPT" < "${BASH_SOURCE[0]}"
    # Login shell for the build host's PATH (node, pnpm, cargo, kache); stdin closed so no build step
    # can read from this ssh session.
    ssh -o BatchMode=yes "$BUILD_HOST" "zsh -l -c 'bash \$HOME/$REMOTE_SCRIPT --build-sha $SHA' < /dev/null"
    STAGE="$(mktemp -d "${TMPDIR:-/tmp}/goat2-devbuild-fetch.XXXXXX")"
    echo "==> copying the app back from $BUILD_HOST"
    rsync -a --delete "$BUILD_HOST:Developer/goat2_devbuild/build/goat2-dev/" "$STAGE/"
    FETCHED="$STAGE/$APP_NAME.app"
    # Files copied off another machine can carry quarantine; macOS would then refuse the ad-hoc app.
    xattr -cr "$FETCHED"
    codesign --verify --deep --strict "$FETCHED"
    STAMP="$(/usr/libexec/PlistBuddy -c 'Print :GOAT2Commit' "$FETCHED/Contents/Info.plist")"
    if [[ "$STAMP" != "$COMMIT" ]]; then
      echo "the app from $BUILD_HOST is stamped '$STAMP', expected $COMMIT (clean): not installing" >&2
      exit 1
    fi
    install_app "$FETCHED" "goat2 $COMMIT, built on $BUILD_HOST"
    exit 0
  fi
  prepare_devbuild "$INVOKED_REPO" "$SHA"
  REPO="$DEVBUILD"
  BRANCH="goat2"
elif [[ -n "$BUILD_SHA" ]]; then
  prepare_devbuild "$SOURCE_REPO" "$BUILD_SHA"
  SHA="$BUILD_SHA"
  REPO="$DEVBUILD"
  BRANCH="goat2"
else
  REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  BRANCH="$(git -C "$REPO" rev-parse --abbrev-ref HEAD)"
  SHA="$(git -C "$REPO" rev-parse HEAD)"
fi
cd "$REPO"
# Builds share the machine with interactive work and other lanes.
renice -n 10 -p $$ >/dev/null

# 12 characters: v1 DesktopAppIdentity COMMIT_HASH_DISPLAY_LENGTH. Derived from the SHA read above.
COMMIT="${SHA:0:12}"
DIRTY=false
# Untracked files count too: cargo uses an untracked Cargo.lock, vite and tsc read untracked sources.
[[ -n "$(git status --porcelain)" ]] && DIRTY=true
DIRTY_MARK=""
[[ $DIRTY == true ]] && DIRTY_MARK="+dirty"
BUILD_NUMBER="$(git rev-list --count HEAD)"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "==> $APP_NAME from $BRANCH $COMMIT$DIRTY_MARK"

echo "==> pnpm install"
pnpm install --frozen-lockfile
ELECTRON_PKG="$(cd apps/desktop && node -p 'require("path").dirname(require.resolve("electron/package.json"))')"
if [[ ! -d "$ELECTRON_PKG/dist/Electron.app" ]]; then
  echo "==> fetching Electron (postinstall did not run)"
  (cd "$ELECTRON_PKG" && node install.js)
fi

echo "==> checks: pnpm -r typecheck"
if ! pnpm -r typecheck; then
  echo "typecheck failed on $BRANCH $COMMIT: not building $APP_NAME" >&2
  exit 1
fi
echo "==> checks: cargo test --workspace --locked"
if ! cargo test --workspace --locked; then
  echo "cargo test failed on $BRANCH $COMMIT: not building $APP_NAME" >&2
  exit 1
fi

echo "==> goat2-host (cargo build --release)"
cargo build --release --locked -p goat2-host
HOST_BIN="$REPO/target/release/goat2-host"

echo "==> apps/web (vite build)"
pnpm --filter @goat2/web build
echo "==> apps/desktop (tsc)"
rm -rf apps/desktop/dist
pnpm --filter @goat2/desktop build

OUT="$REPO/build/goat2-dev"
APP="$OUT/$APP_NAME.app"
echo "==> assembling $APP"
rm -rf "$OUT"
mkdir -p "$OUT"
ditto "$ELECTRON_PKG/dist/Electron.app" "$APP"
plist() { /usr/libexec/PlistBuddy -c "$1" "$2"; }
# Set a top-level string key, adding it when missing (Electron's helper plists omit some). plutil
# takes the value as one argument, so quotes and apostrophes in it are safe (PlistBuddy's command
# parser is not, and it exits 0 on a parse error).
plist_set() { plutil -replace "$1" -string "$2" "$3"; }

# Main executable and helpers carry the app name: Electron looks for "<executable> Helper*.app".
mv "$APP/Contents/MacOS/Electron" "$APP/Contents/MacOS/$APP_NAME"
INFO="$APP/Contents/Info.plist"
plist "Set :CFBundleExecutable $APP_NAME" "$INFO"
plist "Set :CFBundleIdentifier $BUNDLE_ID" "$INFO"
plist "Set :CFBundleName $APP_NAME" "$INFO"
plist "Set :CFBundleDisplayName $APP_NAME" "$INFO"
plist "Set :CFBundleShortVersionString 0.0.$BUILD_NUMBER" "$INFO"
plist "Set :CFBundleVersion $BUILD_NUMBER" "$INFO"
plist "Delete :ElectronAsarIntegrity" "$INFO" 2>/dev/null || true
plist "Add :GOAT2Commit string $COMMIT$DIRTY_MARK" "$INFO"
plist "Add :GOAT2Branch string $BRANCH" "$INFO"
# Info.plist keys lifted from v1 scripts/build-desktop-artifact.ts (mac.extendInfo, mac.protocols)
# and scripts/lib/mac-command-usage-descriptions.ts, with "GOAT" read as this app. Left out: the
# web-browser document types and http/https handlers (no in-app browser in GOAT 2 yet) and the
# screen-capture prompt (no window capture shortcut).
# macOS 26 offers Messages/Mail codes in every text field unless opted out.
plist "Add :NSAutoFillRequiresTextContentTypeForOneTimeCodeOnMac bool true" "$INFO"
plist_set NSLocalNetworkUsageDescription "GOAT 2 connects to devices on your local network for remote environments and commands run by terminals and coding agents." "$INFO"
plist_set NSCalendarsUsageDescription "Commands you run in GOAT 2 may need access to your calendars." "$INFO"
plist_set NSCalendarsFullAccessUsageDescription "Commands you run in GOAT 2 may need to read and write your calendar events." "$INFO"
plist_set NSCalendarsWriteOnlyAccessUsageDescription "Commands you run in GOAT 2 may need to add events to your calendars." "$INFO"
plist_set NSMicrophoneUsageDescription "GOAT 2 uses this Mac's microphone for commands run by terminals and coding agents. After you allow access, those commands can record without asking again." "$INFO"
# Links to the app's own origin (goat2-dev://app/...) open in GOAT 2 (Dev) (apps/desktop/src/main.ts).
plist "Delete :CFBundleURLTypes" "$INFO" 2>/dev/null || true
plist "Add :CFBundleURLTypes array" "$INFO"
plist "Add :CFBundleURLTypes:0 dict" "$INFO"
plist "Add :CFBundleURLTypes:0:CFBundleURLName string $APP_NAME" "$INFO"
plist "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$INFO"
plist "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string goat2-dev" "$INFO"
for helper in "$APP/Contents/Frameworks/Electron Helper"*.app; do
  suffix="$(basename "$helper" .app)"
  suffix="${suffix#Electron Helper}"            # "", " (GPU)", " (Plugin)", " (Renderer)"
  name="$APP_NAME Helper$suffix"
  mv "$helper/Contents/MacOS/Electron Helper$suffix" "$helper/Contents/MacOS/$name"
  hinfo="$helper/Contents/Info.plist"
  plist_set CFBundleExecutable "$name" "$hinfo"
  plist_set CFBundleName "$name" "$hinfo"
  id_suffix=""
  [[ -n "$suffix" ]] && id_suffix=".$(echo "$suffix" | tr -d ' ()' | tr '[:upper:]' '[:lower:]')"
  plist_set CFBundleIdentifier "$BUNDLE_ID.helper$id_suffix" "$hinfo"
  plist "Delete :CFBundleDisplayName" "$hinfo" 2>/dev/null || true
  mv "$helper" "$APP/Contents/Frameworks/$name.app"
done

RES="$APP/Contents/Resources"
rm -f "$RES/default_app.asar"
mkdir -p "$RES/app" "$RES/bin"
cp -R apps/desktop/dist "$RES/app/dist"
cp -R apps/web/dist "$RES/app/web"
cat > "$RES/app/package.json" <<EOF
{ "name": "goat2-dev", "productName": "$APP_NAME", "version": "0.0.$BUILD_NUMBER", "type": "module", "main": "dist/main.js" }
EOF
cat > "$RES/app/build-info.json" <<EOF
{ "commit": "$COMMIT", "branch": "$BRANCH", "dirty": $DIRTY, "builtAt": "$BUILT_AT" }
EOF
cp "$HOST_BIN" "$RES/bin/goat2-host"

echo "==> ad-hoc signing (@electron/osx-sign, v1 entitlements)"
node apps/desktop/scripts/sign-macos-ad-hoc.ts "$APP"
codesign --verify --deep --strict "$APP"

if [[ $INSTALL == 0 ]]; then
  echo "built: $APP"
  exit 0
fi

install_app "$APP" "$BRANCH $COMMIT$DIRTY_MARK"
