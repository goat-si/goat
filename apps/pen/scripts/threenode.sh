#!/bin/sh
# Three-node check: A founds, B joins A, C joins via B's invite; every ls lists 3; a pipe from B to an
# echo port on A returns the same bytes, and both ends count them; pen revoke c on A must reach a watch on B within 2 s.
# Without PEN_RELAY it runs two local "pen relay serve --plain" relays, stops the first one by its
# PID after the first pipe, and repeats the pipe and the revoke through the second.
#   apps/pen/scripts/threenode.sh
#   PEN_RELAY=https://<relay> apps/pen/scripts/threenode.sh   # one deployed or wrangler dev relay
set -eu

GO="${GO:-go}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d /tmp/pen3.XXXXXX)"
r1_pid=""
r2_pid=""
echo_pid=""
cleanup() {
	for n in a b c; do
		[ -d "$work/$n" ] && PEN_HOME="$work/$n" "$work/pen" down >/dev/null 2>&1 || true
	done
	for pid in $echo_pid $r1_pid $r2_pid; do
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	done
	rm -rf "$work"
}
trap cleanup EXIT

now_ms() { perl -MTime::HiRes=time -e 'printf "%d\n", time * 1000'; }

(cd "$here" && "$GO" build -o "$work/pen" .)

if [ -n "${PEN_RELAY:-}" ]; then
	set -- --relay "$PEN_RELAY"
	echo "relay $PEN_RELAY"
else
	mkfifo "$work/r1.out" "$work/r2.out"
	"$work/pen" relay serve --plain --listen 127.0.0.1:0 >"$work/r1.out" &
	r1_pid=$!
	read -r _ _ _ _ addr1 _ <"$work/r1.out"
	"$work/pen" relay serve --plain --listen 127.0.0.1:0 >"$work/r2.out" &
	r2_pid=$!
	read -r _ _ _ _ addr2 _ <"$work/r2.out"
	set -- --relay "http://$addr1" --relay "http://$addr2"
	echo "relays http://$addr1 (pid $r1_pid) and http://$addr2 (pid $r2_pid)"
fi

pen() {
	n="$1"
	shift
	PEN_HOME="$work/$n" PEN_SERVICE=none PEN_HOSTKEYS=none PEN_SSH_DIR="$work/$n/ssh" "$work/pen" "$@"
}

pen a up "$@" --name a >/dev/null
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
import socket
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

pipe_check() {
	head -c 1048576 /dev/urandom >"$work/in"
	began="$(now_ms)"
	pen b pipe pen-a "$port" <"$work/in" >"$work/out"
	took=$(($(now_ms) - began))
	cmp "$work/in" "$work/out"
	echo "ok: 1 MiB through pen pipe b -> a:$port matches ($took ms$1)"
}
pipe_check ""

# The echo pipe moved 1 MiB each way: b's pipe reported it, and a counted the session it accepted.
traffic_of() {
	pen "$1" ls --json | python3 -c '
import json, sys
t = [m.get("traffic24h") or {} for m in json.load(sys.stdin)["members"] if m["name"] == sys.argv[1]][0]
print(t.get("in", 0), t.get("out", 0))
' "$2"
}
for pair in "b a" "a b"; do
	from="${pair% *}"
	to="${pair#* }"
	got="$(traffic_of "$from" "$to")"
	if [ "$got" != "1048576 1048576" ]; then
		echo "FAIL: $from counts in/out $got for $to, want 1048576 1048576"
		exit 1
	fi
done
echo "ok: pen ls on b and on a count 1 MiB each way for the pipe"

if [ -n "$r1_pid" ]; then
	kill "$r1_pid"
	wait "$r1_pid" 2>/dev/null || true
	r1_pid=""
	echo "stopped relay 1"
	pipe_check ", relay 1 down"
fi

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

