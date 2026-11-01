import {
  GitMergeIcon,
  GitPullRequestArrowIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  LayersIcon,
  LinkIcon as Link2Icon,
  UnlinkIcon as Unlink2Icon,
  TriangleAlertIcon,
} from "~/components/solar";
import type { PullRequestState } from "@goat/contracts";

export const PullRequestGlyph = {
  pullRequest: GitPullRequestArrowIcon,
  reopen: GitPullRequestArrowIcon,
  draft: GitPullRequestDraftIcon,
  closed: GitPullRequestClosedIcon,
  merged: GitMergeIcon,
  conflicting: TriangleAlertIcon,
  stack: LayersIcon,
  link: Link2Icon,
  unlink: Unlink2Icon,
} as const;

export type PullRequestGlyphIcon = (typeof PullRequestGlyph)[keyof typeof PullRequestGlyph];

export interface PullRequestStatePresentation {
  readonly label: string;
  readonly toneClassName: string;
  readonly Icon: PullRequestGlyphIcon;
}

export const PULL_REQUEST_STATE_PRESENTATION = {
  open: {
    label: "Open",
    toneClassName: "text-pr-open",
    Icon: PullRequestGlyph.pullRequest,
  },
  draft: {
    label: "Draft",
    toneClassName: "text-muted-foreground",
    Icon: PullRequestGlyph.draft,
  },
  closed: {
    label: "Closed",
    toneClassName: "text-pr-closed",
    Icon: PullRequestGlyph.closed,
  },
  merged: {
    label: "Merged",
    toneClassName: "text-pr-merged",
    Icon: PullRequestGlyph.merged,
  },
} as const satisfies Record<PullRequestState | "draft", PullRequestStatePresentation>;
