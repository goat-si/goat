import type { PullRequestDiffResult } from "@goat/contracts";

// Each holder stays within this UTF-16 patch budget as well as its entry-count bound.
const DIFF_CACHE_PATCH_BUDGET_BYTES = 32 * 1024 * 1024;
export const canCacheDiff = (value: PullRequestDiffResult) =>
  value.patch.length * 2 <= DIFF_CACHE_PATCH_BUDGET_BYTES;
export const diffCacheEvictions = (entries: Iterable<readonly [string, PullRequestDiffResult]>) => {
  let bytes = 0;
  const evictions: string[] = [];
  for (const [key, value] of Array.from(entries).toReversed()) {
    const size = value.patch.length * 2;
    if (bytes + size > DIFF_CACHE_PATCH_BUDGET_BYTES) {
      evictions.push(key);
    } else {
      bytes += size;
    }
  }
  return evictions;
};

export function decodeDiffCacheKey(key: string) {
  return JSON.parse(key) as [string, string | null, string | null, string | null, string | null];
}
