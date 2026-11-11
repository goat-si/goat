#!/bin/sh
# Login check: a fake login service (internal/logintest/cmd/logintest, approving every code as one
# Google account), two local "pen relay serve --plain" relays and three nodes. A's pen login founds
# and binds a mesh; B's pen login --yes joins it automatically (the time from the token answer to
# "member" is printed); pen lock on, then C's pen login is queued on the member that answered first,
# approved there with C's full fingerprint, and admitted; every ls lists 3 and a pipe from C reaches
# an echo port on A.
#   apps/pen/scripts/loginnode.sh
set -eu

GO="${GO:-go}"
here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d /tmp/penl.XXXXXX)"
login_pid=""
r1_pid=""
r2_pid=""
echo_pid=""
c_pid=""
cleanup() {
	for n in a b c; do
		[ -d "$work/$n" ] && PEN_HOME="$work/$n" "$work/pen" down >/dev/null 2>&1 || true
	done
	for pid in $c_pid $echo_pid $login_pid $r1_pid $r2_pid; do
		kill "$pid" 2>/dev/null || true
		wait "$pid" 2>/dev/null || true
	done
	rm -rf "$work"
}
trap cleanup EXIT

(cd "$here" && "$GO" build -o "$work/pen" . && "$GO" build -o "$work/logintest" ./internal/logintest/cmd/logintest)

mkfifo "$work/login.out" "$work/r1.out" "$work/r2.out"
"$work/logintest" --approve "1001,me@example.com" >"$work/login.out" &
login_pid=$!
read -r _ login_url <"$work/login.out"
"$work/pen" relay serve --plain --listen 127.0.0.1:0 >"$work/r1.out" &
r1_pid=$!
read -r _ _ _ _ addr1 _ <"$work/r1.out"
"$work/pen" relay serve --plain --listen 127.0.0.1:0 >"$work/r2.out" &
r2_pid=$!
read -r _ _ _ _ addr2 _ <"$work/r2.out"
echo "login service $login_url (pid $login_pid); relays http://$addr1 and http://$addr2"

pen() {
	n="$1"
	shift
	PEN_HOME="$work/$n" PEN_SERVICE=none PEN_HOSTKEYS=none PEN_SSH_DIR="$work/$n/ssh" "$work/pen" "$@"
}
login() {
	n="$1"
	shift
	pen "$n" login --login-url "$login_url" --relay "http://$addr1" --relay "http://$addr2" --name "$n" --yes "$@"
}

login a >"$work/a.log"
grep -q "is bound to me@example.com" "$work/a.log" || { cat "$work/a.log"; echo "FAIL: a did not bind"; exit 1; }
echo "ok: a founded a mesh and bound it to me@example.com"

login b >"$work/b.log"
line="$(grep "member of mesh" "$work/b.log")" || { cat "$work/b.log"; echo "FAIL: b did not join"; exit 1; }
echo "ok: b joined automatically: $line"

pen a lock on >/dev/null
echo "ok: lock on"

mkfifo "$work/c.out"
login c >"$work/c.out" 2>&1 &
c_pid=$!
exec 4<"$work/c.out"
fp=""
on=""
while read -r line <&4; do
	case "$line" in
	*"is queued on "*) on="${line##* }" ;;
	*"machine's fingerprint: "*) fp="${line#*fingerprint: }"; break ;;
	*"member of mesh"*) echo "FAIL: c joined a locked mesh without approval"; exit 1 ;;
	esac
done
[ -n "$fp" ] && [ -n "$on" ] || { echo "FAIL: c was not queued"; exit 1; }
cat <&4 >"$work/c.rest" &
echo "ok: c queued on $on with fingerprint $fp"
pen "$on" approve "$fp" >/dev/null
wait "$c_pid"
c_pid=""
exec 4<&-
grep -q "member of mesh" "$work/c.rest" || { cat "$work/c.rest"; echo "FAIL: c not admitted after approval"; exit 1; }
echo "ok: c admitted after pen approve on $on: $(grep 'member of mesh' "$work/c.rest")"

for n in a b c; do
	got="$(pen "$n" ls --json | grep -c '"fingerprint"')"
	if [ "$got" != 3 ]; then
		echo "FAIL: $n lists $got members"
		pen "$n" ls
		exit 1
	fi
done
echo "ok: a, b and c each list 3 members"
pen a ls | grep "joined via Google"

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
head -c 1048576 /dev/urandom >"$work/in"
pen c pipe pen-a "$port" <"$work/in" >"$work/out"
cmp "$work/in" "$work/out"
echo "ok: 1 MiB through pen pipe c -> a:$port matches"
