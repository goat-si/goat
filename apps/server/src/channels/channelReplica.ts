import * as NodeBuffer from "node:buffer";

import { shellSingleQuote as quote } from "../sshRemote/remoteBrowse.ts";

export const DEFAULT_MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_UNTRACKED_FILE_BYTES = 2 * 1024 * 1024;

const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/u;
const safeTaskId = (taskId: string) => taskId.replace(/[^A-Za-z0-9_-]/gu, "_") || "task";
const safeGeneration = (generation: number) => {
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError("Replica generation must be a non-negative safe integer.");
  }
  return String(generation);
};

export const replicaRefFor = (taskId: string, generation: number) =>
  `refs/goat/replicas/${safeTaskId(taskId)}/${safeGeneration(generation)}`;

export const resumeBranchFor = (taskId: string, generation: number) =>
  `goat/replica/${safeTaskId(taskId)}-${safeGeneration(generation)}`;

function shellInput(value: string): string {
  if (value.includes("\0")) throw new TypeError("Shell input cannot contain NUL.");
  return quote(value);
}

function byteLimit(value: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Replica byte limits must be non-negative safe integers.");
  }
  return quote(String(value));
}

// xargs -0 works on macOS and Linux; unlike read -d, it does not require bash.
// Keep the candidate on disk because xargs may split worktree records across batches.
const selectWorktree = String.raw`set -eu
tmp=$1
branch=$2
shift 2
for field do
  case "$field" in
    'worktree '*) printf '%s' "${"${"}field#worktree }" > "$tmp/candidate" ;;
    "branch refs/heads/$branch") cp "$tmp/candidate" "$tmp/worktree" ;;
  esac
done`;

const selectUntracked = String.raw`set -eu
tmp=$1
limit=$2
shift 2
for file do
  excluded=0
  # Shell equivalent of the private secretName regex in sshRemote/SshWorkspaceSync.ts.
  case "${"${"}file##*/}" in
    .env|.env.*|*.pem|*.key|*.p12|id_rsa*|id_ed25519*) excluded=1 ;;
  esac
  if [ "$excluded" -eq 0 ]; then
    if [ -L "$file" ]; then
      size=0
    elif [ -f "$file" ]; then
      size=$(wc -c < "$file")
    else
      # Do not read a FIFO/device or accidentally add a nested repository.
      excluded=1
      size=0
    fi
    if [ "$size" -gt "$limit" ]; then excluded=1; fi
  fi
  if [ "$excluded" -eq 1 ]; then
    printf '%s\000' "$file" >> "$tmp/excluded"
  else
    printf '%s\000' "$file" >> "$tmp/included"
  fi
done`;

