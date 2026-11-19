import type { PullRequestChangeBreakdown } from "@goat/contracts";
import { summarizeChangedFiles } from "@goat/shared/changedFileKind";
import type { ProviderFileStats } from "@goat/source-control-core/server/PullRequestProvider";

export function toChangeBreakdown(stats: ProviderFileStats): PullRequestChangeBreakdown {
  if (stats.truncated) return null;
  return summarizeChangedFiles(stats.files);
}
