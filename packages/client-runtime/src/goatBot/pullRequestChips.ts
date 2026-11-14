import type { BotRowPullRequest } from "@goat/contracts";

export interface GoatBotRowPullRequestChip {
  readonly key: string;
  readonly number: number;
  readonly state: "open" | "merged" | "closed" | "unknown";
  /** "#42", or "goat#42" when the row's pull requests span repositories. */
  readonly text: string;
  readonly stateLabel: "Open" | "Merged" | "Closed" | "State unknown";
  readonly accessibleName: string;
}

const STATE_LABEL = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  unknown: "State unknown",
} as const;

/**
 * A work row's pull request chips, the first `visible` in the server's order, and how many more
 * the task has. A missing state was never read or is no longer refreshed: it reads "state unknown".
 */
export function goatBotRowPullRequests(
  row: {
    readonly pullRequests?: ReadonlyArray<BotRowPullRequest>;
    readonly pullRequestsOmitted?: number;
  },
  visible: number,
): {
  readonly chips: ReadonlyArray<GoatBotRowPullRequestChip>;
  readonly more: number;
  readonly moreLabel: string | null;
} {
  const pullRequests = row.pullRequests ?? [];
  const spansRepositories = new Set(pullRequests.map((item) => item.repository)).size > 1;
  const chips = pullRequests
    .slice(0, Math.max(0, visible))
    .map((item): GoatBotRowPullRequestChip => {
      const state = item.state ?? "unknown";
      const shortName = item.repository.slice(item.repository.lastIndexOf("/") + 1);
      return {
        key: `${item.repository}#${item.number}`,
        number: item.number,
        state,
        text: `${spansRepositories ? shortName : ""}#${item.number}`,
        stateLabel: STATE_LABEL[state],
        accessibleName: `Pull request ${item.repository}#${item.number}, ${STATE_LABEL[state].toLowerCase()}`,
      };
    });
  const more = pullRequests.length - chips.length + (row.pullRequestsOmitted ?? 0);
  return { chips, more, moreLabel: more > 0 ? `+${more} more` : null };
}
