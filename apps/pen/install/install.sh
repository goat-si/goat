#!/bin/sh
# pen installer: downloads the pen binary for this machine from the relay and verifies it.
#   curl -fsSL <relay>/install.sh | sh                        (install only; prints what to run next)
#   curl -fsSL <relay>/install.sh | sh -s -- --join <token>   (then join the mesh the token invites to)
#   curl -fsSL <relay>/install.sh | sh -s -- --login          (then sign in with Google; add --yes for scripts)
#   curl -fsSL <relay>/install.sh | sh -s -- --up             (then start a new mesh on this machine)
# --name N names this machine for --join, --login or --up. The node uses every relay in PEN_RELAYS; one or more
# --relay URL replace that list. pen downloads from PEN_RELAY, which invites name in their install line.
set -eu

PEN_RELAY="${PEN_RELAY:-__PEN_RELAY__}"
PEN_RELAYS="${PEN_RELAYS:-__PEN_RELAYS__}"
VERSION="${PEN_VERSION:-__PEN_VERSION__}"
JOIN=""
LOGIN=""
UP=""
NAME=""
NO_SERVICE=""
YES=""
RELAYS=""

while [ $# -gt 0 ]; do
	case "$1" in
	--join) JOIN="$2"; shift 2 ;;
	--login) LOGIN=1; shift ;;
	--name) NAME="$2"; shift 2 ;;
	--no-service) NO_SERVICE="--no-service"; shift ;;
	--relay) RELAYS="$RELAYS $2"; shift 2 ;;
	--up) UP=1; shift ;;
	--yes) YES="--yes"; shift ;;
	*) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
	esac
done
if [ -n "$RELAYS" ]; then
	PEN_RELAYS="$RELAYS"
fi
# The relay lists split on spaces below and where $relay_flags expands; never as file globs.
set -f
relay_flags=""
for r in $PEN_RELAYS; do
	relay_flags="$relay_flags --relay $r"
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
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pen-install.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$PEN_RELAY/dl/$VERSION/$file" -o "$tmp/$file"
curl -fsSL "$PEN_RELAY/dl/$VERSION/SHA256SUMS" -o "$tmp/SHA256SUMS"
# The one line ending in " <archive>", compared as text (check-public.ts reads it the same way).
want="$(awk -v s=" $file" 'length($0) > length(s) && substr($0, length($0) - length(s) + 1) == s { n++; w = $0; sub(/ .*/, "", w) } END { if (n == 1) print w }' "$tmp/SHA256SUMS")"
got="$(sha "$tmp/$file")"
if [ -z "$want" ] || [ "$want" != "$got" ]; then
	echo "install.sh: checksum mismatch for $file" >&2
	exit 1
fi

mkdir -p "$HOME/.local/bin"
gunzip -c "$tmp/$file" >"$tmp/pen"
chmod 0755 "$tmp/pen"
mv "$tmp/pen" "$HOME/.local/bin/pen"
# The steps below may exec pen, which skips the EXIT trap, so the download goes now.
rm -rf "$tmp"
trap - EXIT
echo "installed $HOME/.local/bin/pen ($VERSION)"
pen="pen"
case ":$PATH:" in
*":$HOME/.local/bin:"*) ;;
*)
	pen="$HOME/.local/bin/pen"
	# zsh reads .zshenv (in ZDOTDIR when set) in every shell; bash reads the first of its three login
	# profiles in a login shell and ~/.bashrc in other interactive ones (a desktop terminal); fish reads
	# none of these. Positional parameters keep paths with spaces whole under set -f.
	case "${SHELL:-}" in
	*/zsh) set -- "${ZDOTDIR:-$HOME}/.zshenv" ;;
	*/fish) set -- ;;
	*/bash)
		login="$HOME/.profile"
		for p in "$HOME/.bash_profile" "$HOME/.bash_login"; do
			if [ -f "$p" ]; then
				login="$p"
				break
			fi
		done
		set -- "$login" "$HOME/.bashrc"
		;;
	*) set -- "$HOME/.profile" ;;
	esac
	# The line checks PATH first, so a shell that reads two of these files lists the folder once.
	line='case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) export PATH="$HOME/.local/bin:$PATH" ;; esac'
	mark="# added by pen install.sh (PEN_NO_MODIFY_PATH=1 skips this)"
	if [ "${PEN_NO_MODIFY_PATH:-}" = 1 ]; then
		echo "add $HOME/.local/bin to your PATH to run pen directly"
	elif [ $# = 0 ]; then
		echo "add $HOME/.local/bin to your PATH to run pen directly (fish: fish_add_path $HOME/.local/bin)"
	else
		for profile in "$@"; do
			if grep -qF "$mark" "$profile" 2>/dev/null || printf '\n%s %s\n' "$line" "$mark" >>"$profile" 2>/dev/null; then
				echo "added $HOME/.local/bin to your PATH in $profile (new terminals see it)"
			else
				echo "could not write $profile: add $HOME/.local/bin to your PATH to run pen directly"
			fi
		done
	fi
	;;
esac
"$HOME/.local/bin/pen" relay download "$PEN_RELAY" >/dev/null

if [ -n "$JOIN" ]; then
	if [ -n "$NAME" ]; then
		exec "$HOME/.local/bin/pen" join "$JOIN" --name "$NAME" $NO_SERVICE
	fi
	exec "$HOME/.local/bin/pen" join "$JOIN" $NO_SERVICE
fi
if [ -n "$LOGIN" ]; then
	set -- login $relay_flags $NO_SERVICE $YES
	if [ -n "$NAME" ]; then
		set -- "$@" --name "$NAME"
	fi
	# pen login asks before it founds or joins; under curl | sh stdin is this script, so ask the terminal.
	if (exec </dev/tty) 2>/dev/null; then
		exec "$HOME/.local/bin/pen" "$@" </dev/tty
	fi
	exec "$HOME/.local/bin/pen" "$@"
fi
if [ -n "$UP" ]; then
	if [ -n "$NAME" ]; then
		exec "$HOME/.local/bin/pen" up $relay_flags --name "$NAME" $NO_SERVICE
	fi
	exec "$HOME/.local/bin/pen" up $relay_flags $NO_SERVICE
fi
echo "Next: $pen login$relay_flags (sign in with Google), $pen join <token> (an invite), or $pen up$relay_flags (start a new mesh on this machine)."