/** Produces a snapshot without checking out a branch or writing the worker's real index. */
export function captureReplicaScript(input: {
  readonly cwd: string;
  readonly branch?: string;
  readonly replicaRef: string;
  readonly maxBundleBytes: number;
  readonly maxUntrackedFileBytes: number;
  /** Ordinary watches export the immutable completed checkpoint, never the later live tree. */
  readonly checkpointRef?: string;
  readonly expectedCheckpointOid?: string;
}): string {
  return String.raw`set -eu
umask 077
cwd=${shellInput(input.cwd)}
branch=${shellInput(input.branch ?? "")}
replica_ref=${shellInput(input.replicaRef)}
max_bundle=${byteLimit(input.maxBundleBytes)}
max_untracked=${byteLimit(input.maxUntrackedFileBytes)}
checkpoint_ref=${shellInput(input.checkpointRef ?? "")}
case "$replica_ref" in refs/goat/replicas/*) ;; *) exit 1 ;; esac
git check-ref-format "$replica_ref"
if [ -n "$branch" ]; then git check-ref-format "refs/heads/$branch"; fi
cd "$cwd"
unset GIT_INDEX_FILE
export GIT_OPTIONAL_LOCKS=0
tmp=$(mktemp -d "${"${"}TMPDIR:-/tmp}/goat-replica.XXXXXX")
trap 'if [ -n "$checkpoint_ref" ] && [ -n "${"${"}commit:-}" ]; then git -c core.hooksPath=/dev/null update-ref -d "$replica_ref" "$commit" >/dev/null 2>&1 || true; fi; rm -rf "$tmp"' 0
trap 'exit 1' HUP INT TERM
if [ -n "$branch" ]; then
  git worktree list --porcelain -z > "$tmp/worktrees"
  xargs -0 sh -c ${quote(selectWorktree)} sh "$tmp" "$branch" < "$tmp/worktrees"
else
  printf '%s' "$cwd" > "$tmp/worktree"
fi
if [ ! -f "$tmp/worktree" ]; then
  if [ "$(git symbolic-ref --quiet HEAD || true)" = "refs/heads/$branch" ]; then
    printf '%s' "$cwd" > "$tmp/worktree"
  else
    printf 'GOAT_REPLICA_NO_WORKTREE\n'
    exit 0
  fi
fi
# The sentinel preserves trailing newlines in a worktree path.
worktree=$(cat "$tmp/worktree"; printf '.')
worktree=${"${"}worktree%.}
cd "$worktree"
if [ -n "$checkpoint_ref" ]; then
  case "$checkpoint_ref" in refs/goat/checkpoints/*|refs/t3/checkpoints/*|refs/goat/orchestration-v2/checkpoints/*|refs/t3/orchestration-v2/checkpoints/*) ;; *) exit 1 ;; esac
  git check-ref-format "$checkpoint_ref"
  commit=$(git rev-parse --verify "$checkpoint_ref^{commit}")
  if [ "$commit" != ${shellInput(input.expectedCheckpointOid ?? "")} ]; then
    printf 'GOAT_REPLICA_CHECKPOINT_IDENTITY_MISMATCH\n'
    exit 0
  fi
  head=$(git rev-parse --verify "$commit^1")
  : > "$tmp/excluded"
  git diff-tree --no-commit-id --name-only -r -z --diff-filter=A "$head" "$commit" > "$tmp/added"
  xargs -0 sh -c ${quote(String.raw`set -eu
tmp=$1
limit=$2
commit=$3
shift 3
for file do
  excluded=0
  case "${"${"}file##*/}" in .env|.env.*|*.pem|*.key|*.p12|id_rsa*|id_ed25519*) excluded=1 ;; esac
  size=$(git cat-file -s "$commit:$file")
  if [ "$size" -gt "$limit" ]; then excluded=1; fi
  if [ "$excluded" -eq 1 ]; then printf '%s\000' "$file" >> "$tmp/excluded"; fi
done`)} sh "$tmp" "$max_untracked" "$commit" < "$tmp/added"
if [ -s "$tmp/excluded" ]; then
  printf 'GOAT_REPLICA_EXCLUDED_FILES\n'
  exit 0
fi
else
head=$(git rev-parse --verify HEAD)
index=$(git rev-parse --git-path index)
if [ -f "$index" ]; then cp "$index" "$tmp/index"; fi
export GIT_INDEX_FILE="$tmp/index"
export GIT_LITERAL_PATHSPECS=1
if [ ! -f "$tmp/index" ]; then git read-tree "$head"; fi
git -c core.splitIndex=false add -u -- .
: > "$tmp/excluded"
: > "$tmp/included"
git ls-files -o --exclude-standard -z > "$tmp/untracked"
xargs -0 sh -c ${quote(selectUntracked)} sh "$tmp" "$max_untracked" < "$tmp/untracked"
if [ -s "$tmp/included" ]; then
  git -c core.splitIndex=false add --pathspec-from-file="$tmp/included" --pathspec-file-nul
fi
# New files the worker staged itself get the same rule; only the copy's index loses them.
mkdir "$tmp/staged"
: > "$tmp/staged/excluded"
: > "$tmp/staged/included"
git diff --cached --name-only --diff-filter=A -z "$head" > "$tmp/added"
xargs -0 sh -c ${quote(selectUntracked)} sh "$tmp/staged" "$max_untracked" < "$tmp/added"
if [ -s "$tmp/staged/excluded" ]; then
  git rm --cached --quiet --pathspec-from-file="$tmp/staged/excluded" --pathspec-file-nul
  cat "$tmp/staged/excluded" >> "$tmp/excluded"
fi
tree=$(git write-tree)
export GIT_AUTHOR_NAME='GOAT Replica' GIT_COMMITTER_NAME='GOAT Replica'
export GIT_AUTHOR_EMAIL='replica@goat.invalid' GIT_COMMITTER_EMAIL='replica@goat.invalid'
# Stable metadata makes retries of an unchanged tree produce the same commit.
export GIT_AUTHOR_DATE='2000-01-01T00:00:00Z' GIT_COMMITTER_DATE='2000-01-01T00:00:00Z'
commit=$(printf 'GOAT channel replica\n' | git -c commit.gpgSign=false commit-tree "$tree" -p "$head")
fi
git -c core.hooksPath=/dev/null update-ref --no-deref "$replica_ref" "$commit"
if ! git bundle create "$tmp/bundle" "$replica_ref" --not --remotes 2> "$tmp/bundle-error"; then
  if [ -n "$(git rev-list -1 "$replica_ref" --not --remotes)" ]; then
    cat "$tmp/bundle-error" >&2
    exit 1
  fi
  # Git refuses an empty incremental bundle. A full bundle still obeys the size cap.
  git bundle create "$tmp/bundle" "$replica_ref"
fi
bytes=$(wc -c < "$tmp/bundle" | tr -d '[:space:]')
if [ "$bytes" -gt "$max_bundle" ]; then
  printf 'GOAT_REPLICA_TOO_LARGE %s\n' "$bytes"
  exit 0
fi
printf 'GOAT_REPLICA_OK\nHEAD %s\nCOMMIT %s\nBYTES %s\nEXCLUDED ' "$head" "$commit" "$bytes"
# One base64-encoded NUL list preserves every excluded filename, including newlines.
base64 < "$tmp/excluded" | tr -d '\r\n'
printf '\nGOAT_REPLICA_BUNDLE_BEGIN\n'
base64 < "$tmp/bundle"
printf '\nGOAT_REPLICA_BUNDLE_END\n'
`;
}

