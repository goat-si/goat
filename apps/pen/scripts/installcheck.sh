#!/bin/sh
# install.sh check against the relay stand-in serving build.sh output: a bare install only installs,
# install --up founds on one home with every relay build.sh listed, install --join joins another, then a corrupted
# SHA256SUMS must stop the install.
#   apps/pen/scripts/installcheck.sh   (runs build.sh into a scratch copy of public/)
set -eu

GO="${GO:-go}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d /tmp/peni.XXXXXX)"
relay_pid=""
relay2_pid=""
cleanup() {
	for n in z a b; do
		[ -x "$work/$n/.local/bin/pen" ] && HOME="$work/$n" PEN_HOME="$work/$n/.pen" "$work/$n/.local/bin/pen" down >/dev/null 2>&1 || true
	done
	for pid in $relay_pid $relay2_pid; do
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	done
	rm -rf "$work"
}
trap cleanup EXIT

(cd "$here" && "$GO" build -o "$work/relaytest" ./internal/relaytest/cmd/relaytest)
freeport() { python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])'; }
port="$(freeport)"
relay="http://127.0.0.1:$port"
port2="$(freeport)"
relay2="http://127.0.0.1:$port2"
# Build into the scratch folder: infra/pen-relay/public is what a deploy publishes.
mkdir -p "$work/public"
GO="$GO" PEN_PUBLIC="$work/public" "$here/scripts/build.sh" 0.0.0-check "$relay" "$relay2" >/dev/null

mkfifo "$work/relay.out"
"$work/relaytest" -addr "127.0.0.1:$port" -public "$work/public" >"$work/relay.out" &
relay_pid=$!
read -r _ _ <"$work/relay.out"
mkfifo "$work/relay2.out"
"$work/relaytest" -addr "127.0.0.1:$port2" >"$work/relay2.out" &
relay2_pid=$!
read -r _ _ <"$work/relay2.out"

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

inst z >"$work/z.out"
grep -q "Next: .*pen login" "$work/z.out" || { echo "FAIL: a bare install did not say what to run next:"; cat "$work/z.out"; exit 1; }
[ ! -e "$work/z/.pen/mesh.json" ] || { echo "FAIL: a bare install founded a mesh"; exit 1; }
[ ! -e "$work/z/.pen/control.sock" ] || { echo "FAIL: a bare install started a daemon"; exit 1; }
if pen z ls 2>"$work/z.err"; then
	echo "FAIL: pen ls answered after a bare install"
	exit 1
fi
grep -q "no mesh here yet; run pen login" "$work/z.err" || { echo "FAIL: pen ls after a bare install said:"; cat "$work/z.err"; exit 1; }
echo "ok: a bare install.sh installs pen and founds nothing"

inst a --name a --up
pen a version
relays="$(pen a relay ls)"
for r in "$relay" "$relay2"; do
	printf '%s\n' "$relays" | grep -q "^$r	" || { echo "FAIL: a's relays lack $r:"; printf '%s\n' "$relays"; exit 1; }
done
[ "$(pen a relay download)" = "$relay" ] || { echo "FAIL: a's download relay is $(pen a relay download), want $relay"; exit 1; }
echo "ok: install.sh --up gave a both relays and kept the download relay"
inst b --name b --join "$(pen a invite --auto)"
[ "$(pen b relay download)" = "$relay" ] || { echo "FAIL: b's download relay is $(pen b relay download), want $relay"; exit 1; }
members="$(pen a ls --json | grep -c '"fingerprint"')"
[ "$members" = 2 ] || { echo "FAIL: a lists $members members"; exit 1; }
echo "ok: install.sh installed and started a; install.sh --join added b (a lists 2)"

# A line whose name only matches as a pattern (pen-linux-amd64Xgz) is another archive's; check-public.ts ignores it,
# so install.sh must too.
sums="$work/public/dl/0.0.0-check/SHA256SUMS"
sed 's/\.gz$/Xgz/; s/^[0-9a-f]*/0000000000000000000000000000000000000000000000000000000000000000/' "$sums" >"$work/decoys"
cat "$work/decoys" >>"$sums"
inst d --name d 2>"$work/d.err" || { echo "FAIL: install.sh refused a SHA256SUMS whose extra lines name other files:"; cat "$work/d.err"; exit 1; }
[ -x "$work/d/.local/bin/pen" ] || { echo "FAIL: install.sh installed nothing"; exit 1; }
echo "ok: install.sh reads only the SHA256SUMS line that names its archive"

printf '0000000000000000000000000000000000000000000000000000000000000000  pen-darwin-arm64.gz\n0000000000000000000000000000000000000000000000000000000000000000  pen-darwin-amd64.gz\n0000000000000000000000000000000000000000000000000000000000000000  pen-linux-arm64.gz\n0000000000000000000000000000000000000000000000000000000000000000  pen-linux-amd64.gz\n' >"$work/public/dl/0.0.0-check/SHA256SUMS"
if inst c --name c 2>"$work/c.err"; then
	echo "FAIL: install.sh accepted a bad checksum"
	exit 1
fi
grep -q "checksum mismatch" "$work/c.err"
[ ! -e "$work/c/.local/bin/pen" ] || { echo "FAIL: a binary was installed despite the mismatch"; exit 1; }
echo "ok: a corrupted SHA256SUMS stops install.sh before anything is installed"

