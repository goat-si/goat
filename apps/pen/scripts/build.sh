#!/bin/sh
# Builds pen for every release target into infra/pen-relay/public/dl/<version>/ with SHA256SUMS and
# NOTICE, and writes infra/pen-relay/public/install.sh with the relays and version filled in.
# PEN_PUBLIC names another output folder (installcheck.sh builds into its scratch folder).
#   apps/pen/scripts/build.sh <version> <download relay URL> [extra relay URL]...
# install.sh downloads from the first relay and gives installed nodes all of them.
set -eu

usage="usage: build.sh <version> <download relay URL> [extra relay URL]..."
V="${1:?$usage}"
RELAY="${2:-${PEN_RELAY:?$usage}}"
shift
if [ $# -gt 0 ]; then
	shift
fi
RELAYS="$RELAY"
for r in "$@"; do
	RELAYS="$RELAYS $r"
done
GO="${GO:-go}"
here="$(cd "$(dirname "$0")/.." && pwd)"
repo="$(cd "$here/../.." && pwd)"
public="${PEN_PUBLIC:-$repo/infra/pen-relay/public}"
out="$public/dl/$V"
mkdir -p "$out"

cd "$here"
for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
	os="${target%/*}"
	arch="${target#*/}"
	bin="$out/pen-$os-$arch"
	CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" "$GO" build -trimpath -ldflags "-s -w -X main.version=$V" -o "$bin" .
	gzip -9 -n -f "$bin"
done

cd "$out"
if command -v sha256sum >/dev/null 2>&1; then
	sha256sum pen-*.gz >SHA256SUMS
else
	shasum -a 256 pen-*.gz >SHA256SUMS
fi

modcache="$(cd "$here" && "$GO" env GOMODCACHE)"
{
	echo "pen $V, part of GOAT (https://github.com/goat-si/goat)."
	echo "pen implements the Pen transport contract, derived from the Doriterm transport contract v1.10"
	echo "(sisyphuslabs/doriterm, AGPL-3.0), adapted with its author's permission."
	echo
	echo "================================================================"
	echo "pen (GOAT)"
	echo "================================================================"
	cat "$repo/LICENSE"
	echo
	mods="$(for target in linux/amd64 linux/arm64 darwin/arm64 darwin/amd64; do
		(cd "$here" && GOOS="${target%/*}" GOARCH="${target#*/}" "$GO" list -deps -f '{{with .Module}}{{if not .Main}}{{.Path}}@{{.Version}}{{end}}{{end}}' .)
	done | sort -u)"
	for mod in $mods; do
		dir="$modcache/$(echo "$mod" | sed 's/[A-Z]/!&/g' | tr 'A-Z' 'a-z')"
		lic="$(ls "$dir"/LICENSE* 2>/dev/null | head -n 1)"
		if [ -z "$lic" ]; then
			echo "build.sh: no license file for $mod in $dir" >&2
			exit 1
		fi
		echo "================================================================"
		echo "$mod"
		echo "================================================================"
		cat "$lic"
		echo
	done
} >NOTICE

sed -e "s|__PEN_RELAYS__|$RELAYS|" -e "s|__PEN_RELAY__|$RELAY|" -e "s|__PEN_VERSION__|$V|" "$here/install/install.sh" >"$public/install.sh"
chmod 0755 "$public/install.sh"

for f in pen-*.gz; do
	bytes="$(wc -c <"$f" | tr -d ' ')"
	echo "$f $bytes bytes ($((bytes / 1024)) KiB)"
	if [ "$bytes" -ge $((25 * 1024 * 1024)) ]; then
		echo "build.sh: $f is over 25 MiB" >&2
		exit 1
	fi
done

