#!/bin/sh
# install.sh check against the relay stand-in serving build.sh output: install + up on one home,
# install --join on another, then a corrupted SHA256SUMS must stop the install.
#   apps/pen/scripts/installcheck.sh   (runs build.sh into a scratch copy of public/)
set -eu

GO="${GO:-go}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d /tmp/peni.XXXXXX)"
relay_pid=""
cleanup() {
	for n in a b; do
		[ -x "$work/$n/.local/bin/pen" ] && HOME="$work/$n" PEN_HOME="$work/$n/.pen" "$work/$n/.local/bin/pen" down >/dev/null 2>&1 || true
	done
	if [ -n "$relay_pid" ]; then
		kill "$relay_pid" 2>/dev/null || true
		wait "$relay_pid" 2>/dev/null || true
	fi
	rm -rf "$work"
}
trap cleanup EXIT

(cd "$here" && "$GO" build -o "$work/relaytest" ./internal/relaytest/cmd/relaytest)
port="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
relay="http://127.0.0.1:$port"
repo="$(cd "$here/../.." && pwd)"
GO="$GO" "$here/scripts/build.sh" 0.0.0-check "$relay" >/dev/null
mkdir -p "$work/public/dl"
cp -R "$repo/infra/pen-relay/public/dl/0.0.0-check" "$work/public/dl/"
cp "$repo/infra/pen-relay/public/install.sh" "$work/public/install.sh"
rm -rf "$repo/infra/pen-relay/public/dl/0.0.0-check"

mkfifo "$work/relay.out"
"$work/relaytest" -addr "127.0.0.1:$port" -public "$work/public" >"$work/relay.out" &
relay_pid=$!
read -r _ _ <"$work/relay.out"

inst() {
	n="$1"
	shift
	mkdir -p "$work/$n"
	curl -fsSL "$relay/install.sh" | HOME="$work/$n" PEN_HOME="$work/$n/.pen" PEN_HOSTKEYS=none PEN_SSH_DIR="$work/$n/ssh" sh -s -- --no-service "$@"
}
pen() {
	n="$1"
	shift
	HOME="$work/$n" PEN_HOME="$work/$n/.pen" "$work/$n/.local/bin/pen" "$@"
}

inst a --name a
pen a version
inst b --name b --join "$(pen a invite --auto)"
members="$(pen a ls --json | grep -c '"fingerprint"')"
[ "$members" = 2 ] || { echo "FAIL: a lists $members members"; exit 1; }
echo "ok: install.sh installed and started a; install.sh --join added b (a lists 2)"

printf '0000000000000000000000000000000000000000000000000000000000000000  pen-darwin-arm64.gz\n0000000000000000000000000000000000000000000000000000000000000000  pen-darwin-amd64.gz\n0000000000000000000000000000000000000000000000000000000000000000  pen-linux-arm64.gz\n0000000000000000000000000000000000000000000000000000000000000000  pen-linux-amd64.gz\n' >"$work/public/dl/0.0.0-check/SHA256SUMS"
if inst c --name c 2>"$work/c.err"; then
	echo "FAIL: install.sh accepted a bad checksum"
	exit 1
fi
grep -q "checksum mismatch" "$work/c.err"
[ ! -e "$work/c/.local/bin/pen" ] || { echo "FAIL: a binary was installed despite the mismatch"; exit 1; }
echo "ok: a corrupted SHA256SUMS stops install.sh before anything is installed"

