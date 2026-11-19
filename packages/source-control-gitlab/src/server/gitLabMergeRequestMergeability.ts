import type * as Schema from "effect/Schema";
import type { PullRequestMergeability } from "@goat/contracts";
import type { RawMergeRequestSchema } from "./gitLabMergeRequestJson.ts";

export function toMergeability(
  raw: Pick<Schema.Schema.Type<typeof RawMergeRequestSchema>, "has_conflicts" | "merge_status">,
): PullRequestMergeability {
  if (raw.has_conflicts === true) return "conflicting";
  switch (raw.merge_status?.trim().toLowerCase()) {
    case "can_be_merged":
      return "mergeable";
    case "cannot_be_merged":
      return "conflicting";
    default:
      return "unknown";
  }
}

export function rebaseRequiredFromStatus(status: string | null | undefined): boolean | undefined {
  const normalized = status?.trim().toLowerCase();
  return normalized === "need_rebase" ? true : normalized === "mergeable" ? false : undefined;
}
