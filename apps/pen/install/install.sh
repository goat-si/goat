#!/bin/sh
# pen installer: downloads the pen binary for this machine from the relay, verifies it and starts it.
#   curl -fsSL <relay>/install.sh | sh
#   curl -fsSL <relay>/install.sh | sh -s -- --join <token>
set -eu

PEN_RELAY="${PEN_RELAY:-__PEN_RELAY__}"
VERSION="${PEN_VERSION:-__PEN_VERSION__}"
JOIN=""
NAME=""
NO_SERVICE=""

while [ $# -gt 0 ]; do
	case "$1" in
	--join) JOIN="$2"; shift 2 ;;
	--name) NAME="$2"; shift 2 ;;
	--no-service) NO_SERVICE="--no-service"; shift ;;
	--relay) PEN_RELAY="$2"; shift 2 ;;
	*) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
	esac
done

case "$(uname -s)" in
Linux) os=linux ;;
Darwin) os=darwin ;;
*) echo "install.sh: unsupported OS $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) echo "install.sh: unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

if command -v sha256sum >/dev/null 2>&1; then
	sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	echo "install.sh: need sha256sum or shasum" >&2
	exit 1
fi

file="pen-$os-$arch.gz"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$PEN_RELAY/dl/$VERSION/$file" -o "$tmp/$file"
curl -fsSL "$PEN_RELAY/dl/$VERSION/SHA256SUMS" -o "$tmp/SHA256SUMS"
want="$(grep " $file\$" "$tmp/SHA256SUMS" | cut -d' ' -f1)"
got="$(sha "$tmp/$file")"
if [ -z "$want" ] || [ "$want" != "$got" ]; then
	echo "install.sh: checksum mismatch for $file" >&2
	exit 1
fi

mkdir -p "$HOME/.local/bin"
gunzip -c "$tmp/$file" >"$tmp/pen"
chmod 0755 "$tmp/pen"
mv "$tmp/pen" "$HOME/.local/bin/pen"
echo "installed $HOME/.local/bin/pen ($VERSION)"
case ":$PATH:" in
*":$HOME/.local/bin:"*) ;;
*) echo "add $HOME/.local/bin to your PATH to run pen directly" ;;
esac

if [ -n "$JOIN" ]; then
	if [ -n "$NAME" ]; then
		exec "$HOME/.local/bin/pen" join "$JOIN" --name "$NAME" $NO_SERVICE
	fi
	exec "$HOME/.local/bin/pen" join "$JOIN" $NO_SERVICE
fi
if [ -n "$NAME" ]; then
	exec "$HOME/.local/bin/pen" up --relay "$PEN_RELAY" --name "$NAME" $NO_SERVICE
fi
exec "$HOME/.local/bin/pen" up --relay "$PEN_RELAY" $NO_SERVICE