export type ReplicaOutput =
  | {
      readonly type: "ok";
      readonly headOid: string;
      readonly commitOid: string;
      readonly bytes: number;
      readonly excluded: string[];
      readonly bundleBase64: string;
    }
  | { readonly type: "too_large"; readonly bytes: number }
  | { readonly type: "no_worktree" }
  | { readonly type: "excluded_files" }
  | { readonly type: "checkpoint_identity_mismatch" }
  | { readonly type: "invalid" };

function decodeBase64(value: string): NodeBuffer.Buffer | null {
  if (value.length % 4 !== 0 || !base64Pattern.test(value)) return null;
  const decoded = NodeBuffer.Buffer.from(value, "base64");
  // Buffer's decoder otherwise accepts invalid padding and non-canonical pad bits.
  return decoded.toString("base64") === value ? decoded : null;
}

function parseBytes(value: string): number | null {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return null;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) ? bytes : null;
}

export function parseReplicaOutput(stdout: string): ReplicaOutput {
  const output = stdout.replaceAll("\r\n", "\n").replace(/\n$/u, "");
  if (output === "GOAT_REPLICA_EXCLUDED_FILES") return { type: "excluded_files" };
  if (output === "GOAT_REPLICA_CHECKPOINT_IDENTITY_MISMATCH")
    return { type: "checkpoint_identity_mismatch" };
  if (output === "GOAT_REPLICA_NO_WORKTREE") return { type: "no_worktree" };
  const tooLarge = /^GOAT_REPLICA_TOO_LARGE (\d+)$/u.exec(output);
  if (tooLarge) {
    const bytes = parseBytes(tooLarge[1]!);
    return bytes === null ? { type: "invalid" } : { type: "too_large", bytes };
  }
  const match =
    /^GOAT_REPLICA_OK\nHEAD ([^\n]+)\nCOMMIT ([^\n]+)\nBYTES ([^\n]+)\nEXCLUDED ([^\n]*)\nGOAT_REPLICA_BUNDLE_BEGIN\n([A-Za-z0-9+/=\n]+)\nGOAT_REPLICA_BUNDLE_END$/u.exec(
      output,
    );
  if (!match) return { type: "invalid" };
  const [, headOid = "", commitOid = "", byteText = "", excludedText = "", encoded = ""] = match;
  const bytes = parseBytes(byteText);
  const bundleBase64 = encoded.replaceAll("\n", "");
  const bundle = decodeBase64(bundleBase64);
  const excludedBytes = decodeBase64(excludedText);
  if (
    !oidPattern.test(headOid) ||
    !oidPattern.test(commitOid) ||
    headOid.length !== commitOid.length ||
    bytes === null ||
    bytes === 0 ||
    bundle === null ||
    bundle.length !== bytes ||
    excludedBytes === null
  ) {
    return { type: "invalid" };
  }
  const excludedNames = excludedBytes.toString("utf8");
  if (
    !NodeBuffer.Buffer.from(excludedNames).equals(excludedBytes) ||
    (excludedNames.length > 0 && !excludedNames.endsWith("\0"))
  ) {
    return { type: "invalid" };
  }
  const excluded = excludedNames.length === 0 ? [] : excludedNames.slice(0, -1).split("\0");
  if (excluded.includes("")) return { type: "invalid" };
  return { type: "ok", headOid, commitOid, bytes, excluded, bundleBase64 };
}

