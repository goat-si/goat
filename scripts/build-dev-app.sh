#!/usr/bin/env bash
# Builds GOAT 2 (Dev) from this checkout and installs it to /Applications.
#   goat2-host (cargo --release, kache via ~/.cargo/config.toml) + apps/web (vite) + apps/desktop (tsc)
#   -> Electron.app renamed to "GOAT 2 (Dev).app", bundle id si.goat.goat2.dev, ad-hoc signed.
# Identity (structure/10_processes.md): data ~/.goat2-dev, host port 3873, nothing shared with GOAT v1.
#
# Usage: scripts/build-dev-app.sh [--no-install] [--no-open] [--any-branch]
#   --no-install  build into build/goat2-dev/ only
#   --no-open     do not relaunch the app after installing (it is relaunched only if it was running)
#   --any-branch  allow installing from a branch other than goat2 (lane testing only)
# Run it from ~/Developer/goat2 after each merge into goat2 (docs/lanes/PART1.md).
set -euo pipefail

APP_NAME="GOAT 2 (Dev)"
BUNDLE_ID="si.goat.goat2.dev"
INSTALL_DIR="/Applications"
INSTALL=1
OPEN=1
ANY_BRANCH=0
for arg in "$@"; do
  case "$arg" in
    --no-install) INSTALL=0 ;;
    --no-open) OPEN=0 ;;
    --any-branch) ANY_BRANCH=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "GOAT 2 (Dev) packaging is macOS only" >&2; exit 1; }
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

COMMIT="$(git rev-parse --short=11 HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [[ "$BRANCH" != "goat2" && $INSTALL == 1 && $ANY_BRANCH == 0 ]]; then
  echo "the installed Dev app is built from goat2 (this checkout is on $BRANCH)." >&2
  echo "run it in ~/Developer/goat2, or pass --no-install / --any-branch" >&2
  exit 1
fi
DIRTY=false
git diff --quiet HEAD -- || DIRTY=true
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

echo "==> goat2-host (cargo build --release)"
cargo build --release -p goat2-host
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
# Set a string key, adding it when the plist does not have it (Electron's helper plists omit some).
plist_set() { plist "Set :$1 $2" "$3" 2>/dev/null || plist "Add :$1 string $2" "$3"; }

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

echo "==> ad-hoc signing"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"

if [[ $INSTALL == 0 ]]; then
  echo "built: $APP"
  exit 0
fi

TARGET="$INSTALL_DIR/$APP_NAME.app"
# pgrep -f takes a regex; escape the parentheses and dots in the app path.
TARGET_RE="$(printf '%s' "$TARGET/Contents/MacOS/" | sed 's/[][\.*^$()+?{}|]/\\&/g')"
WAS_RUNNING=0
if pgrep -f "$TARGET_RE" >/dev/null; then
  WAS_RUNNING=1
  echo "==> quitting the running $APP_NAME (quitting ends its work)"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" || true
  for _ in $(seq 1 100); do pgrep -f "$TARGET_RE" >/dev/null || break; sleep 0.2; done
  if pgrep -f "$TARGET_RE" >/dev/null; then
    echo "$APP_NAME did not quit within 20 s; quit it and run again" >&2
    exit 1
  fi
fi
if [[ -e "$TARGET" ]]; then
  existing="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$TARGET/Contents/Info.plist" 2>/dev/null || true)"
  if [[ "$existing" != "$BUNDLE_ID" ]]; then
    echo "$TARGET exists with bundle id '$existing'; not replacing it" >&2
    exit 1
  fi
  rm -rf "$TARGET"
fi
ditto "$APP" "$TARGET"
echo "installed: $TARGET ($BRANCH $COMMIT$DIRTY_MARK)"
if [[ $WAS_RUNNING == 1 && $OPEN == 1 ]]; then
  # GOAT threads export ELECTRON_RUN_AS_NODE=1; open passes it on and Electron would start as plain Node.
  env -u ELECTRON_RUN_AS_NODE open "$TARGET"
  echo "relaunched $APP_NAME"
fi
