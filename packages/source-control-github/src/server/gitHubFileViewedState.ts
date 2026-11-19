import type { PullRequestFileViewedState } from "@goat/contracts";

export function toFileViewedState(raw: string): PullRequestFileViewedState {
  switch (raw.trim().toUpperCase()) {
    case "VIEWED":
      return "viewed";
    case "DISMISSED":
      return "dismissed";
    default:
      return "unviewed";
  }
}