/** Imports objects, then creates the resume ref with an atomic create-only update. */
export function applyReplicaScript(input: {
  readonly cwd: string;
  readonly bundleBase64: string;
  readonly replicaRef: string;
  readonly targetRef: string;
  readonly fetchRemotes?: boolean;
  readonly expectedCommitOid?: string;
  readonly expectedHeadOid?: string;
}): string {
  const bundleBase64 = input.bundleBase64.replace(/\r?\n/gu, "");
  if (bundleBase64.length === 0 || decodeBase64(bundleBase64) === null) {
    throw new TypeError("Replica bundle must be canonical base64.");
  }
  return String.raw`set -eu
umask 077
cwd=${shellInput(input.cwd)}
replica_ref=${shellInput(input.replicaRef)}
target_ref=${shellInput(input.targetRef)}
case "$replica_ref" in refs/goat/replicas/*) ;; *) exit 1 ;; esac
case "$target_ref" in refs/heads/*) ;; *) exit 1 ;; esac
git check-ref-format "$replica_ref"
git check-ref-format "$target_ref"
cd "$cwd"
tmp=$(mktemp -d "${"${"}TMPDIR:-/tmp}/goat-replica.XXXXXX")
trap 'rm -rf "$tmp"' 0
trap 'exit 1' HUP INT TERM
${input.fetchRemotes === false ? "" : "git fetch --quiet --all >&2 || true"}
cat > "$tmp/base64" <<'GOAT_REPLICA_DATA'
${bundleBase64}
GOAT_REPLICA_DATA
if ! base64 -d < "$tmp/base64" > "$tmp/bundle" 2>/dev/null; then
  base64 -D < "$tmp/base64" > "$tmp/bundle"
fi
if ! LC_ALL=C git bundle verify "$tmp/bundle" > "$tmp/verify" 2>&1; then
  printf 'GOAT_REPLICA_BASE_MISSING\n'
  # Git prefixes each line with "error: "; the missing commits follow the "lacks" line.
  awk '{ sub(/^(error|fatal): /, "") } /lacks these prerequisite/ { p = 1; next } p && $1 ~ /^[0-9a-f]+$/ && (length($1) == 40 || length($1) == 64) { print $1 }' "$tmp/verify"
  exit 0
fi
oid=$(git bundle list-heads "$tmp/bundle" "$replica_ref" | awk '{print $1}')
case "$oid" in ''|*[!0-9a-f]*) exit 1 ;; esac
case ${"${"}#oid} in 40|64) ;; *) exit 1 ;; esac
${input.expectedCommitOid === undefined ? "" : `if [ "$oid" != ${shellInput(input.expectedCommitOid)} ]; then printf 'GOAT_REPLICA_IDENTITY_MISMATCH\\n'; exit 0; fi`}
existing=$(git rev-parse --verify "$target_ref" 2>/dev/null || true)
if [ -n "$existing" ] && [ "$existing" != "$oid" ]; then
  printf 'GOAT_REPLICA_REF_CONFLICT\n'
  exit 0
fi
if [ -z "$existing" ]; then
  # Fetching directly into target_ref could fast-forward an existing ref after a race.
  git fetch --quiet --no-tags --no-write-fetch-head "$tmp/bundle" "$replica_ref"
fi
${input.expectedHeadOid === undefined ? "" : `if [ "$(git rev-parse --verify "$oid^1")" != ${shellInput(input.expectedHeadOid)} ]; then printf 'GOAT_REPLICA_IDENTITY_MISMATCH\\n'; exit 0; fi`}
if [ -z "$existing" ]; then
  if ! git update-ref --no-deref "$target_ref" "$oid" '' 2>/dev/null; then
    if [ "$(git rev-parse --verify "$target_ref" 2>/dev/null || true)" != "$oid" ]; then
      printf 'GOAT_REPLICA_REF_CONFLICT\n'
      exit 0
    fi
  fi
fi
printf 'GOAT_REPLICA_APPLIED %s\n' "$oid"
`;
}

export type ApplyOutput =
  | { readonly type: "applied"; readonly oid: string }
  | { readonly type: "base_missing"; readonly missing: string[] }
  | { readonly type: "ref_conflict" }
  | { readonly type: "invalid" };

export function parseApplyOutput(stdout: string): ApplyOutput {
  const output = stdout.replaceAll("\r\n", "\n").replace(/\n$/u, "");
  if (output === "GOAT_REPLICA_REF_CONFLICT") return { type: "ref_conflict" };
  if (output === "GOAT_REPLICA_BASE_MISSING") return { type: "base_missing", missing: [] };
  if (output.startsWith("GOAT_REPLICA_BASE_MISSING\n")) {
    const missing = output.split("\n").slice(1);
    return missing.every((oid) => oidPattern.test(oid))
      ? { type: "base_missing", missing }
      : { type: "invalid" };
  }
  const applied = /^GOAT_REPLICA_APPLIED ([^\n]+)$/u.exec(output);
  return applied && oidPattern.test(applied[1]!)
    ? { type: "applied", oid: applied[1]! }
    : { type: "invalid" };
}
