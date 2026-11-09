#!/bin/sh
# Three-node check: A founds, B joins A, C joins via B's invite; every ls lists 3; a pipe from B to an
# echo port on A returns the same bytes; pen revoke c on A must reach a watch on B within 2 s.
#   apps/pen/scripts/threenode.sh                 # against the in-process relay stand-in
#   PEN_RELAY=https://<relay> apps/pen/scripts/threenode.sh   # against a deployed or wrangler dev relay
set -eu

GO="${GO:-go}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d /tmp/pen3.XXXXXX)"
relay_pid=""
echo_pid=""
cleanup() {
	for n in a b c; do
		[ -d "$work/$n" ] && PEN_HOME="$work/$n" "$work/pen" down >/dev/null 2>&1 || true
	done
	for pid in $echo_pid $relay_pid; do
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	done
	rm -rf "$work"
}
trap cleanup EXIT

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

(cd "$here" && "$GO" build -o "$work/pen" . && "$GO" build -o "$work/relaytest" ./internal/relaytest/cmd/relaytest)

if [ -z "${PEN_RELAY:-}" ]; then
	mkfifo "$work/relay.out"
	"$work/relaytest" >"$work/relay.out" &
	relay_pid=$!
	read -r _ PEN_RELAY <"$work/relay.out"
fi
echo "relay $PEN_RELAY"

pen() {
	n="$1"
	shift
	PEN_HOME="$work/$n" PEN_SERVICE=none PEN_HOSTKEYS=none PEN_SSH_DIR="$work/$n/ssh" "$work/pen" "$@"
}

pen a up --relay "$PEN_RELAY" --name a >/dev/null
pen b join "$(pen a invite --auto)" --name b >/dev/null
pen c join "$(pen b invite --auto)" --name c >/dev/null

for n in a b c; do
	got="$(pen "$n" ls --json | grep -c '"fingerprint"')"
	if [ "$got" != 3 ]; then
		echo "FAIL: $n lists $got members"
		pen "$n" ls
		exit 1
	fi
done
echo "ok: a, b and c each list 3 members"

mkfifo "$work/echo.out"
python3 -c '
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(4)
print(s.getsockname()[1], flush=True)
while True:
    c, _ = s.accept()
    while True:
        b = c.recv(65536)
        if not b: break
        c.sendall(b)
    c.shutdown(socket.SHUT_WR); c.close()
' >"$work/echo.out" &
echo_pid=$!
read -r port <"$work/echo.out"
head -c 1048576 /dev/urandom >"$work/in"
began="$(now_ms)"
pen b pipe pen-a "$port" <"$work/in" >"$work/out"
took=$(($(now_ms) - began))
cmp "$work/in" "$work/out"
echo "ok: 1 MiB through pen pipe b -> a:$port matches ($took ms)"

mkfifo "$work/watch.out"
pen b ls --watch --until-revoked c >"$work/watch.out" &
watch_pid=$!
exec 3<"$work/watch.out"
read -r _ <&3
began="$(now_ms)"
pen a revoke c >/dev/null
wait "$watch_pid"
took=$(($(now_ms) - began))
exec 3<&-
echo "revoke c on a reached b's watch in $took ms"
if [ "$took" -ge 2000 ]; then
	echo "FAIL: detach took $took ms (limit 2000)"
	exit 1
fi
echo "ok: detach under 2 s"

