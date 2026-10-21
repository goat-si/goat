import { shellSingleQuote as quote } from "../sshRemote/remoteBrowse.ts";

export const REVIEW_DIFF_MAX_BYTES = 100_000;
const MAX_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const END = "\nGOAT_REVIEW_DIFF_END\n";

const checkFiles = `set -eu
sizes=$1
shift
for file do
  if [ -L "$file" ] || [ ! -e "$file" ]; then continue; fi
  [ -f "$file" ] || exit 1
  size=$(wc -c < "$file")
  [ "$size" -le ${MAX_FILE_BYTES} ] || exit 1
  printf '%s\\n' "$size" >> "$sizes"
done`;

/** A private index adds untracked files without staging anything in the worker's index. */
export const reviewDiffScript = (cwd: string, baseRef: string) => `set -eu
umask 077
cd ${quote(cwd)}
export GIT_OPTIONAL_LOCKS=0
unset GIT_INDEX_FILE
base=$(git merge-base HEAD ${quote(baseRef)})
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' 0
trap 'exit 1' HUP INT TERM
refuse() { printf 'GOAT_REVIEW_DIFF_REFUSED\\n'; exit 0; }
git diff --name-only -z "$base" -- > "$tmp/paths"
git ls-files --others --exclude-standard -z >> "$tmp/paths"
[ "$(wc -c < "$tmp/paths")" -le 65536 ] || refuse
: > "$tmp/sizes"
xargs -0 sh -c ${quote(checkFiles)} sh "$tmp/sizes" < "$tmp/paths" || refuse
awk '{ total += $1 } END { exit(total > ${MAX_INPUT_BYTES}) }' "$tmp/sizes" || refuse
[ -z "$(git ls-files --unmerged)" ] || refuse
git diff --cached --numstat "$base" -- > "$tmp/staged-stats"
awk -F '\\t' '$1 == "-" { bad = 1 } END { exit(bad) }' "$tmp/staged-stats" || refuse
# Bound each diff's temporary output even for an oversized blob already in the source index.
(ulimit -f 256; git --no-pager diff --cached --no-ext-diff --no-textconv "$base" -- > "$tmp/staged") || refuse
export GIT_INDEX_FILE="$tmp/index"
git read-tree HEAD
git -c core.splitIndex=false add -A -- .
git diff --cached --numstat "$base" -- > "$tmp/stats"
awk -F '\\t' '$1 == "-" { bad = 1 } END { exit(bad) }' "$tmp/stats" || refuse
(ulimit -f 256; git --no-pager diff --cached --no-ext-diff --no-textconv "$base" -- > "$tmp/working") || refuse
{ printf 'Staged and committed changes:\\n'; cat "$tmp/staged"; printf '\\nWorking tree including untracked files:\\n'; cat "$tmp/working"; } > "$tmp/diff"
size=$(wc -c < "$tmp/diff" | tr -d ' ')
[ "$size" -le ${REVIEW_DIFF_MAX_BYTES} ] || refuse
printf 'GOAT_REVIEW_DIFF_OK %s\\n' "$size"
cat "$tmp/diff"
printf '\\nGOAT_REVIEW_DIFF_END\\n'
`;

/** The length and end marker reject output truncated by a remote transport. */
export function parseReviewDiff(output: string): string | undefined {
  const header = /^GOAT_REVIEW_DIFF_OK ([0-9]+)\n/u.exec(output);
  if (header === null || !output.endsWith(END)) return undefined;
  const diff = output.slice(header[0].length, -END.length);
  const bytes = new TextEncoder().encode(diff).length;
  return bytes === Number(header[1]) && bytes <= REVIEW_DIFF_MAX_BYTES ? diff : undefined;
}
